# Chapter 4: System Prompts

## The problem

Our agent can search, read, and edit files. But it does not always make smart choices. Sometimes it guesses file paths instead of searching. Sometimes it tries to edit a file without reading it first. Sometimes it jumps to conclusions based on the file name without understanding the code.

The model is powerful, but it needs instructions on *how* to use that power. That is what the system prompt does.

## What is a system prompt?

When you call an LLM API, you can send three kinds of content:

- **System prompt**: Instructions that define how the model should behave. The model reads these before anything else. Think of it as the model's job description.
- **User messages**: What the user says.
- **Assistant messages**: What the model previously said (conversation history).

The system prompt is where you put rules like "always read a file before editing it" or "be concise." The user never sees the system prompt. The model sees it on every API call.

A simple example:

```typescript
const response = await client.messages.create({
  model: "claude-sonnet-4-20250514",
  max_tokens: 4096,
  system: "You are a coding assistant. Be concise.",  // <-- system prompt
  messages: conversationHistory,
});
```

That one line changes how the model responds. Without it, the model is a general assistant. With it, the model knows it is a coding assistant and should keep things short. The more specific your instructions, the more predictable the behavior.

## Walkthrough: How does the model know which file to edit?

A user types: "Fix the login bug."

Without a system prompt, the model might do this:

```
Turn 1: edit_file({ file_path: "src/login.js", old_string: "...", new_string: "..." })
        Error: File not found
Turn 2: edit_file({ file_path: "src/Login.tsx", old_string: "...", new_string: "..." })
        Error: File not found
Turn 3: "I couldn't find the login file. Can you tell me the path?"
```

It guessed. Twice. Then gave up.

With a good system prompt, the same request looks like this:

```
Turn 1:  [tool] list_files({ directory: "src" })
         [result] src/App.tsx, src/pages/LoginPage.tsx, src/pages/Dashboard.tsx,
                  src/components/LoginForm.tsx, src/auth/useAuth.ts, ...

Turn 2:  [tool] search_files({ pattern: "login|Login", directory: "src" })
         [result] src/pages/LoginPage.tsx:5: export function LoginPage() {
                  src/components/LoginForm.tsx:3: export function LoginForm() {
                  src/auth/useAuth.ts:12: async function login(email, password) {

Turn 3:  [tool] read_file({ file_path: "src/components/LoginForm.tsx" })
         [result] (file contents...)

Turn 4:  [tool] read_file({ file_path: "src/auth/useAuth.ts" })
         [result] (file contents...)

Turn 5:  [tool] edit_file({ file_path: "src/auth/useAuth.ts", ... })
         [result] Edited src/auth/useAuth.ts

Turn 6:  [text] "I found the bug in useAuth.ts. The login function was not..."
```

The model started broad (list files), narrowed down (search for "login"), read the relevant files, and then made its edit. It went from 12 candidate files to 3 matches to 2 reads to 1 edit. A search funnel.

The difference? The system prompt told it: "Search before assuming. Read before editing."

## The three rules that matter most

After studying how production AI coding agents work, three rules make the biggest difference:

### 1. Read before edit

> "Do not propose changes to code you have not read. If a user asks you to modify a file, read it first. Understand existing code before suggesting modifications."

This prevents the model from guessing what is in a file. It forces the model to look at the actual code before making changes. The model's training data does not contain your code. It has to read it.

### 2. Search before assuming

> "Use list_files and search_files to find things instead of guessing paths. Never assume a file exists at a specific path."

File paths are the number one thing the model gets wrong. It knows common patterns (`src/components/Button.tsx`) but your project might use `app/ui/button.component.ts` or `lib/Button/index.js`. Searching is always better than guessing.

### 3. Understand before modifying

> "When given a task, first explore the codebase to understand the relevant files and patterns. Then make your changes."

This prevents the model from making changes that conflict with existing patterns. If your project uses Tailwind and the model adds inline styles, that is a bad edit even if it "works."

## Building the system prompt

Here is a complete system prompt that covers the essential behaviors:

```typescript
const SYSTEM_PROMPT = `You are a coding assistant that helps users with software engineering tasks. You have access to tools for reading, searching, editing files, and running commands.

# How to work

- When given a task, start by understanding the codebase. Use list_files and search_files to find relevant files before making changes.
- Always read a file before editing it. Never guess what is in a file.
- Use search_files to find code patterns, function definitions, and usage across the project.
- When you find multiple candidate files, read them to understand which one is relevant to the task.

# How to edit files

- Use the edit_file tool for modifications. Provide enough context in old_string to make the match unique.
- For new files, use write_file.
- After making edits, verify your changes make sense in context.

# How to handle ambiguity

- If the user's request is ambiguous (e.g., "fix the button" when there are multiple buttons), ask which one they mean.
- If you are unsure about the right approach, explain your plan before making changes.

# Communication

- Be concise. Show what you changed, not everything you considered.
- When reporting edits, mention the file path and what was changed.`;
```

This is about 50 lines. Production agents have system prompts that are thousands of lines, covering edge cases, safety rules, output formatting, and more. But these 50 lines give you 80% of the benefit.

## What each section does

**"How to work"** is the most important section. It tells the model to search and read before acting. Without it, the model skips straight to editing and often fails.

**"How to edit files"** gives the model specific guidance on using the edit tool. "Provide enough context in old_string" directly reduces the "multiple matches" error we covered in Chapter 3.

**"How to handle ambiguity"** prevents the model from making assumptions. "Fix the button" is a common kind of request. If there are three buttons, the model should ask which one, not guess.

**"Communication"** keeps the output focused. Without this, the model tends to explain every single step in detail, which gets noisy.

## The system prompt is sent every turn

One thing to remember: the agentic loop makes multiple API calls per user message (one for each tool call cycle). The system prompt is sent with every one of those calls. The model sees it fresh each time. This means your rules are always in front of the model, even on turn 15 of a long conversation.

## Adding tool-specific hints

You can also add hints in each tool's description. These are smaller, focused instructions that the model sees when deciding which tool to use:

```typescript
const readFileTool = {
  name: "read_file",
  description:
    "Read the contents of a file. Always read a file before editing it. " +
    "Returns the file content with line numbers.",
  // ...
};

const editFileTool = {
  name: "edit_file",
  description:
    "Edit a file by replacing old_string with new_string. " +
    "The old_string must appear exactly once in the file. " +
    "Include enough surrounding context to make the match unique. " +
    "You must read a file before editing it.",
  // ...
};
```

The "You must read a file before editing it" hint in the edit tool description reinforces the system prompt rule. The model sees this hint right when it is considering an edit. Double reinforcement.

## The search funnel

The system prompt creates a pattern we can call the "search funnel." It works like this:

```
list_files (broad)     ->  12 files found
search_files (narrow)  ->  3 files match
read_file (confirm)    ->  1 file is the right one
edit_file (act)        ->  done
```

The model starts broad and narrows down. Each step reduces uncertainty. By the time it makes an edit, it knows exactly what it is editing and why.

Without the system prompt, the model skips the funnel and jumps straight to editing. Sometimes it gets lucky. Most of the time it does not.

## What is still missing

The system prompt helps the model behave correctly on each turn. But what about across turns? If the model read a file 10 turns ago, does it remember? How does context carry over between turns? That is what we will cover in the next chapter.

## Running the example

```bash
npm run example:04
```

Try prompts like:
- "Fix the button" (it should ask which button or search first)
- "What components does this project have?" (it should list and read files)
- "Change the heading size to text-4xl in sample-project" (it should search, read, then edit)

## The full code

Here is everything from this chapter in one file (`examples/04-with-system-prompt.ts`):

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as readline from "readline";

const client = new Anthropic();

// --- The system prompt ---
// This is what shapes the model's behavior. Without it, the model guesses
// file paths and edits files it has not read. With it, the model searches
// first, reads first, and works methodically.

const SYSTEM_PROMPT = `You are a coding assistant that helps users with software engineering tasks. You have access to tools for reading, searching, editing files, and running commands.

# How to work

- When given a task, start by understanding the codebase. Use list_files and search_files to find relevant files before making changes.
- Always read a file before editing it. Never guess what is in a file.
- Use search_files to find code patterns, function definitions, and usage across the project.
- When you find multiple candidate files, read them to understand which one is relevant to the task.

# How to edit files

- Use the edit_file tool for modifications. Provide enough context in old_string to make the match unique.
- For new files, use write_file.
- After making edits, verify your changes make sense in context.

# How to handle ambiguity

- If the user's request is ambiguous (e.g., "fix the button" when there are multiple buttons), ask which one they mean.
- If you are unsure about the right approach, explain your plan before making changes.

# Communication

- Be concise. Show what you changed, not everything you considered.
- When reporting edits, mention the file path and what was changed.`;

// --- Tool interface ---
interface Tool {
  name: string;
  description: string;
  inputSchema: z.ZodObject<any>;
  call(input: Record<string, unknown>): Promise<string>;
}

// --- File read timestamps for staleness detection ---
const readTimestamps = new Map<string, number>();

function findActualString(
  fileContent: string,
  searchString: string
): string | null {
  if (fileContent.includes(searchString)) return searchString;
  const normalize = (s: string) =>
    s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
  const index = normalize(fileContent).indexOf(normalize(searchString));
  if (index !== -1)
    return fileContent.substring(index, index + searchString.length);
  return null;
}

// --- Tools ---
// Same implementations as Chapter 3, with hints added to descriptions.

const readFileTool: Tool = {
  name: "read_file",
  description:
    "Read a file's contents with line numbers. Always read a file before editing it.",
  inputSchema: z.object({
    file_path: z.string().describe("The path to the file to read"),
  }),
  async call(input) {
    const filePath = input.file_path as string;
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      readTimestamps.set(path.resolve(filePath), Date.now());
      const lines = content.split("\n");
      return lines.map((line, i) => `${i + 1}\t${line}`).join("\n");
    } catch (err: any) {
      return `Error reading file: ${err.message}`;
    }
  },
};

const editFileTool: Tool = {
  name: "edit_file",
  description:
    "Edit a file by replacing old_string with new_string. " +
    "old_string must match exactly once (unless replace_all is true). " +
    "Include enough surrounding context in old_string to make the match unique. " +
    "You must read a file before editing it.",
  inputSchema: z.object({
    file_path: z.string().describe("The path to the file to edit"),
    old_string: z.string().describe("The exact text to find"),
    new_string: z.string().describe("The replacement text"),
    replace_all: z.boolean().optional().describe("Replace all occurrences"),
  }),
  async call(input) {
    const filePath = input.file_path as string;
    const oldString = input.old_string as string;
    const newString = input.new_string as string;
    const replaceAll = (input.replace_all as boolean) || false;

    if (oldString === newString)
      return "Error: old_string and new_string are identical.";
    if (!fs.existsSync(filePath)) return `Error: File not found: ${filePath}`;

    const content = fs.readFileSync(filePath, "utf-8");
    const actualString = findActualString(content, oldString);
    if (!actualString) return "Error: old_string not found in file.";

    if (!replaceAll) {
      const count = content.split(actualString).length - 1;
      if (count > 1)
        return `Error: Found ${count} matches. Include more context to make it unique, or set replace_all to true.`;
    }

    const resolvedPath = path.resolve(filePath);
    const lastRead = readTimestamps.get(resolvedPath);
    if (lastRead) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs > lastRead)
          return "Error: File modified since last read. Read it again first.";
      } catch {}
    }

    const updated = replaceAll
      ? content.split(actualString).join(newString)
      : content.replace(actualString, newString);
    fs.writeFileSync(filePath, updated);
    readTimestamps.set(resolvedPath, Date.now());
    return `Edited ${filePath}`;
  },
};

const writeFileTool: Tool = {
  name: "write_file",
  description: "Create or overwrite a file with the given content.",
  inputSchema: z.object({
    file_path: z.string().describe("The path to the file to write"),
    content: z.string().describe("The content to write"),
  }),
  async call(input) {
    const filePath = input.file_path as string;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, input.content as string);
    return `File written: ${filePath}`;
  },
};

const listFilesTool: Tool = {
  name: "list_files",
  description:
    "List files in a directory recursively. Use this to explore the codebase before reading specific files.",
  inputSchema: z.object({
    directory: z.string().optional().describe("Directory to list."),
  }),
  async call(input) {
    const dir = (input.directory as string) || ".";
    const files: string[] = [];
    function walk(d: string) {
      try {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) walk(full);
          else files.push(full);
        }
      } catch {}
    }
    walk(dir);
    return files.join("\n") || "(empty directory)";
  },
};

const searchFilesTool: Tool = {
  name: "search_files",
  description:
    "Search for a regex pattern in files. Returns matching lines with paths and line numbers. Use this to find code patterns and narrow down which files to read.",
  inputSchema: z.object({
    pattern: z.string().describe("Regex pattern to search for"),
    directory: z.string().optional().describe("Directory to search."),
  }),
  async call(input) {
    const dir = (input.directory as string) || ".";
    const regex = new RegExp(input.pattern as string);
    const results: string[] = [];
    function search(d: string) {
      try {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) {
            search(full);
          } else {
            try {
              const lines = fs.readFileSync(full, "utf-8").split("\n");
              lines.forEach((line, i) => {
                if (regex.test(line))
                  results.push(`${full}:${i + 1}: ${line.trim()}`);
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
  description:
    "Run a shell command. Use this for tasks like running tests, installing packages, or checking git status.",
  inputSchema: z.object({
    command: z.string().describe("The shell command to run"),
  }),
  async call(input) {
    try {
      const output = execSync(input.command as string, {
        encoding: "utf-8",
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      return output || "(no output)";
    } catch (err: any) {
      return `Error (exit code ${err.status ?? "unknown"}): ${err.stderr || err.message}`;
    }
  },
};

const tools: Tool[] = [
  readFileTool,
  editFileTool,
  writeFileTool,
  listFilesTool,
  searchFilesTool,
  runCommandTool,
];

// --- Zod to JSON Schema ---
function zodToJsonSchema(schema: z.ZodObject<any>): Record<string, unknown> {
  const shape = schema.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    const zodValue = value as z.ZodTypeAny;
    const isOptional = zodValue.isOptional();
    const innerType = isOptional
      ? (zodValue as z.ZodOptional<any>)._def.innerType
      : zodValue;
    const isBoolean = innerType instanceof z.ZodBoolean;
    properties[key] = {
      type: isBoolean ? "boolean" : "string",
      description: innerType._def.description || "",
    };
    if (!isOptional) required.push(key);
  }
  return { type: "object", properties, required };
}

// --- The agentic loop (now with system prompt) ---
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

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: SYSTEM_PROMPT, // <-- The system prompt shapes behavior
      tools: apiTools,
      messages: conversationHistory,
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
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Unknown tool: ${toolUse.name}`,
          is_error: true,
        });
        continue;
      }

      const parsed = tool.inputSchema.safeParse(toolUse.input);
      if (!parsed.success) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Invalid input: ${parsed.error.message}`,
          is_error: true,
        });
        continue;
      }

      const inputSummary = JSON.stringify(toolUse.input).slice(0, 100);
      console.log(`  [tool] ${toolUse.name}(${inputSummary})`);

      const result = await tool.call(parsed.data);
      const truncated =
        result.length > 200
          ? result.slice(0, 200) + `... (${result.length} chars)`
          : result;
      console.log(`  [result] ${truncated}`);

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result,
      });
    }

    conversationHistory.push({ role: "user", content: toolResults });
  }
}

// --- REPL ---
async function main() {
  const conversationHistory: Anthropic.MessageParam[] = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("Agent with system prompt. Try:");
  console.log('  "What components does sample-project have?"');
  console.log('  "Change the heading size to text-4xl in sample-project"');
  console.log('  "Fix the button" (it should ask which button)\n');

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
