# Chapter 10: Concurrent Tool Execution

## The problem

In the previous chapters, the model usually calls one tool per turn. It calls `read_file`, gets the result, then decides what to do next. But the model can also call **multiple tools in a single turn**. Instead of one `tool_use` block in the response, it returns several:

```json
{
  "content": [
    { "type": "tool_use", "name": "read_file", "input": { "file_path": "A.tsx" } },
    { "type": "tool_use", "name": "read_file", "input": { "file_path": "B.tsx" } },
    { "type": "tool_use", "name": "read_file", "input": { "file_path": "C.tsx" } }
  ]
}
```

The model is saying: "I need all three files. Get them for me." Our loop already handles this. Remember the `for` loop from Chapter 1 that executes each tool?

```typescript
for (const toolUse of toolUseBlocks) {
  const result = await tool.call(toolUse.input);  // waits for each one
  toolResults.push({ ... });
}
```

It runs them one at a time because of `await`. Each tool waits for the previous one to finish. Each file read takes 50ms. Three reads: 150ms. If we run them at the same time: 50ms. Three times faster.

But what about `edit_file`? If two edits target the same file, running them in parallel could corrupt the file. One edit might overwrite the other.

We need to know which tools are safe to run in parallel and which are not.

## The concurrency flag

Each tool declares whether it is safe to run alongside other tools:

```typescript
interface Tool {
  name: string;
  // ... other fields
  isConcurrencySafe: boolean;
}
```

The rule is simple:

| Tool | Concurrent? | Why |
|---|---|---|
| read_file | Yes | Reading does not change state |
| list_files | Yes | Listing does not change state |
| search_files | Yes | Searching does not change state |
| edit_file | No | Two edits could conflict |
| write_file | No | Two writes could conflict |
| run_command | Usually no | Commands can change state, affect the filesystem, share environment |

Read-only tools are safe to parallelize. Tools that change state are not.

In practice, the flag can depend on the input. A shell command like `cat file.txt` is read-only and could be safe. Production agents check if a command is read-only and allow concurrency in that case. For simplicity, we mark all shell commands as unsafe. You can refine this later.

## Partitioning into batches

When the model returns multiple tool calls in one response, we group them into batches:

```
Tool calls from the model (5 calls in one response):

  1. read_file("src/App.tsx")
  2. read_file("src/components/Button.tsx")
  3. search_files("className")
  4. edit_file("src/App.tsx", ...)
  5. read_file("src/components/Header.tsx")

Partitioned into batches:

  Batch 1: [read_file, read_file, search_files]  ← all safe, run in parallel
  Batch 2: [edit_file]                            ← not safe, run alone
  Batch 3: [read_file]                            ← safe, but must wait for the edit
```

The algorithm walks through the tool calls left to right:

```typescript
interface Batch {
  tools: ToolCall[];
  concurrent: boolean;
}

function partitionIntoBatches(toolCalls: ToolCall[]): Batch[] {
  const batches: Batch[] = [];
  let currentBatch: ToolCall[] = [];
  let currentIsConcurrent = true;

  for (const call of toolCalls) {
    const tool = tools.find(t => t.name === call.name);
    const isSafe = tool?.isConcurrencySafe ?? false;

    if (isSafe && currentIsConcurrent) {
      // Add to current concurrent batch
      currentBatch.push(call);
    } else {
      // Flush current batch if it has items
      if (currentBatch.length > 0) {
        batches.push({ tools: currentBatch, concurrent: currentIsConcurrent });
      }
      // Start new batch
      currentBatch = [call];
      currentIsConcurrent = isSafe;
    }
  }

  // Flush the last batch
  if (currentBatch.length > 0) {
    batches.push({ tools: currentBatch, concurrent: currentIsConcurrent });
  }

  return batches;
}
```

Using the example from earlier, the output would look like:

```typescript
[
  {
    concurrent: true,
    tools: [
      { name: "read_file", input: { file_path: "src/App.tsx" } },
      { name: "read_file", input: { file_path: "src/components/Button.tsx" } },
      { name: "search_files", input: { pattern: "className" } },
    ]
  },
  {
    concurrent: false,
    tools: [
      { name: "edit_file", input: { file_path: "src/App.tsx", ... } },
    ]
  },
  {
    concurrent: true,
    tools: [
      { name: "read_file", input: { file_path: "src/components/Header.tsx" } },
    ]
  },
]
```

Three batches. The first and third can run their tools in parallel. The second runs alone.

## Executing batches

Concurrent batches use `Promise.all()`. Non-concurrent batches run one tool at a time:

```typescript
async function executeBatches(batches: Batch[]): Promise<ToolResult[]> {
  const allResults: ToolResult[] = [];

  for (const batch of batches) {
    if (batch.concurrent) {
      // Run all tools in this batch at the same time
      const results = await Promise.all(
        batch.tools.map(call => executeTool(call))
      );
      allResults.push(...results);
    } else {
      // Run tools one at a time
      for (const call of batch.tools) {
        const result = await executeTool(call);
        allResults.push(result);
      }
    }
  }

  return allResults;
}
```

Our batch approach is simple and works well. Production agents often use a different mechanism: a **queue**. Instead of pre-grouping tools into batches, they walk through a list of queued tools and start each one if conditions allow. "Can this tool run right now?" If all currently running tools are safe and this one is also safe, start it. If not, wait.

The result is the same (safe tools run together, unsafe tools run alone) but the queue approach handles tools that arrive mid-execution better, since streaming can deliver tool calls one at a time while earlier tools are still running.

For learning purposes, batching is easier to understand. The queue approach is an optimization you can switch to later.

## Visualized

```mermaid
flowchart LR
    subgraph "Batch 1 (parallel)"
        R1["read_file(App.tsx)"]
        R2["read_file(Button.tsx)"]
        S1["search_files(className)"]
    end

    subgraph "Batch 2 (serial)"
        E1["edit_file(App.tsx)"]
    end

    subgraph "Batch 3 (parallel)"
        R3["read_file(Header.tsx)"]
    end

    R1 --> E1
    R2 --> E1
    S1 --> E1
    E1 --> R3
```

Batch 1 runs all three reads/searches at the same time. When all three are done, Batch 2 runs the edit alone. Then Batch 3 runs the final read.

## Order preservation

Even though tools in a concurrent batch finish at different times, results must be returned in the original order. The model expects results to match the order of its tool calls.

`Promise.all()` already handles this. It returns results in the same order as the input promises, regardless of which one resolved first.

```typescript
const results = await Promise.all([
  read_file("src/App.tsx"),              // Finishes 3rd (large file)
  read_file("src/components/Button.tsx"), // Finishes 1st (small file)
  search_files("className"),             // Finishes 2nd
]);

// results[0] = App.tsx contents (matches input order, not finish order)
// results[1] = Button.tsx contents
// results[2] = search results
```

## Error handling

When a tool in a batch fails, what happens to the other tools?

For read-only tools, errors are independent. If `read_file("App.tsx")` fails but `read_file("Button.tsx")` succeeds, there is no problem. Return the error for one and the result for the other.

For shell commands, it is different. If a batch contained a `run_command` that fails (like a build step), sibling tools running in the same batch might be in an inconsistent state. Production agents abort sibling tools when a shell command fails.

For our simple version, we let each tool handle its own errors:

```typescript
const results = await Promise.all(
  batch.tools.map(async (call) => {
    try {
      return await executeTool(call);
    } catch (err) {
      return { toolUseId: call.id, content: `Error: ${err}`, isError: true };
    }
  })
);
```

Each tool call is wrapped in a try/catch. A failure in one does not affect the others.

## Wiring it into the loop

In previous chapters, we executed tools one at a time in a `for` loop. Now we replace that with batch execution. The change is small:

```typescript
// Before (sequential):
for (const toolUse of toolBlocks) {
  const tool = tools.find(t => t.name === toolUse.name);
  const result = await tool.call(toolUse.input);
  toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result });
}

// After (concurrent):
const toolCalls = toolBlocks.map(block => ({
  block,
  tool: tools.find(t => t.name === block.name),
  input: block.input,
}));
const batches = partitionIntoBatches(toolCalls);
const toolResults = await executeBatches(batches);
```

Everything else in the agentic loop stays the same. The tool results still get pushed into the conversation as a user message. The loop still checks for tool_use blocks to decide whether to continue. The only difference is how the tools are executed between those steps.

## Performance impact

The improvement depends on the workload:

| Scenario | Sequential | Concurrent | Speedup |
|---|---|---|---|
| Read 3 small files | 150ms | 50ms | 3x |
| Read + Search + List | 200ms | 80ms | 2.5x |
| Read 1 file, Edit 1 file | 100ms | 100ms | 1x (cannot parallelize) |
| 5 reads + 1 edit + 3 reads | 450ms | 200ms | 2.25x |

The bigger the batch of concurrent-safe tools, the bigger the win. If the model calls mostly reads and searches (which is common during exploration), concurrency makes a noticeable difference.

## What is still missing

Nothing! This is the final feature layer. You now have a complete AI coding agent with:

- An agentic loop (Chapter 1)
- Tools for reading, editing, searching, and running commands (Chapters 2-3)
- A system prompt that guides behavior (Chapter 4)
- Context management and compression (Chapters 5-6)
- A permission system (Chapter 7)
- Subagents for delegation (Chapter 8)
- Streaming for real-time output (Chapter 9)
- Concurrent tool execution (this chapter)

The next and final chapter wraps up with ideas for where to go from here.

## Running the example

```bash
npm run example:10
```

Ask the agent to read multiple files and watch the logs. Concurrent reads will execute in a single batch instead of one at a time:

```
  [batch] Executing 3 tools concurrently
  [tool] read_file("src/App.tsx")
  [tool] read_file("src/components/Button.tsx")
  [tool] read_file("src/components/Header.tsx")
  [batch] All 3 completed
```
