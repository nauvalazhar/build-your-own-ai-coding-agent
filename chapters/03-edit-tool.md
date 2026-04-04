# Chapter 3: The Edit Tool

## The problem

The model can read files now. But how does it edit them?

You might expect something complex. Maybe it parses the code into an AST (abstract syntax tree) and manipulates nodes. Maybe it uses a diff algorithm. Maybe it works with line numbers and inserts or deletes specific lines.

It does none of that. It uses `string.replace()`. That is the whole thing.

## Walkthrough: "Change the button color to red"

The user types: "Change the button color to red in the sample project."

Here is what happens:

```
Turn 1:
  [tool] list_files({ directory: "sample-project/src" })
  [result] sample-project/src/App.tsx
           sample-project/src/components/Button.tsx
           sample-project/src/components/Header.tsx

Turn 2:
  [tool] read_file({ file_path: "sample-project/src/components/Button.tsx" })
  [result] 1   interface ButtonProps {
           2     label?: string;
           3     onClick?: () => void;
           4   }
           5
           6   export function Button({ label = "Get Started", onClick }: ButtonProps) {
           7     return (
           8       <button
           9         onClick={onClick}
           10        className="bg-blue-500 text-white px-6 py-2 rounded-lg hover:bg-blue-600"
           11      >
           12        {label}
           13      </button>
           14    );
           15  }

Turn 3:
  [tool] edit_file({
    file_path: "sample-project/src/components/Button.tsx",
    old_string: "bg-blue-500 text-white px-6 py-2 rounded-lg hover:bg-blue-600",
    new_string: "bg-red-500 text-white px-6 py-2 rounded-lg hover:bg-red-600"
  })
  [result] Edited sample-project/src/components/Button.tsx

Turn 4:
  [text] "I changed the button color from blue to red..."
```

The model searched for files, read the button component, and replaced the old string with a new one. Under the hood, this is what the edit tool did:

```typescript
const updated = fileContent.replace(oldString, newString);
fs.writeFileSync(filePath, updated);
```

That is it. `string.replace()`.

One small detail: production implementations use a callback function for the replacement (`content.replace(search, () => replace)`) instead of passing the string directly. This prevents JavaScript from interpreting special patterns like `$1` or `$&` in the replacement string. If the user's new code happens to contain `$1`, you do not want it treated as a regex capture group reference.

## Why string.replace() works

It seems too simple, but there are good reasons this approach won:

**Line numbers drift.** If you edit line 10, every line after it shifts. If the model wants to make two edits, the second edit's line numbers are now wrong. String replacement does not have this problem. It finds the exact text regardless of where it is.

**AST parsing is language-specific.** You would need a different parser for JavaScript, Python, Rust, HTML, CSS, YAML, Markdown, and every other language. String replacement works on any file. Even binary config files.

**The model is good at it.** Language models are naturally good at outputting exact text. "Find this string and replace it with that string" is a task they handle well.

## The uniqueness problem

There is one catch. What if the string appears more than once?

```tsx
// This file has two buttons, both with bg-blue-500
<button className="bg-blue-500">Save</button>
<button className="bg-blue-500">Cancel</button>
```

If the model sends `old_string: "bg-blue-500"`, which one do we replace? We do not know. So we reject the edit.

The rule is simple: **the old_string must appear exactly once in the file.** If it appears zero times, the string was not found. If it appears more than once, the match is ambiguous. Both are errors.

```typescript
const editFileTool: Tool = {
  name: "edit_file",
  description:
    "Edit a file by replacing old_string with new_string. " +
    "The old_string must appear exactly once in the file. " +
    "Include enough surrounding context to make the match unique.",
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
    const content = fs.readFileSync(filePath, "utf-8");

    // Count occurrences
    const count = content.split(oldString).length - 1;

    if (count === 0) {
      return "Error: The old_string was not found in the file.";
    }

    if (count > 1) {
      return `Error: Found ${count} matches. Include more surrounding context to make the match unique.`;
    }

    // Exactly one match. Safe to replace.
    const updated = content.replace(oldString, newString);
    fs.writeFileSync(filePath, updated);
    return `Edited ${filePath}`;
  },
};
```

When the model gets the "Found 3 matches" error, it knows it needs to include more surrounding context. Instead of just `"bg-blue-500"`, it would send:

```json
{
  "old_string": "<button className=\"bg-blue-500\">Save</button>",
  "new_string": "<button className=\"bg-red-500\">Save</button>"
}
```

Now the match is unique. The edit goes through.

There is also a `replace_all` option for when you actually want to replace every occurrence. But the default is to require uniqueness. This prevents accidental edits.

## The validation flow

```mermaid
flowchart TD
    A[edit_file called] --> B{File exists?}
    B -->|No| C[Error: file not found]
    B -->|Yes| D{old_string found?}
    D -->|No| E[Error: string not found]
    D -->|Yes| F{Exactly one match?}
    F -->|No| G[Error: multiple matches, need more context]
    F -->|Yes| H{File changed since last read?}
    H -->|Yes| I[Error: file is stale, read it again]
    H -->|No| J[Apply string.replace and save]
```

## Quote normalization

Here is a subtle problem. Sometimes the model outputs curly quotes ( \u201c \u201d ) instead of straight quotes ( " ). This happens because the model was trained on text that uses curly quotes. If the file has straight quotes and the model sends curly quotes, the match fails even though the text "looks" the same.

The fix: try the exact match first. If it fails, normalize both the search string and the file content (convert all curly quotes to straight quotes), and try again. If the normalized version matches, use the position from the normalized match to find the original text in the file.

```typescript
function findActualString(fileContent: string, searchString: string): string | null {
  // Try exact match first
  if (fileContent.includes(searchString)) {
    return searchString;
  }

  // Try with normalized quotes
  const normalize = (s: string) =>
    s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');

  const normalizedFile = normalize(fileContent);
  const normalizedSearch = normalize(searchString);

  const index = normalizedFile.indexOf(normalizedSearch);
  if (index !== -1) {
    // Return the original text from the file (with its original quotes)
    return fileContent.substring(index, index + searchString.length);
  }

  return null;
}
```

This is a small thing, but it prevents a lot of frustrating failures where the edit "should" work but does not.

## Staleness detection

What if the user edits the file manually while the agent is working? The model read the file five turns ago. It has the old version in its context. It sends an edit based on the old version. But the file on disk has changed.

If we apply the edit, we might overwrite the user's changes. That is bad.

The fix: track when the model last read each file. Before applying an edit, check if the file has been modified since then. If it has, reject the edit and tell the model to read the file again.

```typescript
// Track when each file was last read by the model
const readTimestamps = new Map<string, number>();

// In the read_file tool:
readTimestamps.set(filePath, Date.now());

// In the edit_file tool:
const lastRead = readTimestamps.get(filePath);
if (lastRead) {
  const stat = fs.statSync(filePath);
  if (stat.mtimeMs > lastRead) {
    return "Error: File has been modified since you last read it. Read it again first.";
  }
}
```

This is a simple version. Production agents go further: they also compare the file content (not just the timestamp) because some systems update timestamps without actually changing the content (cloud sync, antivirus scans). The full check is: if the timestamp changed, compare the content too. Only reject if the content actually differs.

## What is still missing

The model can now search, read, and edit files. But it does not always make smart choices. Sometimes it guesses file paths instead of searching. Sometimes it tries to edit a file it has not read. In the next chapter, we will fix this with a system prompt that teaches the model how to behave.

## Running the example

```bash
npm run example:03
```

Try prompts like:
- "Change the button color to red in the sample project"
- "Change the header title default from 'My App' to 'Hello World' in the sample project"
- "Change the heading size from text-2xl to text-4xl in the sample project"

## The full code

Here is everything from this chapter in one file (`examples/03-with-edit.ts`):

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as readline from "readline";

const client = new Anthropic();

// --- Tool interface (same as Chapter 2) ---
interface Tool {
  name: string;
  description: string;
  inputSchema: z.ZodObject<any>;
  call(input: Record<string, unknown>): Promise<string>;
}

// --- Track file read timestamps for staleness detection ---
const readTimestamps = new Map<string, number>();

// --- Quote normalization ---
// The model sometimes outputs curly quotes when the file has straight quotes.
// This function finds the actual string in the file, accounting for quote differences.
function findActualString(
  fileContent: string,
  searchString: string
): string | null {
  // Try exact match first
  if (fileContent.includes(searchString)) {
    return searchString;
  }

  // Try with normalized quotes
  const normalize = (s: string) =>
    s
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"');

  const normalizedFile = normalize(fileContent);
  const normalizedSearch = normalize(searchString);

  const index = normalizedFile.indexOf(normalizedSearch);
  if (index !== -1) {
    return fileContent.substring(index, index + searchString.length);
  }

  return null;
}

// --- Tool implementations ---

const readFileTool: Tool = {
  name: "read_file",
  description:
    "Read the contents of a file. Returns the file content with line numbers.",
  inputSchema: z.object({
    file_path: z.string().describe("The path to the file to read"),
  }),
  async call(input) {
    const filePath = input.file_path as string;
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      // Track when this file was read (for staleness detection)
      readTimestamps.set(path.resolve(filePath), Date.now());
      const lines = content.split("\n");
      return lines.map((line, i) => `${i + 1}\t${line}`).join("\n");
    } catch (err: any) {
      return `Error reading file: ${err.message}`;
    }
  },
};

// --- The edit tool ---
// This is the star of this chapter.
// It uses string.replace() with uniqueness validation.
const editFileTool: Tool = {
  name: "edit_file",
  description:
    "Edit a file by replacing old_string with new_string. " +
    "The old_string must appear exactly once in the file (unless replace_all is true). " +
    "Include enough surrounding context to make the match unique.",
  inputSchema: z.object({
    file_path: z.string().describe("The path to the file to edit"),
    old_string: z.string().describe("The exact text to find"),
    new_string: z
      .string()
      .describe("The text to replace it with (must be different from old_string)"),
    replace_all: z
      .boolean()
      .optional()
      .describe("Replace all occurrences. Defaults to false."),
  }),
  async call(input) {
    const filePath = input.file_path as string;
    const oldString = input.old_string as string;
    const newString = input.new_string as string;
    const replaceAll = (input.replace_all as boolean) || false;

    // 1. Check old_string != new_string
    if (oldString === newString) {
      return "Error: old_string and new_string are identical. No edit needed.";
    }

    // 2. Check file exists
    if (!fs.existsSync(filePath)) {
      return `Error: File not found: ${filePath}`;
    }

    // 3. Read the file
    const content = fs.readFileSync(filePath, "utf-8");

    // 4. Find the actual string (with quote normalization)
    const actualString = findActualString(content, oldString);
    if (!actualString) {
      return "Error: The old_string was not found in the file.";
    }

    // 5. Check uniqueness (unless replace_all)
    if (!replaceAll) {
      const count = content.split(actualString).length - 1;
      if (count > 1) {
        return (
          `Error: Found ${count} matches of the old_string. ` +
          `Include more surrounding context to make the match unique, ` +
          `or set replace_all to true.`
        );
      }
    }

    // 6. Check staleness
    const resolvedPath = path.resolve(filePath);
    const lastRead = readTimestamps.get(resolvedPath);
    if (lastRead) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs > lastRead) {
          return "Error: File has been modified since you last read it. Read the file again first.";
        }
      } catch {
        // If we cannot stat, proceed anyway
      }
    }

    // 7. Apply the edit
    const updated = replaceAll
      ? content.split(actualString).join(newString)
      : content.replace(actualString, newString);

    fs.writeFileSync(filePath, updated);

    // Update the read timestamp so the next edit does not fail the staleness check
    readTimestamps.set(resolvedPath, Date.now());

    return `Edited ${filePath}`;
  },
};

const writeFileTool: Tool = {
  name: "write_file",
  description:
    "Write content to a file. Creates parent directories if needed.",
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
    "List files in a directory recursively. Skips node_modules and hidden files.",
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
    "Search for a regex pattern in files. Returns matching lines with paths and line numbers.",
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
  description: "Run a shell command and return its output.",
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

// --- All tools ---
const tools: Tool[] = [
  readFileTool,
  editFileTool,
  writeFileTool,
  listFilesTool,
  searchFilesTool,
  runCommandTool,
];

// --- Zod to JSON Schema converter (simplified) ---
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

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
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

  console.log("Agent with edit tool. Try:");
  console.log('  "Change the button color to red in sample-project"');
  console.log('  "Change the header title to Hello World in sample-project"');
  console.log("");

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
