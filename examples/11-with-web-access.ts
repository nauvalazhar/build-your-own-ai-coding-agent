import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as readline from "readline";
import Turndown from "turndown";

const client = new Anthropic();

const SYSTEM_PROMPT = `You are a coding assistant. You can read, search, and edit local files. You can also fetch web pages to look up documentation or references.

# How to work
- Use list_files and search_files to find relevant local files before editing.
- Always read a file before editing it.
- Use web_fetch to look up documentation, API references, or error solutions online.
- Be concise.`;

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
const MAX_WEB_CONTENT = 50_000;

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

// --- URL cache ---
const urlCache = new Map<string, string>();

// --- Convert HTML to Markdown using Turndown ---
const turndown = new Turndown();

function htmlToMarkdown(html: string): string {
  return turndown.turndown(html);
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

  // --- Web fetch tool (new in this chapter) ---
  {
    name: "web_fetch",
    description:
      "Fetch a web page and return its text content. " +
      "Use this to look up documentation, API references, or error solutions.",
    inputSchema: z.object({
      url: z.string().describe("The URL to fetch"),
      prompt: z.string().describe("What to extract or focus on from the page"),
    }),
    isConcurrencySafe: true, // Fetching is read-only
    async call(input) {
      const url = input.url as string;
      const prompt = input.prompt as string;

      // Check cache
      const cacheKey = `${url}::${prompt}`;
      const cached = urlCache.get(cacheKey);
      if (cached) {
        console.log(`  [cache hit] ${url}`);
        return cached;
      }

      // Fetch the page
      try {
        const response = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; CodingAgent/1.0)" },
          signal: AbortSignal.timeout(15_000),
        });

        if (!response.ok) {
          return `Error: HTTP ${response.status} ${response.statusText}`;
        }

        const html = await response.text();
        const markdown = htmlToMarkdown(html);

        // Truncate if too long
        const truncated = markdown.length > MAX_WEB_CONTENT
          ? markdown.slice(0, MAX_WEB_CONTENT) + "\n\n[Content truncated]"
          : markdown;

        // Use a secondary model to extract relevant content
        console.log(`  [extracting] Applying prompt to ${markdown.length} chars...`);
        const extraction = await client.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 2048,
          system: "You are a content extractor. Given a web page and a prompt, extract only the relevant information. Be concise and focused. If the page does not contain relevant information, say so.",
          messages: [{
            role: "user",
            content: `Prompt: ${prompt}\n\nPage content (from ${url}):\n${truncated}`,
          }],
        });

        const result = extraction.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n");

        // Cache the result
        urlCache.set(cacheKey, result);
        return result;

      } catch (e: any) {
        if (e.name === "TimeoutError") {
          return `Error: Request timed out after 15 seconds for ${url}`;
        }
        return `Error fetching ${url}: ${e.message}`;
      }
    },
  },

  // --- Web search tool (new in this chapter) ---
  // Uses Anthropic's built-in server-side web search.
  // The search happens on Anthropic's servers. No external API key needed.
  {
    name: "web_search",
    description:
      "Search the web and return results with titles and URLs. " +
      "Use this to find documentation, solutions, or references online.",
    inputSchema: z.object({
      query: z.string().describe("The search query"),
    }),
    isConcurrencySafe: true,
    async call(input) {
      const query = input.query as string;

      try {
        // Make a separate API call with the server-side web search tool
        const response = await client.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          system: "Perform the web search and return the results.",
          tools: [
            { type: "web_search_20250305", name: "web_search", max_uses: 5 } as any,
          ],
          messages: [
            { role: "user", content: `Search the web for: ${query}` },
          ],
        });

        // Extract results from the response
        const parts: string[] = [];
        for (const block of response.content) {
          if ((block as any).type === "web_search_tool_result") {
            const content = (block as any).content;
            if (Array.isArray(content)) {
              for (const result of content) {
                parts.push(`- ${result.title}: ${result.url}`);
              }
            }
          } else if (block.type === "text") {
            parts.push(block.text);
          }
        }

        return parts.join("\n") || "No results found.";
      } catch (e: any) {
        return `Error searching: ${e.message}`;
      }
    },
  },
];

const apiTools: Anthropic.Tool[] = tools.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: zodToJsonSchema(t.inputSchema) as Anthropic.Tool["input_schema"],
}));

// --- Streaming agentic loop (from Chapter 9, with concurrency from Chapter 10) ---

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
      if (currentCalls.length > 0) batches.push({ calls: currentCalls, concurrent: currentConcurrent });
      currentCalls = [call];
      currentConcurrent = call.tool.isConcurrencySafe;
    }
  }
  if (currentCalls.length > 0) batches.push({ calls: currentCalls, concurrent: currentConcurrent });
  return batches;
}

async function executeToolCall(call: ToolCall): Promise<Anthropic.ToolResultBlockParam> {
  try {
    const result = await call.tool.call(call.input);
    return { type: "tool_result", tool_use_id: call.block.id, content: result };
  } catch (err: any) {
    return { type: "tool_result", tool_use_id: call.block.id, content: `Error: ${err.message}`, is_error: true };
  }
}

async function executeBatches(batches: Batch[]): Promise<Anthropic.ToolResultBlockParam[]> {
  const allResults: Anthropic.ToolResultBlockParam[] = [];
  for (const batch of batches) {
    if (batch.concurrent && batch.calls.length > 1) {
      console.log(`  [batch] ${batch.calls.length} tools concurrently`);
      const results = await Promise.all(batch.calls.map(executeToolCall));
      allResults.push(...results);
    } else {
      for (const call of batch.calls) {
        console.log(`  [tool] ${call.tool.name}(${JSON.stringify(call.block.input).slice(0, 80)})`);
        const result = await executeToolCall(call);
        const content = typeof result.content === "string" ? result.content : "";
        console.log(`  [result] ${content.slice(0, 150)}${content.length > 150 ? "..." : ""}`);
        allResults.push(result);
      }
    }
  }
  return allResults;
}

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

    const toolCalls: ToolCall[] = toolBlocks.map(block => {
      const tool = tools.find(t => t.name === block.name);
      return { block, tool: tool!, input: block.input as Record<string, unknown> };
    });

    const batches = partitionIntoBatches(toolCalls);
    const toolResults = await executeBatches(batches);
    messages.push({ role: "user", content: toolResults });
  }
}

// --- REPL ---
async function main() {
  const conversationHistory: Anthropic.MessageParam[] = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log("Agent with web access. Try:");
  console.log('  "Fetch https://example.com and tell me what it says"');
  console.log('  "Search the web for how to use React useEffect"');
  console.log('  "What is on the Anthropic docs homepage?"\n');

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
