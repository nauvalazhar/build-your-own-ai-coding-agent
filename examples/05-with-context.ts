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
    let regex: RegExp;
    try { regex = new RegExp(input.pattern as string); }
    catch { return "Error: Invalid regex pattern."; }
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
