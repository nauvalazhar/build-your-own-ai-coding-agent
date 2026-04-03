# Chapter 5: Context

## The problem

The user has been working with the agent for a while. Five turns ago, the agent read `LoginPage.tsx`. Now the user says: "Change the heading to 30px."

Which heading? In which file? The user did not say. But both the user and the agent know the answer because they were just working on the login page.

How does the model know?

## What is context?

LLMs do not have memory. Every time you call the API, the model starts fresh. It does not remember the previous call. So how does a conversation work?

You send the entire conversation history on every call. All the previous user messages, all the assistant responses, all the tool calls and results. Everything. This is the **context**. It is just the messages array you pass to the API.

The model reads the whole context and generates a response as if it is seeing the entire conversation for the first time. It looks like the model "remembers," but it is actually re-reading the full conversation every turn.

The context has a size limit called the **context window**. For most models, this is 100,000 to 200,000 tokens. If your conversation grows beyond that, the API call fails. We will deal with that in the next chapter.

## Walkthrough: "Change the heading to 30px"

Here is a conversation that has been going on for a few turns:

```
Turn 1  [user]:    "Help me build a login page"
Turn 2  [assistant]: [tool] list_files(...)
Turn 3  [tool_result]: src/pages/LoginPage.tsx, src/components/Header.tsx...
Turn 4  [assistant]: [tool] read_file("src/pages/LoginPage.tsx")
Turn 5  [tool_result]: (full file contents with a <h1 className="text-2xl">)
Turn 6  [assistant]: "I see your login page. It has a heading, a form..."
Turn 7  [user]:    "Change the heading to 30px"
```

When the model processes turn 7, what does it see? It sees **everything**. Turns 1 through 7. The entire conversation. Including the full file contents from turn 5.

The model does not need to search again. It does not need to read the file again. It already has the file contents in its context. It knows:

- We are working on `LoginPage.tsx` (from the conversation flow)
- The heading currently uses `text-2xl` (from the file contents in turn 5)
- The user wants 30px (from turn 7)

So it does:

```
Turn 8  [assistant]: [tool] edit_file({
          file_path: "src/pages/LoginPage.tsx",
          old_string: "text-2xl",
          new_string: "text-[30px]"
        })
```

One tool call. No searching. No reading. The context carried everything forward.

## How it works: full conversation replay

Every time the agentic loop calls the API, it sends the **entire conversation history**:

```typescript
const response = await client.messages.create({
  model: "claude-sonnet-4-20250514",
  max_tokens: 4096,
  system: SYSTEM_PROMPT,
  tools: apiTools,
  messages: conversationHistory,  // <-- everything, every turn
});
```

The `conversationHistory` array contains every user message, every assistant response, every tool call, and every tool result. All of it. Every turn.

This means the model has full access to:

- What files it has read (and their contents)
- What edits it has made
- What commands it has run (and the output)
- What the user has said
- What it has said back

This is simple and correct. The model sees everything and can make decisions based on the full context.

## The message structure

Let's look at what a real conversation array looks like after a few turns:

```typescript
[
  // Turn 1: User message
  { role: "user", content: "Help me build a login page" },

  // Turn 2: Assistant calls a tool
  { role: "assistant", content: [
    { type: "text", text: "Let me look at the project structure." },
    { type: "tool_use", id: "toolu_1", name: "list_files", input: { directory: "src" } }
  ]},

  // Turn 3: Tool result
  { role: "user", content: [
    { type: "tool_result", tool_use_id: "toolu_1", content: "src/App.tsx\nsrc/pages/LoginPage.tsx\n..." }
  ]},

  // Turn 4: Assistant reads a file
  { role: "assistant", content: [
    { type: "tool_use", id: "toolu_2", name: "read_file", input: { file_path: "src/pages/LoginPage.tsx" } }
  ]},

  // Turn 5: File contents
  { role: "user", content: [
    { type: "tool_result", tool_use_id: "toolu_2", content: "1\timport React from 'react';\n2\t..." }
  ]},

  // Turn 6: Assistant text response
  { role: "assistant", content: [
    { type: "text", text: "I see your login page. It has a heading, a form..." }
  ]},

  // Turn 7: Follow-up user message
  { role: "user", content: "Change the heading to 30px" },
]
```

When the model sees turn 7, it has access to all the turns above. The file contents are right there in turn 5. That is why it can answer follow-up questions without re-reading files.

## The cost problem

There is a downside to sending everything. The conversation grows with every turn. And you pay for every token.

Consider a 10-turn conversation where the agent reads 5 files:

```
Turn 1:   User message                     ~20 tokens
Turn 2:   Tool call (list_files)           ~50 tokens
Turn 3:   Tool result (file list)          ~200 tokens
Turn 4:   Tool call (read_file)            ~50 tokens
Turn 5:   Tool result (file contents)      ~2,000 tokens
Turn 6:   Tool call (read_file)            ~50 tokens
Turn 7:   Tool result (file contents)      ~3,000 tokens
Turn 8:   Tool call (edit_file)            ~100 tokens
Turn 9:   Tool result (edit confirmation)  ~20 tokens
Turn 10:  Assistant text response          ~200 tokens
                                    Total: ~5,690 tokens
```

If you ran the earlier examples, you probably noticed the cost. Most of it comes from tool results being re-sent every turn. That is just one user interaction. On the next user message, we send all 5,690 tokens again, plus the new message. And again on the turn after that.

By turn 20, you might be sending 30,000 tokens per API call. By turn 50, you could be at 100,000+. Each file read adds thousands of tokens that stick around for the rest of the conversation.

This is not just a cost problem. There is also a hard limit: the model's context window. Once you exceed it, the API call fails.

## Message normalization

Before sending messages to the API, you should clean them up. Remove things the API does not need. Make sure the format is correct.

Basic normalization:

```typescript
function normalizeMessages(
  messages: Anthropic.MessageParam[]
): Anthropic.MessageParam[] {
  return messages.filter((msg) => {
    // Remove empty messages
    if (typeof msg.content === "string" && msg.content.trim() === "") {
      return false;
    }
    return true;
  });
}
```

In production agents, normalization is much more involved. It handles things like:

- Making sure every `tool_use` block has a matching `tool_result`
- Removing internal metadata that should not be sent to the API
- Merging consecutive messages from the same role
- Stripping UI-only messages

For now, basic filtering is enough. We will add more as we need it.

## What is still missing

The conversation grows without bound. Eventually it will exceed the context window and the API call will fail. We need a way to compress old messages without losing important information.

That is the topic of the next chapter: context compression.

## Running the example

```bash
npm run example:05
```

Try a multi-turn conversation:
1. "What files are in sample-project?" (the agent reads the file list)
2. "Read the Button component" (the agent reads the file)
3. "Change the color to red" (the agent already has the file in context, so it can edit directly)

Notice how step 3 does not require re-reading the file. The context carries forward.
