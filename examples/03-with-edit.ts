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
