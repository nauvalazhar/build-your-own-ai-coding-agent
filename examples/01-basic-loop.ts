import Anthropic from "@anthropic-ai/sdk";
import * as readline from "readline";

const client = new Anthropic();

// A simple tool so we can see the loop in action.
// The model can call this to "get the current time."
// In the next chapter, we will add real tools like file reading and searching.
const tools: Anthropic.Tool[] = [
  {
    name: "get_time",
    description: "Get the current date and time",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// Execute a tool by name.
// Right now we only have one tool. This will grow in later chapters.
function executeTool(name: string, _input: Record<string, unknown>): string {
  if (name === "get_time") {
    return new Date().toISOString();
  }
  return `Unknown tool: ${name}`;
}

// --- The agentic loop ---
// This is the core of everything. Call the model, check for tool use,
// execute tools, push results back, repeat.
async function agentLoop(
  conversationHistory: Anthropic.MessageParam[]
): Promise<string> {
  let turns = 0;
  const maxTurns = 20;

  while (true) {
    turns++;
    if (turns > maxTurns) {
      return "[max turns reached]";
    }

    // 1. Call the API with the full conversation history
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      tools,
      messages: conversationHistory,
    });

    // 2. Add the assistant's response to conversation history
    conversationHistory.push({ role: "assistant", content: response.content });

    // 3. Check for tool use by looking at the content blocks.
    //    Do NOT check stop_reason. It is not always reliable.
    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    if (toolUseBlocks.length === 0) {
      // No tools called. The model is done. Extract text and return.
      const textBlocks = response.content.filter(
        (block): block is Anthropic.TextBlock => block.type === "text"
      );
      return textBlocks.map((b) => b.text).join("\n");
    }

    // 4. Execute each tool and collect results
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      console.log(`  [tool] ${toolUse.name}`);
      const result = executeTool(
        toolUse.name,
        toolUse.input as Record<string, unknown>
      );
      console.log(`  [result] ${result}`);

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result,
      });
    }

    // 5. Push tool results back as a user message.
    //    This is the key step. The model will see its own tool calls
    //    and the results on the next iteration.
    conversationHistory.push({ role: "user", content: toolResults });

    // 6. Continue the loop. The model will decide what to do next.
  }
}

// --- REPL ---
async function main() {
  const conversationHistory: Anthropic.MessageParam[] = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("Basic agentic loop. Type a message. Try 'what time is it?'");
  console.log("Press Ctrl+C to exit.\n");

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
