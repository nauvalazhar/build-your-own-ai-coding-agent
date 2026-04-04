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

In production agents, normalization is much more involved. Here are some common things it handles:

- **Orphaned tool calls.** If the model called a tool but the execution was interrupted (user cancelled, error, timeout), you have a `tool_use` block with no matching `tool_result`. The API rejects this. Normalization inserts a synthetic error result like `"[Tool result missing due to interruption]"` so the messages stay valid.

- **Consecutive same-role messages.** Some APIs require messages to alternate between `user` and `assistant`. If two user messages end up next to each other (e.g., a tool result followed by a new user prompt), they need to be merged into one.

- **Oversized tool results.** A file read that returned 10,000 lines is still in the conversation from 20 turns ago. Normalization can truncate or replace it with a summary. (We cover this in detail in the next chapter.)

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

## The full code

Here is everything from this chapter in one file (`examples/05-with-context.ts`):

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as readline from "readline";

const client = new Anthropic();

const SYSTEM_PROMPT = `You are a coding assistant that helps users with software engineering tasks.

# How to work
- Use list_files and search_files to find relevant files before making changes.
- Always read a file before editing it.
- Use search_files to find code patterns across the project.

# How to edit files
- Use edit_file for modifications. Provide enough context in old_string to be unique.
- For new files, use write_file.

# Communication
- Be concise. Mention file paths and what changed.`;

// --- Tool interface ---
interface Tool {
  name: string;
  description: string;
  inputSchema: z.ZodObject<any>;
  call(input: Record<string, unknown>): Promise<string>;
}

const readTimestamps = new Map<string, number>();

function findActualString(fileContent: string, searchString: string): string | null {
  if (fileContent.includes(searchString)) return searchString;
  const normalize = (s: string) =>
    s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
  const index = normalize(fileContent).indexOf(normalize(searchString));
  if (index !== -1) return fileContent.substring(index, index + searchString.length);
  return null;
}

// --- Tools (same as Chapter 4) ---

const readFileTool: Tool = {
  name: "read_file",
  description: "Read a file's contents with line numbers. Always read a file before editing it.",
  inputSchema: z.object({ file_path: z.string() }),
  async call(input) {
    const filePath = input.file_path as string;
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      readTimestamps.set(path.resolve(filePath), Date.now());
      return content.split("\n").map((line, i) => `${i + 1}\t${line}`).join("\n");
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  },
};

const editFileTool: Tool = {
  name: "edit_file",
  description: "Edit a file by replacing old_string with new_string. Must be a unique match. Read first.",
  inputSchema: z.object({
    file_path: z.string(),
    old_string: z.string(),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
  }),
  async call(input) {
    const { file_path, old_string, new_string, replace_all } = input as any;
    if (old_string === new_string) return "Error: strings are identical.";
    if (!fs.existsSync(file_path)) return `Error: File not found: ${file_path}`;

    const content = fs.readFileSync(file_path, "utf-8");
    const actual = findActualString(content, old_string);
    if (!actual) return "Error: old_string not found in file.";

    if (!replace_all) {
      const count = content.split(actual).length - 1;
      if (count > 1) return `Error: Found ${count} matches. Add more context or set replace_all.`;
    }

    const resolved = path.resolve(file_path);
    const lastRead = readTimestamps.get(resolved);
    if (lastRead) {
      try {
        if (fs.statSync(file_path).mtimeMs > lastRead)
          return "Error: File modified since last read. Read it again.";
      } catch {}
    }

    const updated = replace_all
      ? content.split(actual).join(new_string)
      : content.replace(actual, new_string);
    fs.writeFileSync(file_path, updated);
    readTimestamps.set(resolved, Date.now());
    return `Edited ${file_path}`;
  },
};

const writeFileTool: Tool = {
  name: "write_file",
  description: "Create or overwrite a file.",
  inputSchema: z.object({ file_path: z.string(), content: z.string() }),
  async call(input) {
    const filePath = input.file_path as string;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, input.content as string);
    return `File written: ${filePath}`;
  },
};

const listFilesTool: Tool = {
  name: "list_files",
  description: "List files recursively. Use to explore before reading.",
  inputSchema: z.object({ directory: z.string().optional() }),
  async call(input) {
    const dir = (input.directory as string) || ".";
    const files: string[] = [];
    function walk(d: string) {
      try {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) walk(full); else files.push(full);
        }
      } catch {}
    }
    walk(dir);
    return files.join("\n") || "(empty)";
  },
};

const searchFilesTool: Tool = {
  name: "search_files",
  description: "Search for a regex pattern in files. Returns matching lines.",
  inputSchema: z.object({ pattern: z.string(), directory: z.string().optional() }),
  async call(input) {
    const dir = (input.directory as string) || ".";
    const regex = new RegExp(input.pattern as string);
    const results: string[] = [];
    function search(d: string) {
      try {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) { search(full); } else {
            try {
              fs.readFileSync(full, "utf-8").split("\n").forEach((line, i) => {
                if (regex.test(line)) results.push(`${full}:${i + 1}: ${line.trim()}`);
              });
            } catch {}
          }
        }
      } catch {}
    }
    search(dir);
    return results.slice(0, 50).join("\n") || "No matches found.";
  },
};

const runCommandTool: Tool = {
  name: "run_command",
  description: "Run a shell command.",
  inputSchema: z.object({ command: z.string() }),
  async call(input) {
    try {
      return execSync(input.command as string, { encoding: "utf-8", timeout: 30_000, maxBuffer: 1024 * 1024 }) || "(no output)";
    } catch (err: any) {
      return `Error: ${err.stderr || err.message}`;
    }
  },
};

const tools: Tool[] = [readFileTool, editFileTool, writeFileTool, listFilesTool, searchFilesTool, runCommandTool];

// --- Zod to JSON Schema ---
function zodToJsonSchema(schema: z.ZodObject<any>): Record<string, unknown> {
  const shape = schema.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    const zodValue = value as z.ZodTypeAny;
    const isOptional = zodValue.isOptional();
    const innerType = isOptional ? (zodValue as z.ZodOptional<any>)._def.innerType : zodValue;
    const isBoolean = innerType instanceof z.ZodBoolean;
    properties[key] = { type: isBoolean ? "boolean" : "string", description: innerType._def.description || "" };
    if (!isOptional) required.push(key);
  }
  return { type: "object", properties, required };
}

// --- Token estimation ---
// A rough estimate: ~4 characters per token on average.
// This is not exact, but good enough for knowing when we are getting big.
function estimateTokens(messages: Anthropic.MessageParam[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if ("text" in block && typeof block.text === "string") {
          chars += block.text.length;
        } else if ("content" in block && typeof block.content === "string") {
          chars += block.content.length;
        } else if ("input" in block) {
          chars += JSON.stringify(block.input).length;
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}

// --- Message normalization ---
// Clean up messages before sending to the API.
// For now, just filter empty messages and log the token count.
function normalizeMessages(
  messages: Anthropic.MessageParam[]
): Anthropic.MessageParam[] {
  return messages.filter((msg) => {
    if (typeof msg.content === "string" && msg.content.trim() === "") return false;
    return true;
  });
}

// --- The agentic loop ---
async function agentLoop(
  conversationHistory: Anthropic.MessageParam[]
): Promise<string> {
  let turns = 0;
  const maxTurns = 20;

  const apiTools: Anthropic.Tool[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: zodToJsonSchema(tool.inputSchema) as Anthropic.Tool["input_schema"],
  }));

  while (true) {
    turns++;
    if (turns > maxTurns) return "[max turns reached]";

    // Normalize and estimate token count before sending
    const normalized = normalizeMessages(conversationHistory);
    const tokenEstimate = estimateTokens(normalized);
    console.log(`  [context] ~${tokenEstimate} tokens in ${normalized.length} messages`);

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: apiTools,
      messages: normalized,
    });

    conversationHistory.push({ role: "assistant", content: response.content });

    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    if (toolUseBlocks.length === 0) {
      const textBlocks = response.content.filter(
        (block): block is Anthropic.TextBlock => block.type === "text"
      );
      return textBlocks.map((b) => b.text).join("\n");
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      const tool = tools.find((t) => t.name === toolUse.name);
      if (!tool) {
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: `Unknown tool: ${toolUse.name}`, is_error: true });
        continue;
      }
      const parsed = tool.inputSchema.safeParse(toolUse.input);
      if (!parsed.success) {
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: `Invalid input: ${parsed.error.message}`, is_error: true });
        continue;
      }

      const inputSummary = JSON.stringify(toolUse.input).slice(0, 100);
      console.log(`  [tool] ${toolUse.name}(${inputSummary})`);

      const result = await tool.call(parsed.data);
      const truncated = result.length > 200 ? result.slice(0, 200) + `... (${result.length} chars)` : result;
      console.log(`  [result] ${truncated}`);

      toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result });
    }

    conversationHistory.push({ role: "user", content: toolResults });
  }
}

// --- REPL ---
async function main() {
  const conversationHistory: Anthropic.MessageParam[] = [];

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log("Agent with context tracking. Watch the token count grow.");
  console.log("Try a multi-turn conversation:");
  console.log('  1. "What files are in sample-project?"');
  console.log('  2. "Read the Button component"');
  console.log('  3. "Change the color to red"  (no re-read needed)\n');

  const ask = () => {
    rl.question("> ", async (input) => {
      const trimmed = input.trim();
      if (!trimmed) return ask();

      conversationHistory.push({ role: "user", content: trimmed });
      console.log("");
      const response = await agentLoop(conversationHistory);
      console.log(`\n${response}\n`);
      ask();
    });
  };

  ask();
}

main();

```
