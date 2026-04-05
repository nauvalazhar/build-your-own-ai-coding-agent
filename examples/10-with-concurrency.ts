// This example focuses on: concurrent tool execution (Chapter 10).
// Includes: tools (Ch2), edit (Ch3), system prompt (Ch4), streaming (Ch9).
// Omits: permissions (Ch7), subagents (Ch8), compression (Ch6) to keep the code focused.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as readline from "readline";

const client = new Anthropic();

const SYSTEM_PROMPT = `You are a coding assistant. Use list_files and search_files to find files before editing. Always read before editing. Be concise.

When you need to read multiple files, call all the read_file tools at once in a single response. This lets them run in parallel.`;

// --- Types ---
interface Tool {
  name: string;
  description: string;
  inputSchema: z.ZodObject<any>;
  isConcurrencySafe: boolean; // New: can this tool run in parallel with others?
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
    properties[key] = { type: inner instanceof z.ZodBoolean ? "boolean" : "string", description: inner._def.description || "" };
    if (!opt) required.push(key);
  }
  return { type: "object", properties, required };
}

// --- Tools (with concurrency flag) ---
const tools: Tool[] = [
  {
    name: "read_file", description: "Read a file with line numbers.",
    inputSchema: z.object({ file_path: z.string() }),
    isConcurrencySafe: true, // Reading is safe to parallelize
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
    name: "edit_file", description: "Edit a file by replacing old_string with new_string.",
    inputSchema: z.object({ file_path: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() }),
    isConcurrencySafe: false, // Editing is NOT safe to parallelize
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
    name: "write_file", description: "Create or overwrite a file.",
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
    name: "list_files", description: "List files recursively.",
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
    name: "search_files", description: "Search for a regex pattern in files.",
    inputSchema: z.object({ pattern: z.string(), directory: z.string().optional() }),
    isConcurrencySafe: true,
    async call(input) {
      const dir = (input.directory as string) || ".";
      let rx: RegExp;
      try { rx = new RegExp(input.pattern as string); }
      catch { return "Error: Invalid regex pattern."; }
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
    name: "run_command", description: "Run a shell command.",
    inputSchema: z.object({ command: z.string() }),
    isConcurrencySafe: false, // Commands can change state
    async call(input) {
      try {
        return truncateResult(execSync(input.command as string, { encoding: "utf-8", timeout: 30_000, maxBuffer: 1024 * 1024 }) || "(no output)");
      } catch (e: any) { return `Error: ${e.stderr || e.message}`; }
    },
  },
];

const apiTools: Anthropic.Tool[] = tools.map((t) => ({
  name: t.name, description: t.description,
  input_schema: zodToJsonSchema(t.inputSchema) as Anthropic.Tool["input_schema"],
}));

// --- Batch partitioning ---
// Groups consecutive concurrent-safe tools into parallel batches.
// Non-safe tools each become their own serial batch.

interface ToolCall {
  block: Anthropic.ToolUseBlock;
  tool: Tool;
  input: Record<string, unknown>;
}

interface Batch {
  calls: ToolCall[];
  concurrent: boolean;
}

function partitionIntoBatches(toolCalls: ToolCall[]): Batch[] {
  const batches: Batch[] = [];
  let currentCalls: ToolCall[] = [];
  let currentConcurrent = true;

  for (const call of toolCalls) {
    if (call.tool.isConcurrencySafe && currentConcurrent) {
      currentCalls.push(call);
    } else {
      if (currentCalls.length > 0) {
        batches.push({ calls: currentCalls, concurrent: currentConcurrent });
      }
      currentCalls = [call];
      currentConcurrent = call.tool.isConcurrencySafe;
    }
  }

  if (currentCalls.length > 0) {
    batches.push({ calls: currentCalls, concurrent: currentConcurrent });
  }

  return batches;
}

// --- Execute a single tool call ---
async function executeToolCall(call: ToolCall): Promise<Anthropic.ToolResultBlockParam> {
  try {
    const result = await call.tool.call(call.input);
    return { type: "tool_result", tool_use_id: call.block.id, content: result };
  } catch (err: any) {
    return { type: "tool_result", tool_use_id: call.block.id, content: `Error: ${err.message}`, is_error: true };
  }
}

// --- Execute batches with concurrency ---
async function executeBatches(batches: Batch[]): Promise<Anthropic.ToolResultBlockParam[]> {
  const allResults: Anthropic.ToolResultBlockParam[] = [];

  for (const batch of batches) {
    if (batch.concurrent && batch.calls.length > 1) {
      // Run all tools in this batch in parallel
      console.log(`  [batch] Executing ${batch.calls.length} tools concurrently`);
      for (const call of batch.calls) {
        console.log(`  [tool] ${call.tool.name}(${JSON.stringify(call.block.input).slice(0, 80)})`);
      }

      const results = await Promise.all(batch.calls.map(executeToolCall));

      for (let i = 0; i < results.length; i++) {
        const content = typeof results[i].content === "string" ? results[i].content as string : "";
        console.log(`  [result] ${batch.calls[i].tool.name}: ${content.slice(0, 100)}${content.length > 100 ? "..." : ""}`);
      }
      console.log(`  [batch] All ${batch.calls.length} completed`);

      allResults.push(...results);
    } else {
      // Run tools one at a time
      for (const call of batch.calls) {
        console.log(`  [tool] ${call.tool.name}(${JSON.stringify(call.block.input).slice(0, 80)})`);
        const result = await executeToolCall(call);
        const content = typeof result.content === "string" ? result.content as string : "";
        console.log(`  [result] ${content.slice(0, 100)}${content.length > 100 ? "..." : ""}`);
        allResults.push(result);
      }
    }
  }

  return allResults;
}

// --- Streaming agentic loop with concurrent tool execution ---

async function agentLoop(messages: Anthropic.MessageParam[]): Promise<string> {
  let turns = 0;
  const maxTurns = 20;

  while (true) {
    turns++;
    if (turns > maxTurns) return "[max turns reached]";

    const stream = client.messages.stream({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: apiTools,
      messages,
    });

    // Accumulate content blocks
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

    messages.push({ role: "assistant", content: contentBlocks });

    const toolBlocks = contentBlocks.filter((b: any) => b.type === "tool_use") as Anthropic.ToolUseBlock[];
    if (toolBlocks.length === 0) {
      process.stdout.write("\n");
      return contentBlocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    }

    // Prepare tool calls with their tool definitions
    const toolCalls: ToolCall[] = [];
    for (const block of toolBlocks) {
      const tool = tools.find((t) => t.name === block.name);
      if (!tool) {
        toolCalls.push({ block, tool: tools[0], input: {} }); // Will error
        continue;
      }
      const parsed = tool.inputSchema.safeParse(block.input);
      toolCalls.push({ block, tool, input: parsed.success ? parsed.data : {} });
    }

    // Partition into batches and execute with concurrency
    const batches = partitionIntoBatches(toolCalls);
    const toolResults = await executeBatches(batches);

    messages.push({ role: "user", content: toolResults });
  }
}

// --- REPL ---
async function main() {
  const conversationHistory: Anthropic.MessageParam[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log("Agent with concurrent tool execution.");
  console.log("Safe tools (read, search, list) run in parallel.");
  console.log('Try: "Read all three files in sample-project/src/components and sample-project/src/App.tsx"\n');

  const ask = () => {
    rl.question("> ", async (input) => {
      const trimmed = input.trim();
      if (!trimmed) return ask();
      conversationHistory.push({ role: "user", content: trimmed });
      console.log("");
      await agentLoop(conversationHistory);
      console.log("");
      ask();
    });
  };
  ask();
}

main();
