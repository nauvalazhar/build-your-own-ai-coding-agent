# Chapter 13: What's Next

## What you built

Over the last 12 chapters, you built a complete AI coding agent from scratch:

| Chapter | What you added |
|---|---|
| 1. Agentic Loop | The `while(true)` core. Model calls tools, gets results, decides what to do next. |
| 2. Tools | Read, write, search, list, run commands. The model's eyes and hands. |
| 3. Edit Tool | `string.replace()` with uniqueness validation. How AI actually edits files. |
| 4. System Prompts | "Search before assuming. Read before editing." The instructions that shape behavior. |
| 5. Context | Full conversation history sent each turn. Follow-ups work because context carries forward. |
| 6. Compression | Truncation, clearing old results, LLM summarization. Keeping conversations alive when context runs out. |
| 7. Permissions | Allow, ask, deny. A gate between the model's intentions and actual execution. |
| 8. Subagents | Same loop, isolated context. Delegation without pollution. |
| 9. Streaming | Token-by-token output. The model feels fast even when it is not. |
| 10. Concurrency | Safe tools run in parallel. Unsafe tools run alone. |
| 11. Web Access | Fetch URLs and search the web. The agent can read documentation and look things up. |
| 12. Persistence | Save conversations to disk, resume later, project instructions that carry across sessions. |

These are the same core ideas behind production AI coding tools. The implementations are simplified, but the architecture is real.

## What production agents add

If you want to take this further, here are the areas where production tools invest heavily:

### MCP (Model Context Protocol)

MCP is a standard for connecting AI models to external tools and data sources. Instead of hardcoding tools like we did, MCP lets users plug in tools from any provider. A database tool, a Jira integration, a custom API client. The model discovers available tools at runtime.

```typescript
// Instead of hardcoded tools:
const tools = [readFileTool, editFileTool, ...];

// MCP lets users configure tools dynamically:
const tools = [
  ...builtInTools,
  ...await loadMCPTools("./mcp-config.json"),  // user-provided tools
];
```

The model does not care where the tool came from. It sees the same interface (name, description, input schema, call). MCP just standardizes how tools are discovered and loaded. See [modelcontextprotocol.io](https://modelcontextprotocol.io) for the spec.

### LSP (Language Server Protocol) integration

Language servers provide diagnostics (type errors, lint warnings), code navigation (go to definition, find references), and auto-completion. Connecting your agent to an LSP means it can see the same errors your editor sees.

```typescript
// After editing a file, check for errors:
const diagnostics = await lspClient.getDiagnostics("src/App.tsx");
// Returns: [{ line: 15, message: "Type 'string' is not assignable to type 'number'" }]

// The agent sees the error and can fix it on the next turn
```

Without LSP, the agent would not know about type errors until someone runs the compiler. With LSP, it gets instant feedback after every edit.

### Git integration

Production agents track changes with git. They can show diffs of what they changed, create commits, open pull requests, and revert if something goes wrong.

```typescript
// After making edits, the agent can:
await exec("git diff");           // Show what changed
await exec("git add -A");         // Stage changes
await exec("git commit -m '...'"); // Commit with a message
await exec("git stash");          // Undo if something went wrong
```

Git gives users confidence that they can always undo the agent's work. Some agents even create a commit before each edit so every change is reversible.

### Multi-model strategies

Not every task needs the most powerful model. You can use different models for different jobs:

```typescript
// Main loop: powerful model for decision-making
const mainModel = "claude-sonnet-4-20250514";

// Summarization (Chapter 6): cheap model
const summaryModel = "claude-haiku-4-5-20251001";

// Web fetch extraction (Chapter 11): cheap model
const extractionModel = "claude-haiku-4-5-20251001";

// Exploration subagents (Chapter 8): can use a smaller model
const exploreModel = "claude-haiku-4-5-20251001";
```

This reduces cost and latency. The main loop uses the best model for tool selection and code edits. Everything else uses a cheaper one.

### Prompt caching

When you send the same system prompt and conversation prefix on every API call, you pay for those tokens every time. Prompt caching stores the processed prefix on the server and reuses it across calls.

```typescript
const response = await client.messages.create({
  model: "claude-sonnet-4-20250514",
  system: [
    {
      type: "text",
      text: SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },  // cache this block
    },
  ],
  // ...
});
```

The first call processes the full system prompt. Subsequent calls reuse the cached version. This saves both cost (cached tokens are cheaper) and latency (no re-processing).

### File watching

When the user edits a file outside the agent (in their editor), the agent should notice. File watchers detect changes and can update the staleness cache in real time.

```typescript
import { watch } from "fs";

// Watch the project directory for changes
watch("src/", { recursive: true }, (event, filename) => {
  // Update the read timestamp so the agent knows the file changed
  readTimestamps.delete(path.resolve("src/", filename));
});
```

Without file watching, the agent relies on staleness checks at edit time (Chapter 3). With file watching, it knows immediately when files change.

## Building a TUI

Our examples use a simple readline prompt. Production agents like Claude Code have a full terminal UI (TUI) with colors, spinners, syntax highlighting, and interactive permission dialogs.

If you want to build a proper TUI, here are some libraries to look at:

- **[Ink](https://github.com/vadimdemedes/ink)** - React for the terminal. Build terminal UIs with React components. This is what Claude Code uses.
- **[Blessed](https://github.com/chjj/blessed)** - A curses-like library for Node.js. Lower level, more control.
- **[Clack](https://github.com/bombshell-dev/clack)** - Beautiful prompts and spinners. Good for simpler CLIs.
- **[@clack/prompts](https://github.com/bombshell-dev/clack)** - Interactive prompts (select, confirm, spinner) that look polished out of the box.
- **[Charm](https://charm.sh/)** - Go-based TUI tools (Bubble Tea, Lip Gloss). If you prefer Go over TypeScript.

With Ink, for example, your permission dialog could look like:

```tsx
function PermissionDialog({ toolName, input, onAllow, onDeny }) {
  return (
    <Box flexDirection="column" borderStyle="round" padding={1}>
      <Text bold>The agent wants to use: {toolName}</Text>
      <Text color="gray">{JSON.stringify(input)}</Text>
      <Box gap={2}>
        <Text color="green">[y] Allow</Text>
        <Text color="red">[n] Deny</Text>
        <Text color="blue">[a] Always allow</Text>
      </Box>
    </Box>
  );
}
```

A TUI is optional. The agent works the same with readline. But a good TUI makes the experience much nicer.

## Ideas for extensions

If you want to keep building on what you have:

- **A todo/task tool** that lets the model track what it has done and what is left
- **Git tools** (status, diff, commit, log) so the model can manage its own changes
- **A diff viewer** that shows exactly what changed after each edit, in a readable format
- **Custom tool plugins** where users can add their own tools without modifying the agent
- **IDE integration** via VS Code extension or JetBrains plugin

## The core idea

Everything in this guide comes back to one simple idea:

```
while (true) {
  response = callModel(messages)
  if (response has tool calls) {
    results = executeTools(response.toolCalls)
    messages.push(response, results)
    continue
  }
  break
}
```

The model's output becomes its own input. The loop is dumb. The model is smart. Everything else is just making that loop faster, safer, and more capable.

Now go build something.
