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
const PROJECT_INSTRUCTIONS_FILE = "CLAUDE.md";

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
    parts.push(`# Project Instructions (from CLAUDE.md)\n${instructions}`);
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
    console.log("Loaded project instructions from CLAUDE.md");
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
