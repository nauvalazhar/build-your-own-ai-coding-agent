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
