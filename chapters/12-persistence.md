# Chapter 12: Persistence

## The problem

Close the agent and everything is gone. The conversation, the files it read, what you were working on. Open it again and it starts from zero. "What were we doing?" "I have no idea."

For short tasks this is fine. For longer projects that span multiple sessions, it is a problem. You want to close your laptop, come back tomorrow, and pick up where you left off.

## What is persistence?

Persistence means saving the agent's state to disk so it can be restored later. There are three parts:

1. **Conversation history**: Save the messages so the agent can resume a previous session.
2. **Project instructions**: A file in the project that tells the agent how to behave in this specific codebase. Persists across all sessions.
3. **Memory**: Notes the agent saves about you or the project. Persists across sessions.

## Walkthrough: Resume a session

```
Session 1 (Monday):
  > Help me refactor the auth module
  ... (20 turns of reading, editing, testing)
  > I need to go, let's continue tomorrow
  Session saved to .agent/session.jsonl

Session 2 (Tuesday):
  > /resume
  Loaded 45 messages from previous session.
  > Continue where we left off
  The agent sees the full conversation from Monday.
  It knows which files it read, what changes it made.
  It picks up from where it stopped.
```

The agent did not re-read every file. It did not re-discover the project structure. All of that was in the saved conversation.

## Saving conversations to disk

The simplest format for saving conversations is JSONL (JSON Lines). Each line is one JSON object. You append a new line for each message. No need to read and rewrite the whole file.

```typescript
import * as fs from "fs";

const SESSION_FILE = ".agent/session.jsonl";

function saveMessage(message: Anthropic.MessageParam): void {
  fs.mkdirSync(".agent", { recursive: true });
  const line = JSON.stringify(message) + "\n";
  fs.appendFileSync(SESSION_FILE, line);
}
```

Why JSONL instead of plain JSON? With JSON, you would need to read the entire file, parse it, add the message, and write it back. With JSONL, you just append a line. This is faster and safer. If the process crashes mid-write, you lose at most one line instead of corrupting the whole file.

You call `saveMessage` in the agentic loop every time a message is added:

```typescript
// After the user sends a message:
conversationHistory.push({ role: "user", content: userInput });
saveMessage({ role: "user", content: userInput });

// After the assistant responds:
conversationHistory.push({ role: "assistant", content: response.content });
saveMessage({ role: "assistant", content: response.content });

// After tool results:
conversationHistory.push({ role: "user", content: toolResults });
saveMessage({ role: "user", content: toolResults });
```

Every message is saved as it happens. Not at the end of the session.

## Loading and resuming

To resume, read the JSONL file and parse each line back into a message:

```typescript
function loadSession(): Anthropic.MessageParam[] {
  if (!fs.existsSync(SESSION_FILE)) {
    return [];
  }

  const content = fs.readFileSync(SESSION_FILE, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);

  return lines.map(line => JSON.parse(line));
}
```

When the user types `/resume`, load the messages and continue. This goes in the REPL input handler, before the user's input is sent to the agentic loop:

```typescript
// In the REPL, where you read user input:
rl.question("> ", async (userInput) => {
  // Handle commands before sending to the agent
  if (userInput === "/resume") {
    const loaded = loadSession();
    if (loaded.length === 0) {
      console.log("No previous session found.");
    } else {
      conversationHistory.push(...loaded);
      console.log(`Loaded ${loaded.length} messages from previous session.`);
    }
    return ask(); // Go back to the prompt, do not send to the agent
  }

  if (userInput === "/new") {
    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
    conversationHistory.length = 0;
    console.log("Started new session.");
    return ask();
  }

  // Normal input: save and send to the agent
  conversationHistory.push({ role: "user", content: userInput });
  saveMessage({ role: "user", content: userInput });
  const response = await agentLoop(conversationHistory);
  // ...
});
```

The `/resume` and `/new` commands are intercepted before the input reaches the agent. They are not tool calls. They are REPL commands that modify the conversation history directly.

After `/resume`, the model sees the entire previous conversation on the next turn. It can reference files it read, edits it made, and decisions from the last session.

### Showing previous sessions

Our example saves one session file. But what if the user has had many sessions and wants to pick which one to resume?

Production agents save each session with a unique ID (e.g., `session-<uuid>.jsonl`) and store metadata like the first user message, a title, and the timestamp. When the user asks to resume, the agent shows a list:

```
Previous sessions:
  1. [Apr 3] "Help me refactor the auth module"
  2. [Apr 1] "Add dark mode to the settings page"
  3. [Mar 28] "Fix the login bug"

Which session? >
```

They do not parse the entire JSONL file to show this list. Instead, they read just the first and last few lines of each file (head and tail) to extract the title and last prompt. This is fast even with large session files.

For our example, a single session file is enough. But if you want to support multiple sessions, the pattern is: give each session a unique filename, store a summary in the first line, and list them by reading just the headers:

```typescript
// Save with a unique ID and a summary as the first line
const sessionId = crypto.randomUUID();
const sessionFile = `.agent/sessions/${sessionId}.jsonl`;
fs.appendFileSync(sessionFile,
  JSON.stringify({ type: "metadata", summary: userInput, createdAt: Date.now() }) + "\n"
);

// List sessions by reading only the first line of each file
function listSessions(): { id: string; summary: string; date: string }[] {
  const dir = ".agent/sessions";
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => f.endsWith(".jsonl"))
    .map(f => {
      const firstLine = fs.readFileSync(path.join(dir, f), "utf-8").split("\n")[0];
      const meta = JSON.parse(firstLine);
      return {
        id: f.replace(".jsonl", ""),
        summary: meta.summary,
        date: new Date(meta.createdAt).toLocaleDateString(),
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}
```

The first line of each file is a metadata entry with the summary. Listing sessions only reads that one line per file, not the entire conversation.

## Project instructions

Some instructions apply to every session in a project. "This project uses Tailwind." "Run tests with npm test." "The API is in src/api/." You do not want to repeat these every time you start the agent.

The solution: a markdown file in the project root that the agent reads automatically. We call it `AGENT.md`, but you can name it anything. Claude Code uses `CLAUDE.md`, Codex uses `AGENTS.md`. The name does not matter. The idea is the same.

```typescript
const PROJECT_INSTRUCTIONS_FILE = "AGENT.md";

function loadProjectInstructions(): string | null {
  if (!fs.existsSync(PROJECT_INSTRUCTIONS_FILE)) {
    return null;
  }
  return fs.readFileSync(PROJECT_INSTRUCTIONS_FILE, "utf-8");
}
```

If the file exists, its content gets added to the system prompt. We will wire this into `buildSystemPrompt()` later in this chapter, along with memory.

Now any developer on the team can add a `AGENT.md` to the repo:

```markdown
# Project Instructions

- This is a React + TypeScript project using Tailwind CSS.
- Run tests with `npm test`.
- The API layer is in `src/api/`. Do not modify files in `src/generated/`.
- Use functional components, not class components.
- Always add types for function parameters.
```

The agent reads this on every startup and follows the instructions. It is like an onboarding document for the AI.

### Priority levels

Production agents support multiple instruction files at different levels:

```
~/.agent/AGENT.md             → global (all projects)
./AGENT.md                    → project (shared with team)
./AGENT.local.md              → local (your personal overrides, gitignored)
```

Each level adds to the previous one. Global instructions apply everywhere. Project instructions apply to this repo. Local instructions are your personal preferences that you do not want to commit.

For our example, we keep it simple with one file. But the pattern extends naturally.

## Memory across sessions

Project instructions are static. You write them once and they stay. But what about things the agent learns during a conversation? "The user prefers tabs over spaces." "The deploy key is in 1Password." "We decided to use Zustand instead of Redux."

Memory is a file the agent can read and write. It persists across sessions:

```typescript
const MEMORY_FILE = ".agent/memory.md";

const memoryTool: Tool = {
  name: "save_memory",
  description:
    "Save a note to memory that persists across sessions. " +
    "Use this for user preferences, project decisions, or important context.",
  inputSchema: z.object({
    content: z.string().describe("The note to save"),
  }),
  async call(input) {
    fs.mkdirSync(".agent", { recursive: true });
    const content = input.content as string;
    const timestamp = new Date().toISOString().split("T")[0];
    fs.appendFileSync(MEMORY_FILE, `\n- [${timestamp}] ${content}`);
    return "Saved to memory.";
  },
};
```

On startup, load the memory file and add it to the system prompt. In Chapter 4, our system prompt was a simple constant. Now it needs to include dynamic content (project instructions and memory), so we turn it into a function that builds the full prompt from all sources:

```typescript
function loadMemory(): string | null {
  if (!fs.existsSync(MEMORY_FILE)) return null;
  return fs.readFileSync(MEMORY_FILE, "utf-8");
}

function buildSystemPrompt(): string {
  const base = `You are a coding assistant. You can read, search, and edit local files.
Use save_memory to remember important things about the user or project.`;

  const parts = [base];

  const instructions = loadProjectInstructions();
  if (instructions) {
    parts.push(`# Project Instructions (from AGENT.md)\n${instructions}`);
  }

  const memory = loadMemory();
  if (memory) {
    parts.push(`# Memory (from previous sessions)\n${memory}`);
  }

  return parts.join("\n\n");
}
```

Call `buildSystemPrompt()` inside the agentic loop, not once at startup. This way, if the agent saves a memory on turn 3, the system prompt on turn 4 includes it:

```typescript
while (true) {
  const systemPrompt = buildSystemPrompt(); // fresh every turn

  const stream = client.messages.stream({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: systemPrompt,
    tools: apiTools,
    messages,
  });

  // ... rest of the loop
}
```

The agent sees its own past notes every session. Over time, the memory file builds up a picture of the user and the project:

```markdown
- [2026-03-15] User prefers Tailwind over inline styles
- [2026-03-15] The database migration tool is in scripts/migrate.ts
- [2026-03-18] User decided to use Zustand for state management
- [2026-04-01] Deploy process: run npm run build, then scripts/deploy.sh
```

Production agents go further with AI-powered memory selection. Instead of loading the entire memory file, they use a cheap model to pick the 5-10 most relevant memories for the current task. But simple "load everything" works fine for smaller memory files.

## What is still missing

Nothing. You have now built a complete AI coding agent with 12 features layered on top of a simple while loop. The next and final chapter wraps up with ideas for where to go from here.

## Running the example

```bash
npm run example:12
```

Try:
1. Have a conversation ("read the Button component in sample-project")
2. Close the agent (Ctrl+C)
3. Run it again and type `/resume`
4. The agent loads the previous conversation

Also try:
- Create a `AGENT.md` file in the project root with some instructions
- Ask the agent to "remember that I prefer dark themes" (it saves to memory)
- Restart and check that the memory persists

## The full code

Here is everything from this chapter in one file (`examples/12-with-persistence.ts`):

```typescript
// This example focuses on: persistence (Chapter 12).
// Includes: tools (Ch2), edit (Ch3), system prompt (Ch4), streaming (Ch9).
// Omits: permissions (Ch7), subagents (Ch8), compression (Ch6), concurrency (Ch10),
//        web access (Ch11) to keep the code focused on persistence.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as readline from "readline";

const client = new Anthropic();

// --- Persistence paths ---
const AGENT_DIR = ".agent";
const SESSION_FILE = path.join(AGENT_DIR, "session.jsonl");
const MEMORY_FILE = path.join(AGENT_DIR, "memory.md");
const PROJECT_INSTRUCTIONS_FILE = "AGENT.md";

// --- Load project instructions and memory ---
function loadProjectInstructions(): string | null {
  try {
    if (fs.existsSync(PROJECT_INSTRUCTIONS_FILE)) {
      return fs.readFileSync(PROJECT_INSTRUCTIONS_FILE, "utf-8");
    }
  } catch {}
  return null;
}

function loadMemory(): string | null {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      return fs.readFileSync(MEMORY_FILE, "utf-8");
    }
  } catch {}
  return null;
}

// Build the system prompt with optional project instructions and memory
function buildSystemPrompt(): string {
  const base = `You are a coding assistant. You can read, search, and edit local files, fetch web pages, and save notes to memory.

# How to work
- Use list_files and search_files to find relevant files before editing.
- Always read a file before editing it.
- Use save_memory to remember important things about the user or project.
- Be concise.`;

  const parts = [base];

  const instructions = loadProjectInstructions();
  if (instructions) {
    parts.push(`# Project Instructions (from AGENT.md)\n${instructions}`);
  }

  const memory = loadMemory();
  if (memory) {
    parts.push(`# Memory (from previous sessions)\n${memory}`);
  }

  return parts.join("\n\n");
}

// --- Session save/load ---
function saveMessage(message: Anthropic.MessageParam): void {
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  fs.appendFileSync(SESSION_FILE, JSON.stringify(message) + "\n");
}

function loadSession(): Anthropic.MessageParam[] {
  if (!fs.existsSync(SESSION_FILE)) return [];
  try {
    const content = fs.readFileSync(SESSION_FILE, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines.map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function clearSession(): void {
  if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
}

// --- Types ---
interface Tool {
  name: string;
  description: string;
  inputSchema: z.ZodObject<any>;
  isConcurrencySafe: boolean;
  call(input: Record<string, unknown>): Promise<string>;
}

const readTimestamps = new Map<string, number>();
const MAX_RESULT_CHARS = 10_000;

function truncateResult(r: string): string {
  return r.length <= MAX_RESULT_CHARS ? r : r.slice(0, MAX_RESULT_CHARS) + "\n[Truncated]";
}

function findActualString(fc: string, ss: string): string | null {
  if (fc.includes(ss)) return ss;
  const n = (s: string) => s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
  const i = n(fc).indexOf(n(ss));
  return i !== -1 ? fc.substring(i, i + ss.length) : null;
}

function zodToJsonSchema(schema: z.ZodObject<any>): Record<string, unknown> {
  const shape = schema.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    const zv = value as z.ZodTypeAny;
    const opt = zv.isOptional();
    const inner = opt ? (zv as z.ZodOptional<any>)._def.innerType : zv;
    const isBoolean = inner instanceof z.ZodBoolean;
    properties[key] = { type: isBoolean ? "boolean" : "string", description: inner._def.description || "" };
    if (!opt) required.push(key);
  }
  return { type: "object", properties, required };
}

// --- Tools ---
const tools: Tool[] = [
  {
    name: "read_file",
    description: "Read a file with line numbers.",
    inputSchema: z.object({ file_path: z.string() }),
    isConcurrencySafe: true,
    async call(input) {
      const fp = input.file_path as string;
      try {
        const c = fs.readFileSync(fp, "utf-8");
        readTimestamps.set(path.resolve(fp), Date.now());
        return truncateResult(c.split("\n").map((l, i) => `${i + 1}\t${l}`).join("\n"));
      } catch (e: any) { return `Error: ${e.message}`; }
    },
  },
  {
    name: "edit_file",
    description: "Edit a file by replacing old_string with new_string. Read first.",
    inputSchema: z.object({ file_path: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() }),
    isConcurrencySafe: false,
    async call(input) {
      const { file_path: fp, old_string: os, new_string: ns, replace_all: ra } = input as any;
      if (os === ns) return "Error: identical.";
      if (!fs.existsSync(fp)) return "Error: not found.";
      const c = fs.readFileSync(fp, "utf-8");
      const a = findActualString(c, os);
      if (!a) return "Error: not found in file.";
      if (!ra && c.split(a).length - 1 > 1) return "Error: multiple matches.";
      const u = ra ? c.split(a).join(ns) : c.replace(a, ns);
      fs.writeFileSync(fp, u);
      readTimestamps.set(path.resolve(fp), Date.now());
      return `Edited ${fp}`;
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file.",
    inputSchema: z.object({ file_path: z.string(), content: z.string() }),
    isConcurrencySafe: false,
    async call(input) {
      const fp = input.file_path as string;
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, input.content as string);
      return `Written: ${fp}`;
    },
  },
  {
    name: "list_files",
    description: "List files recursively.",
    inputSchema: z.object({ directory: z.string().optional() }),
    isConcurrencySafe: true,
    async call(input) {
      const dir = (input.directory as string) || ".";
      const files: string[] = [];
      function walk(d: string) {
        try {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.name.startsWith(".") || e.name === "node_modules") continue;
            const f = path.join(d, e.name);
            if (e.isDirectory()) walk(f); else files.push(f);
          }
        } catch {}
      }
      walk(dir);
      return files.join("\n") || "(empty)";
    },
  },
  {
    name: "search_files",
    description: "Search for a regex pattern in files.",
    inputSchema: z.object({ pattern: z.string(), directory: z.string().optional() }),
    isConcurrencySafe: true,
    async call(input) {
      const dir = (input.directory as string) || ".";
      const rx = new RegExp(input.pattern as string);
      const res: string[] = [];
      function s(d: string) {
        try {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.name.startsWith(".") || e.name === "node_modules") continue;
            const f = path.join(d, e.name);
            if (e.isDirectory()) { s(f); } else {
              try { fs.readFileSync(f, "utf-8").split("\n").forEach((l, i) => {
                if (rx.test(l)) res.push(`${f}:${i + 1}: ${l.trim()}`);
              }); } catch {}
            }
          }
        } catch {}
      }
      s(dir);
      return truncateResult(res.slice(0, 50).join("\n") || "No matches.");
    },
  },
  {
    name: "run_command",
    description: "Run a shell command.",
    inputSchema: z.object({ command: z.string() }),
    isConcurrencySafe: false,
    async call(input) {
      try {
        return truncateResult(execSync(input.command as string, { encoding: "utf-8", timeout: 30_000, maxBuffer: 1024 * 1024 }) || "(no output)");
      } catch (e: any) { return `Error: ${e.stderr || e.message}`; }
    },
  },

  // --- Memory tool (new in this chapter) ---
  {
    name: "save_memory",
    description:
      "Save a note to memory that persists across sessions. " +
      "Use for user preferences, project decisions, or important context.",
    inputSchema: z.object({
      content: z.string().describe("The note to save"),
    }),
    isConcurrencySafe: false,
    async call(input) {
      fs.mkdirSync(AGENT_DIR, { recursive: true });
      const content = input.content as string;
      const date = new Date().toISOString().split("T")[0];
      fs.appendFileSync(MEMORY_FILE, `\n- [${date}] ${content}`);
      return "Saved to memory.";
    },
  },
];

const apiTools: Anthropic.Tool[] = tools.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: zodToJsonSchema(t.inputSchema) as Anthropic.Tool["input_schema"],
}));

// --- Streaming agentic loop ---

async function agentLoop(messages: Anthropic.MessageParam[]): Promise<string> {
  let turns = 0;
  const maxTurns = 20;
  const systemPrompt = buildSystemPrompt();

  while (true) {
    turns++;
    if (turns > maxTurns) return "[max turns reached]";

    const stream = client.messages.stream({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: systemPrompt,
      tools: apiTools,
      messages,
    });

    const contentBlocks: any[] = [];
    let currentBlockType: string | null = null;
    let currentToolInput = "";
    let currentToolId = "";
    let currentToolName = "";
    let currentTextIndex = -1;

    for await (const event of stream) {
      switch (event.type) {
        case "content_block_start":
          if (event.content_block.type === "text") {
            currentBlockType = "text";
            currentTextIndex = contentBlocks.length;
            contentBlocks.push({ type: "text", text: "" });
          } else if (event.content_block.type === "tool_use") {
            currentBlockType = "tool_use";
            currentToolId = event.content_block.id;
            currentToolName = event.content_block.name;
            currentToolInput = "";
          }
          break;
        case "content_block_delta":
          if (event.delta.type === "text_delta") {
            process.stdout.write(event.delta.text);
            if (currentTextIndex >= 0) contentBlocks[currentTextIndex].text += event.delta.text;
          } else if (event.delta.type === "input_json_delta") {
            currentToolInput += event.delta.partial_json;
          }
          break;
        case "content_block_stop":
          if (currentBlockType === "tool_use") {
            try {
              contentBlocks.push({ type: "tool_use", id: currentToolId, name: currentToolName, input: currentToolInput ? JSON.parse(currentToolInput) : {} });
            } catch {
              contentBlocks.push({ type: "tool_use", id: currentToolId, name: currentToolName, input: {} });
            }
            currentToolInput = "";
          }
          currentBlockType = null;
          break;
      }
    }

    // Save assistant message
    const assistantMsg: Anthropic.MessageParam = { role: "assistant", content: contentBlocks };
    messages.push(assistantMsg);
    saveMessage(assistantMsg);

    const toolBlocks = contentBlocks.filter((b: any) => b.type === "tool_use") as Anthropic.ToolUseBlock[];
    if (toolBlocks.length === 0) {
      process.stdout.write("\n");
      return contentBlocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    }

    // Execute tools
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolBlocks) {
      const tool = tools.find(t => t.name === toolUse.name);
      if (!tool) {
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: `Unknown: ${toolUse.name}`, is_error: true });
        continue;
      }
      const parsed = tool.inputSchema.safeParse(toolUse.input);
      if (!parsed.success) {
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: `Invalid: ${parsed.error.message}`, is_error: true });
        continue;
      }
      console.log(`  [tool] ${toolUse.name}(${JSON.stringify(toolUse.input).slice(0, 80)})`);
      try {
        const result = await tool.call(parsed.data);
        console.log(`  [result] ${result.slice(0, 150)}${result.length > 150 ? "..." : ""}`);
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result });
      } catch (e: any) {
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: `Error: ${e.message}`, is_error: true });
      }
    }

    // Save tool results
    const toolResultMsg: Anthropic.MessageParam = { role: "user", content: toolResults };
    messages.push(toolResultMsg);
    saveMessage(toolResultMsg);
  }
}

// --- REPL ---
async function main() {
  const conversationHistory: Anthropic.MessageParam[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Check for project instructions
  const instructions = loadProjectInstructions();
  if (instructions) {
    console.log("Loaded project instructions from AGENT.md");
  }

  // Check for memory
  const memory = loadMemory();
  if (memory) {
    console.log("Loaded memory from previous sessions");
  }

  // Check for existing session
  const existingSession = loadSession();
  if (existingSession.length > 0) {
    console.log(`Previous session found (${existingSession.length} messages). Type /resume to load it.`);
  }

  console.log("\nAgent with persistence. Commands:");
  console.log("  /resume  - Load previous session");
  console.log("  /new     - Start fresh (deletes saved session)");
  console.log("  /memory  - Show saved memory");
  console.log('  Try: "Remember that I prefer dark themes"\n');

  const ask = () => {
    rl.question("> ", async (input) => {
      const trimmed = input.trim();
      if (!trimmed) return ask();

      // Handle commands
      if (trimmed === "/resume") {
        const loaded = loadSession();
        if (loaded.length === 0) {
          console.log("No previous session found.\n");
        } else {
          conversationHistory.push(...loaded);
          console.log(`Loaded ${loaded.length} messages from previous session.\n`);
        }
        return ask();
      }

      if (trimmed === "/new") {
        clearSession();
        conversationHistory.length = 0;
        console.log("Started new session.\n");
        return ask();
      }

      if (trimmed === "/memory") {
        const mem = loadMemory();
        if (mem) {
          console.log(`Memory:\n${mem}\n`);
        } else {
          console.log("No memory saved yet.\n");
        }
        return ask();
      }

      // Save user message
      const userMsg: Anthropic.MessageParam = { role: "user", content: trimmed };
      conversationHistory.push(userMsg);
      saveMessage(userMsg);

      console.log("");
      await agentLoop(conversationHistory);
      console.log("");
      ask();
    });
  };
  ask();
}

main();

```
