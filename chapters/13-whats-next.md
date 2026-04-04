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

### LSP (Language Server Protocol) integration

Language servers provide diagnostics (type errors, lint warnings), code navigation (go to definition, find references), and auto-completion. Connecting your agent to an LSP means it can see the same errors your editor sees. It can fix type errors it just introduced without running a full build.

### Git integration

Production agents track changes with git. They can show diffs of what they changed, create commits, open pull requests, and revert if something goes wrong. Git gives users confidence that they can always undo the agent's work.

### Multi-model strategies

Not every task needs the most powerful model. Summarization (Chapter 6) can use a cheaper, faster model. Exploration subagents can use a smaller model. The main decision-making loop uses the best model. This reduces cost and latency.

### Prompt caching

When you send the same system prompt and conversation prefix on every API call, you pay for those tokens every time. Prompt caching stores the processed prefix and reuses it across calls. This saves both cost and latency, especially for long conversations.

### File watching

When the user edits a file outside the agent (in their editor), the agent should notice. File watchers detect changes and can update the agent's understanding of the codebase in real time.

## Ideas for extensions

If you want to keep building on what you have:

- **A todo/task tool** that lets the model track what it has done and what is left
- **Git tools** (status, diff, commit, log) so the model can manage its own changes
- **A diff viewer** that shows exactly what changed after each edit, in a readable format
- **Multiple models** for different tasks (fast model for search, powerful model for edits)
- **A GUI** with a chat interface, file tree, and diff viewer
- **Custom tool plugins** where users can add their own tools without modifying the agent

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
