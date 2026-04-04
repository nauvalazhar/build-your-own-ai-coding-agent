# Chapter 9: Streaming

## The problem

Without streaming, the user sends a message and stares at a blank screen. The model might take 5-10 seconds to generate a response. If it calls a tool, the model needs to generate the full tool input before anything happens. Then the tool executes. Then the model generates more text. The user sees nothing until everything is done.

Streaming fixes this. Text appears character by character as the model generates it. The user knows the agent is working. They can start reading before the response is complete.

## How streaming works

Instead of `client.messages.create()` which returns the complete response, we use `client.messages.stream()` which returns events as they happen:

```typescript
const stream = client.messages.stream({
  model: "claude-sonnet-4-20250514",
  max_tokens: 4096,
  messages: conversationHistory,
  tools: apiTools,
});
```

The stream emits events in this order:

```mermaid
sequenceDiagram
    participant API
    participant Agent

    API->>Agent: message_start (conversation metadata)
    API->>Agent: content_block_start (text block begins)
    API->>Agent: content_block_delta (text: "The")
    API->>Agent: content_block_delta (text: " button")
    API->>Agent: content_block_delta (text: " component")
    API->>Agent: content_block_stop (text block done)
    API->>Agent: content_block_start (tool_use block begins)
    API->>Agent: content_block_delta (input_json: '{"file')
    API->>Agent: content_block_delta (input_json: '_path":')
    API->>Agent: content_block_delta (input_json: '"src/B')
    API->>Agent: content_block_delta (input_json: 'utton.tsx"}')
    API->>Agent: content_block_stop (tool_use block done)
    API->>Agent: message_delta (stop_reason)
    API->>Agent: message_stop
```

## The event types

| Event | What it means |
|---|---|
| `message_start` | The response is starting. Contains metadata. |
| `content_block_start` | A new content block is starting (text or tool_use). |
| `content_block_delta` | A chunk of content. For text: a few words. For tool input: a piece of JSON. |
| `content_block_stop` | The current content block is complete. |
| `message_delta` | Final metadata like `stop_reason` and token usage. |
| `message_stop` | The response is done. |

## Streaming text

Text deltas are simple. Each `content_block_delta` event with `type: "text_delta"` carries a small piece of text. Print it immediately:

```typescript
for await (const event of stream) {
  if (
    event.type === "content_block_delta" &&
    event.delta.type === "text_delta"
  ) {
    process.stdout.write(event.delta.text); // Print without newline
  }
}
```

The user sees text appearing word by word. This feels much faster than waiting for the complete response, even though the total time is the same.

## Streaming tool inputs

Tool inputs are trickier. The model generates the tool's JSON input incrementally. Each `input_json_delta` event carries a piece of the JSON string:

```
Delta 1: '{"file'
Delta 2: '_path":'
Delta 3: '"src/'
Delta 4: 'Button.tsx"}'
```

You cannot parse incomplete JSON. So you buffer the deltas and parse when the block is complete:

```typescript
let toolInputBuffer = "";

for await (const event of stream) {
  if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
    toolInputBuffer = "";  // Reset buffer for new tool
  }

  if (event.type === "content_block_delta" && event.delta.type === "input_json_delta") {
    toolInputBuffer += event.delta.partial_json;  // Buffer the pieces
  }

  if (event.type === "content_block_stop") {
    // Now we can parse the complete JSON
    const input = toolInputBuffer ? JSON.parse(toolInputBuffer) : {};
    // Execute the tool with the parsed input
  }
}
```

## Rewriting the loop for streaming

The agentic loop changes from `create()` to `stream()`. We need to accumulate the full response (for conversation history) while also streaming text to the user:

```typescript
async function agentLoop(messages: Anthropic.MessageParam[]): Promise<string> {
  while (true) {
    const stream = client.messages.stream({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: apiTools,
      messages,
    });

    // Accumulate the complete response for conversation history
    const contentBlocks: Anthropic.ContentBlock[] = [];
    let currentToolInput = "";
    let currentToolId = "";
    let currentToolName = "";

    for await (const event of stream) {
      switch (event.type) {
        case "content_block_start":
          if (event.content_block.type === "text") {
            contentBlocks.push({ ...event.content_block, text: "" });
          } else if (event.content_block.type === "tool_use") {
            currentToolId = event.content_block.id;
            currentToolName = event.content_block.name;
            currentToolInput = "";
          }
          break;

        case "content_block_delta":
          if (event.delta.type === "text_delta") {
            // Stream text to the user immediately
            process.stdout.write(event.delta.text);
            // Also accumulate for history
            const lastBlock = contentBlocks[contentBlocks.length - 1];
            if (lastBlock?.type === "text") {
              lastBlock.text += event.delta.text;
            }
          } else if (event.delta.type === "input_json_delta") {
            currentToolInput += event.delta.partial_json;
          }
          break;

        case "content_block_stop":
          if (currentBlockType === "tool_use") {
            contentBlocks.push({
              type: "tool_use",
              id: currentToolId,
              name: currentToolName,
              input: currentToolInput ? JSON.parse(currentToolInput) : {},
            });
            currentToolInput = "";
          }
          currentBlockType = null;
          break;
      }
    }

    // Add complete response to history
    messages.push({ role: "assistant", content: contentBlocks });

    // Check for tool use (same as before)
    const toolBlocks = contentBlocks.filter(b => b.type === "tool_use");
    if (toolBlocks.length === 0) {
      return contentBlocks
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map(b => b.text).join("\n");
    }

    // Execute tools and continue (same as before)
    // ...
  }
}
```

The key change is in the inner loop. We iterate over stream events instead of waiting for a complete response. Text is printed as it arrives. Tool inputs are buffered until complete.

## What the user sees

Without streaming:
```
> What does the Button component do?
(10 second pause...)
The Button component accepts a label and onClick handler...
```

With streaming:
```
> What does the Button component do?
  [tool] read_file({"file_path":"sample-project/src/components/Button.tsx"})
  [result] 1  interface ButtonProps { ...
The| Button| component| accepts| a| label| and| onClick| handler|...
```

Each `|` represents where a new chunk appeared. The user sees the response building up in real time.

## Using the SDK helper

Most LLM SDKs provide helpers for streaming. For example, the Anthropic SDK has a `finalMessage()` helper to get the complete response after streaming:

```typescript
const stream = client.messages.stream({ ... });

// Stream text to the user
stream.on("text", (text) => {
  process.stdout.write(text);
});

// Get the complete message when done
const finalMessage = await stream.finalMessage();
```

This is easier for simple cases. For our agentic loop, we need more control (to detect tool_use blocks during streaming), so we use the raw event approach.

## Streaming thinking blocks

Many LLMs now support "thinking" or "reasoning" where the model shows its thought process before responding. When enabled, the model produces a `thinking` content block before the `text` or `tool_use` blocks.

Thinking blocks stream the same way as text, just with a different delta type:

- `content_block_start` with `type: "thinking"` signals a thinking block
- `content_block_delta` with `type: "thinking_delta"` carries chunks of the model's reasoning
- `content_block_stop` ends the thinking block

```typescript
case "content_block_start":
  if (event.content_block.type === "thinking") {
    // A thinking block is starting
    console.log("  [thinking...]");
  }
  break;

case "content_block_delta":
  if (event.delta.type === "thinking_delta") {
    // The model is reasoning. You can show this or hide it.
    // Some agents show a spinner, some show the full thought process.
    process.stdout.write(event.delta.thinking);
  }
  break;
```

Whether to show thinking to the user is a design choice. Some agents display it in a collapsible section. Some show a spinner with "Thinking..." and hide the content. Some skip it entirely. The thinking block does not need to go into the conversation history for the agentic loop to work. It is the `text` and `tool_use` blocks that matter.

One thing to note: some providers also have "redacted thinking" blocks where the model thought about something but the content is hidden from you. You get a block with `type: "redacted_thinking"` but no actual text. Just acknowledge it and move on.

## What is still missing

When the model calls 3 tools at once (like reading 3 files), we execute them one at a time. But Read is a safe, read-only operation. We could run all 3 in parallel and save time. That is the topic of the next chapter.

## Running the example

```bash
npm run example:09
```

Watch how text appears incrementally instead of all at once. Compare the experience with earlier examples.
