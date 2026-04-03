# Chapter 6: Context Compression

## The problem

A 50-turn conversation with an AI coding agent can easily reach 200,000 tokens. Every file read dumps thousands of tokens into the history. Every tool result stays there forever. And every API call sends the entire history.

At some point, you hit the context window limit and the API call fails. Before that, you are paying for all those old tokens on every single call.

You need a way to shrink the conversation without losing the important parts.

## The compression pipeline

Production agents do not use a single compression strategy. They use layers, from cheapest to most expensive:

```mermaid
flowchart LR
    A[Messages] --> B[Layer 1:\nTruncate large results]
    B --> C[Layer 2:\nClear old results]
    C --> D[Layer 3:\nSummarize conversation]
    D --> E[Send to API]
```

Each layer runs before every API call. They are ordered by cost:

- **Cheap** means it just manipulates strings in memory. No API calls, no extra tokens, runs in milliseconds. Truncating a string or replacing old text with "[cleared]" is cheap.
- **Expensive** means it makes an additional API call to the LLM, which costs tokens and takes seconds. Asking the model to summarize the conversation is expensive.

Cheap layers run first and handle most cases. Expensive layers only fire when the cheap ones are not enough.

## Layer 1: Truncate large tool results

The cheapest compression. Some tool results are huge. Reading a 5,000-line file dumps all of it into the conversation. But the model usually only needs the first part (for understanding the structure) or a specific section (for making an edit).

The fix: cap tool results at a character limit. If a result exceeds the limit, keep the first chunk and add a note that it was truncated.

```typescript
const MAX_RESULT_CHARS = 10_000;

function truncateResult(result: string): string {
  if (result.length <= MAX_RESULT_CHARS) {
    return result;
  }
  const truncated = result.slice(0, MAX_RESULT_CHARS);
  return (
    truncated +
    `\n\n[Truncated: result was ${result.length} characters. ` +
    `Showing first ${MAX_RESULT_CHARS}.]`
  );
}
```

You call this in the agentic loop, right where tool results are collected before pushing them into the conversation:

```typescript
// In the agentic loop, after executing a tool:
const result = await tool.call(parsed.data);
const truncatedResult = truncateResult(result);  // <-- apply before storing

toolResults.push({
  type: "tool_result",
  tool_use_id: toolUse.id,
  content: truncatedResult,
});
```

Here is what this looks like in practice. The model reads a large file:

```
Before truncation (25,000 characters):
┌─────────────────────────────────────┐
│ 1   import express from "express";  │
│ 2   import cors from "cors";        │
│ 3   ...                             │
│ ... (500 more lines)                │
│ 502 export default app;             │
└─────────────────────────────────────┘

After truncation (10,000 characters):
┌─────────────────────────────────────┐
│ 1   import express from "express";  │
│ 2   import cors from "cors";        │
│ 3   ...                             │
│ ... (first ~200 lines)              │
│                                     │
│ [Truncated: result was 25,000       │
│  characters. Showing first 10,000.] │
└─────────────────────────────────────┘
```

The model sees enough of the file to understand its structure (imports, exports, main patterns) without the full 500 lines eating up context. If it needs a specific section later, it can read the file again with an offset.

**When it fires:** Every turn, on every tool result.

**What it costs:** Nothing. Just string slicing.

## Layer 2: Clear old tool results

Tool results from 20 turns ago are rarely useful. The model read a file, used the information, and moved on. Keeping the full file contents in the conversation is waste.

The fix: replace old tool results with a short stub.

```typescript
const KEEP_RECENT = 6; // Keep the last N tool results intact

function clearOldResults(
  messages: Anthropic.MessageParam[]
): Anthropic.MessageParam[] {
  // Find all tool result messages and their positions
  const toolResultPositions: number[] = [];
  messages.forEach((msg, i) => {
    if (typeof msg.content !== "string" && Array.isArray(msg.content)) {
      const hasToolResult = msg.content.some(
        (block: any) => block.type === "tool_result"
      );
      if (hasToolResult) toolResultPositions.push(i);
    }
  });

  // Keep the most recent ones, clear the rest
  const toClear = toolResultPositions.slice(0, -KEEP_RECENT);

  return messages.map((msg, i) => {
    if (!toClear.includes(i)) return msg;

    // Replace tool result content with a stub
    const content = (msg.content as any[]).map((block: any) => {
      if (block.type === "tool_result") {
        return {
          ...block,
          content: "[Previous tool result cleared to save context]",
        };
      }
      return block;
    });

    return { ...msg, content };
  });
}
```

Here is what this looks like. Say the conversation has 10 tool results and we keep the last 6:

```
Before clearing:
┌─────────────────────────────────────────────────────────────┐
│ [tool_result] list_files    → "src/App.tsx\nsrc/Button..."  │ ← old, clear
│ [tool_result] read_file     → "1  import React...(800 lines)"│ ← old, clear
│ [tool_result] read_file     → "1  export function...(200 l)"│ ← old, clear
│ [tool_result] search_files  → "src/App.tsx:3: import..."    │ ← old, clear
│ [tool_result] edit_file     → "Edited src/App.tsx"          │ ← keep (recent 6)
│ [tool_result] read_file     → "1  import express...(500 l)" │ ← keep
│ [tool_result] search_files  → "src/routes.ts:12: app.get..."│ ← keep
│ [tool_result] read_file     → "1  const router...(300 l)"  │ ← keep
│ [tool_result] edit_file     → "Edited src/routes.ts"        │ ← keep
│ [tool_result] run_command   → "Tests passed"                │ ← keep
└─────────────────────────────────────────────────────────────┘

After clearing:
┌─────────────────────────────────────────────────────────────┐
│ [tool_result] list_files    → "[Cleared]"                   │ ← was 500 chars
│ [tool_result] read_file     → "[Cleared]"                   │ ← was 20,000 chars
│ [tool_result] read_file     → "[Cleared]"                   │ ← was 5,000 chars
│ [tool_result] search_files  → "[Cleared]"                   │ ← was 2,000 chars
│ [tool_result] edit_file     → "Edited src/App.tsx"          │ ← unchanged
│ [tool_result] read_file     → "1  import express...(500 l)" │ ← unchanged
│ ... (rest unchanged)                                        │
└─────────────────────────────────────────────────────────────┘
```

The old file contents (27,500 characters) are gone. But the tool calls in the assistant messages still say "I called read_file on src/App.tsx." The model can see *what* it did, just not the full result. If it needs that file again, it can re-read it.

This is more aggressive than truncation. Old tool results are completely replaced.

**When it fires:** Every turn, before sending to the API.

**What it costs:** Nothing. Just message rewriting.

## Layer 3: Summarize the conversation (autocompact)

When the conversation is still too long after layers 1 and 2, you need the big gun: ask the model to summarize the conversation.

This works by making a separate API call with the current conversation and a prompt like "summarize what has happened so far." Then you replace all the old messages with that summary.

```typescript
const CONTEXT_WINDOW = 200_000; // Model's context limit in tokens
const COMPACT_THRESHOLD = 0.8;  // Compact when we hit 80% of the limit

async function autoCompact(
  messages: Anthropic.MessageParam[],
  tokenEstimate: number
): Promise<{
  messages: Anthropic.MessageParam[];
  wasCompacted: boolean;
}> {
  // Only compact if we are approaching the limit
  if (tokenEstimate < CONTEXT_WINDOW * COMPACT_THRESHOLD) {
    return { messages, wasCompacted: false };
  }

  console.log("  [compact] Context is large, summarizing conversation...");

  // Ask the model to summarize
  const summaryResponse = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    system:
      "Summarize this conversation between a user and a coding assistant. " +
      "Preserve: file paths mentioned, code changes made, current task state, " +
      "and any decisions or preferences expressed. Be concise but complete.",
    messages: messages,
  });

  const summaryText = summaryResponse.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  // Replace old messages with the summary
  // Keep the most recent messages intact (they are likely still relevant)
  const keepRecent = 4;
  const recentMessages = messages.slice(-keepRecent);

  const compactedMessages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        `[Conversation summary]\n${summaryText}\n\n` +
        `[The conversation continues from here.]`,
    },
    {
      role: "assistant",
      content: "I understand the context. I will continue from where we left off.",
    },
    ...recentMessages,
  ];

  return { messages: compactedMessages, wasCompacted: true };
}
```

After compaction, the conversation looks like:

```
[user]:      "[Conversation summary] The user asked to build a login page.
              I read src/pages/LoginPage.tsx and src/auth/useAuth.ts.
              I edited LoginPage.tsx to add a form. The current task is..."
[assistant]: "I understand the context."
[user]:      (recent message 1)
[assistant]: (recent message 2)
[user]:      (most recent message)
```

The old messages are gone. Replaced by a summary that preserves the important facts: what files were touched, what changes were made, and what the current task is.

**When it fires:** Only when the token count exceeds the threshold (80% of context window).

**What it costs:** One extra API call for the summarization. This is the expensive option, which is why we use cheaper layers first.

## The compact boundary

After compaction, the messages array has a summary at the front and recent messages at the back. But the conversation keeps going. New messages pile up. Eventually you need to compact again.

The question is: which messages do you summarize the second time? You do not want to re-summarize the summary. That would lose information with each cycle (a summary of a summary of a summary gets worse every time).

The "compact boundary" is a marker that says "everything before this point is already summarized." When it is time to compact again, you only summarize messages after the boundary.

Here is what the messages array looks like over time:

```
After first compaction:
┌──────────────────────────────────────────────────┐
│ [summary of turns 1-20]          ← boundary here │
│ [assistant] "I understand."                      │
│ [user] "Now add a delete button"                 │
│ [assistant] [tool] read_file(...)                │
│ [tool_result] (file contents)                    │
│ [assistant] [tool] edit_file(...)                │
│ [tool_result] "Edited"                           │
│ ... 15 more turns ...                            │
└──────────────────────────────────────────────────┘

After second compaction:
┌──────────────────────────────────────────────────┐
│ [summary of turns 1-20]                          │
│ [summary of turns 21-35]         ← boundary here │
│ [assistant] "I understand."                      │
│ [user] "One more thing..."                       │
│ ... recent turns ...                             │
└──────────────────────────────────────────────────┘
```

The first summary stays untouched. The second compaction only summarized the new turns (21-35). This way, information degrades gracefully instead of collapsing into a single increasingly lossy summary.

In code:

```typescript
// Track where the last compaction ended
let compactBoundaryIndex = 0;

// After compaction:
compactBoundaryIndex = 2; // Summary + "I understand" message

// Next time we compact, only summarize messages after the boundary
const messagesToSummarize = messages.slice(compactBoundaryIndex);
```

## Putting it all together

The compression pipeline runs before every API call:

```typescript
async function compressMessages(
  messages: Anthropic.MessageParam[]
): Promise<Anthropic.MessageParam[]> {
  // Layer 1: Truncation already happened when results were created

  // Layer 2: Clear old tool results
  let compressed = clearOldResults(messages);

  // Layer 3: Autocompact if still too large
  const tokenEstimate = estimateTokens(compressed);
  const { messages: compacted } = await autoCompact(compressed, tokenEstimate);

  return compacted;
}

// In the agentic loop:
while (true) {
  const compressed = await compressMessages(conversationHistory);
  const response = await client.messages.create({
    // ...
    messages: compressed,
  });
  // ...
}
```

Notice that we compress a copy of the messages. The original `conversationHistory` stays intact. We only compress when preparing the API call. This way, if we need to re-compress differently later, we still have the full history.

In practice, production agents do modify the conversation in place after compaction. Once a summary replaces old messages, the originals are gone. This saves memory but means you cannot undo it.

## How much does each layer save?

| Layer | Tokens saved | Cost | When it fires |
|---|---|---|---|
| Truncate results | 10-50% per large result | Free | Every tool result |
| Clear old results | 30-60% of total context | Free | Every turn |
| Autocompact | 70-90% of total context | 1 extra API call | At 80% of limit |

Layer 1 prevents individual results from being too large. Layer 2 steadily shrinks the history as it grows. Layer 3 is the reset button when everything else is not enough.

## What is still missing

Our agent runs anything the model asks it to. `rm -rf /`? Sure. `git push --force`? Why not. In the next chapter, we add a permission system that asks the user before running dangerous operations.

## Running the example

```bash
npm run example:06
```

Have a long conversation (10+ turns) and watch the `[context]` log. You will see the token count grow, then drop when compression kicks in. Try reading several large files to trigger the threshold faster.
