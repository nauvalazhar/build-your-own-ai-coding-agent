import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as readline from "readline";

const client = new Anthropic();

const SYSTEM_PROMPT = `You are a coding assistant. Use list_files and search_files to find files before editing. Always read a file before editing it. Be concise.`;

// --- Permission types ---
type PermissionDecision = "allow" | "ask" | "deny";
type PermissionMode = "default" | "plan" | "yolo";

let permissionMode: PermissionMode = "default";

interface PermissionRule {
  toolName: string;
  pattern?: string;
  decision: "allow" | "deny";
}

const rules: PermissionRule[] = [
  // Safe read-only commands are always allowed
  { toolName: "run_command", pattern: "^(ls|cat|echo|pwd|git status|git diff|git log|npm --version)", decision: "allow" },
  // Dangerous patterns are always denied
  { toolName: "run_command", pattern: "rm\\s+-rf\\s+/", decision: "deny" },
];

function checkRules(toolName: string, input: Record<string, unknown>): PermissionDecision | null {
  const inputStr = JSON.stringify(input);
  for (const rule of rules) {
    if (rule.toolName !== toolName) continue;
    if (rule.pattern && !new RegExp(rule.pattern).test(inputStr)) continue;
    return rule.decision;
  }
  return null;
}

function getEffectiveDecision(toolDecision: PermissionDecision, mode: PermissionMode): PermissionDecision {
  if (mode === "yolo") return "allow";
  if (mode === "plan" && toolDecision !== "allow") return "deny";
  return toolDecision;
}

// --- Tool interface (now with permissions) ---
interface Tool {
  name: string;
  description: string;
  inputSchema: z.ZodObject<any>;
  call(input: Record<string, unknown>): Promise<string>;
  checkPermissions(input: Record<string, unknown>): PermissionDecision;
}

const readTimestamps = new Map<string, number>();
const MAX_RESULT_CHARS = 10_000;

function truncateResult(result: string): string {
  if (result.length <= MAX_RESULT_CHARS) return result;
  return result.slice(0, MAX_RESULT_CHARS) + `\n[Truncated: ${result.length} chars]`;
}

function findActualString(fileContent: string, searchString: string): string | null {
  if (fileContent.includes(searchString)) return searchString;
  const normalize = (s: string) => s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
  const index = normalize(fileContent).indexOf(normalize(searchString));
  if (index !== -1) return fileContent.substring(index, index + searchString.length);
  return null;
}

// --- Tools with permission checks ---

const readFileTool: Tool = {
  name: "read_file",
  description: "Read a file with line numbers.",
  inputSchema: z.object({ file_path: z.string() }),
  checkPermissions() { return "allow"; }, // Reading is always safe
  async call(input) {
    const filePath = input.file_path as string;
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      readTimestamps.set(path.resolve(filePath), Date.now());
      return truncateResult(content.split("\n").map((line, i) => `${i + 1}\t${line}`).join("\n"));
    } catch (err: any) { return `Error: ${err.message}`; }
  },
};

const editFileTool: Tool = {
  name: "edit_file",
  description: "Edit a file by replacing old_string with new_string. Read first.",
  inputSchema: z.object({
    file_path: z.string(), old_string: z.string(),
    new_string: z.string(), replace_all: z.boolean().optional(),
  }),
  checkPermissions() { return "ask"; }, // Editing needs approval
  async call(input) {
    const { file_path, old_string, new_string, replace_all } = input as any;
    if (old_string === new_string) return "Error: strings identical.";
    if (!fs.existsSync(file_path)) return `Error: not found: ${file_path}`;
    const content = fs.readFileSync(file_path, "utf-8");
    const actual = findActualString(content, old_string);
    if (!actual) return "Error: old_string not found.";
    if (!replace_all && content.split(actual).length - 1 > 1)
      return "Error: multiple matches.";
    const resolved = path.resolve(file_path);
    const lastRead = readTimestamps.get(resolved);
    if (lastRead) { try { if (fs.statSync(file_path).mtimeMs > lastRead) return "Error: file changed since read."; } catch {} }
    const updated = replace_all ? content.split(actual).join(new_string) : content.replace(actual, new_string);
    fs.writeFileSync(file_path, updated);
    readTimestamps.set(resolved, Date.now());
    return `Edited ${file_path}`;
  },
};

const writeFileTool: Tool = {
  name: "write_file",
  description: "Create or overwrite a file.",
  inputSchema: z.object({ file_path: z.string(), content: z.string() }),
  checkPermissions() { return "ask"; }, // Writing needs approval
  async call(input) {
    const filePath = input.file_path as string;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, input.content as string);
    return `Written: ${filePath}`;
  },
};

const listFilesTool: Tool = {
  name: "list_files",
  description: "List files recursively.",
  inputSchema: z.object({ directory: z.string().optional() }),
  checkPermissions() { return "allow"; },
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
  description: "Search for a regex pattern in files.",
  inputSchema: z.object({ pattern: z.string(), directory: z.string().optional() }),
  checkPermissions() { return "allow"; },
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
            try { fs.readFileSync(full, "utf-8").split("\n").forEach((line, i) => {
              if (regex.test(line)) results.push(`${full}:${i + 1}: ${line.trim()}`);
            }); } catch {}
          }
        }
      } catch {}
    }
    search(dir);
    return truncateResult(results.slice(0, 50).join("\n") || "No matches.");
  },
};

const runCommandTool: Tool = {
  name: "run_command",
  description: "Run a shell command.",
  inputSchema: z.object({ command: z.string() }),
  checkPermissions(input) {
    const cmd = input.command as string;
    if (/^(ls|cat|echo|pwd|git\s+(status|diff|log)|npm\s+--version)/.test(cmd)) return "allow";
    return "ask";
  },
  async call(input) {
    try {
      return truncateResult(execSync(input.command as string, { encoding: "utf-8", timeout: 30_000, maxBuffer: 1024 * 1024 }) || "(no output)");
    } catch (err: any) { return `Error: ${err.stderr || err.message}`; }
  },
};

const tools: Tool[] = [readFileTool, editFileTool, writeFileTool, listFilesTool, searchFilesTool, runCommandTool];

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

function estimateTokens(messages: Anthropic.MessageParam[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") { chars += msg.content.length; }
    else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if ("text" in block && typeof block.text === "string") chars += block.text.length;
        else if ("content" in block && typeof block.content === "string") chars += block.content.length;
        else if ("input" in block) chars += JSON.stringify(block.input).length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

// --- Permission dialog ---
async function askUserPermission(
  toolName: string,
  input: Record<string, unknown>,
  rl: readline.Interface
): Promise<boolean> {
  const inputStr = JSON.stringify(input, null, 2).slice(0, 200);
  console.log(`\n  Permission required: ${toolName}`);
  console.log(`  Input: ${inputStr}`);

  return new Promise((resolve) => {
    rl.question("  Allow? [y]es / [n]o / [a]lways > ", (answer) => {
      const choice = answer.trim().toLowerCase();
      if (choice === "a" || choice === "always") {
        rules.push({ toolName, decision: "allow" });
        console.log(`  Rule added: always allow ${toolName}\n`);
        resolve(true);
      } else {
        resolve(choice === "y" || choice === "yes");
      }
    });
  });
}

// --- The agentic loop (with permissions) ---
async function agentLoop(
  conversationHistory: Anthropic.MessageParam[],
  rl: readline.Interface
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

    const tokenEstimate = estimateTokens(conversationHistory);
    console.log(`  [context] ~${tokenEstimate} tokens`);

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: apiTools,
      messages: conversationHistory,
    });

    conversationHistory.push({ role: "assistant", content: response.content });

    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    if (toolUseBlocks.length === 0) {
      return response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text).join("\n");
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      const tool = tools.find((t) => t.name === toolUse.name);
      if (!tool) {
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: `Unknown: ${toolUse.name}`, is_error: true });
        continue;
      }

      const parsed = tool.inputSchema.safeParse(toolUse.input);
      if (!parsed.success) {
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: `Invalid: ${parsed.error.message}`, is_error: true });
        continue;
      }

      // --- Permission check ---
      const ruleDecision = checkRules(tool.name, toolUse.input as Record<string, unknown>);
      const toolDecision = ruleDecision ?? tool.checkPermissions(toolUse.input as Record<string, unknown>);
      const finalDecision = getEffectiveDecision(toolDecision, permissionMode);

      if (finalDecision === "deny") {
        console.log(`  [denied] ${tool.name}`);
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: "Permission denied.", is_error: true });
        continue;
      }

      if (finalDecision === "ask") {
        const allowed = await askUserPermission(tool.name, toolUse.input as Record<string, unknown>, rl);
        if (!allowed) {
          console.log(`  [rejected] ${tool.name}`);
          toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: "Permission denied by user.", is_error: true });
          continue;
        }
      }

      // Execute the tool
      console.log(`  [tool] ${tool.name}(${JSON.stringify(toolUse.input).slice(0, 100)})`);
      const result = await tool.call(parsed.data);
      console.log(`  [result] ${result.slice(0, 150)}${result.length > 150 ? "..." : ""}`);
      toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result });
    }

    conversationHistory.push({ role: "user", content: toolResults });
  }
}

// --- REPL ---
async function main() {
  const conversationHistory: Anthropic.MessageParam[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(`Agent with permissions (mode: ${permissionMode}).`);
  console.log("Reads are auto-allowed. Edits and commands ask for permission.");
  console.log('Try: "Change the button color to red in sample-project"\n');

  const ask = () => {
    rl.question("> ", async (input) => {
      const trimmed = input.trim();
      if (!trimmed) return ask();
      if (trimmed === "/yolo") { permissionMode = "yolo"; console.log("Mode: yolo (allow all)\n"); return ask(); }
      if (trimmed === "/plan") { permissionMode = "plan"; console.log("Mode: plan (read-only)\n"); return ask(); }
      if (trimmed === "/default") { permissionMode = "default"; console.log("Mode: default\n"); return ask(); }

      conversationHistory.push({ role: "user", content: trimmed });
      console.log("");
      const response = await agentLoop(conversationHistory, rl);
      console.log(`\n${response}\n`);
      ask();
    });
  };
  ask();
}

main();
