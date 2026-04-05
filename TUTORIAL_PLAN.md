# Tutorial Plan: Step-by-Step Guide

This file is a plan for writing `TUTORIAL.md`, a single long-form tutorial where the reader builds an AI coding agent from scratch. Every line of code the reader sees, they type. No hidden code, no separate example files.

This is NOT a replacement for the existing chapters. The chapters are concept-focused reference material. The tutorial is a "type along and build" experience.

## Writing style

- Explain architecture decisions (why readline, why while loop, why string.replace), not basic programming (what fs.readFileSync does)
- Assume readers know TypeScript
- Natural tone, not marketing. Say it once, clearly, move on. No "No API calls, no extra tokens, runs in milliseconds." Just "it just manipulates strings in memory, so it does not cost anything extra."
- For utility code (tool implementations), briefly say what it does and show the code. Do not walk through every line. "This function reads a file and returns its content with line numbers:"
- For architecture code (the loop, streaming, compression, permissions), explain WHY it is designed this way
- Each section ends with "run it, you should see X" so the reader has a checkpoint
- Plain English for non-native speakers. No emdash.

## The file being built

The reader builds ONE file: `agent.ts`. It starts as 10 lines and grows to ~400 lines by the end. Each section adds code to this file.

## Sections

### 1. Setup (~100 words)

- Create project folder, npm init, install deps (@anthropic-ai/sdk, zod, turndown, typescript, tsx)
- Create tsconfig.json
- Create .env with API key
- Create agent.ts with just `console.log("hello")`
- Run it: `npx tsx --env-file=.env agent.ts`
- Checkpoint: see "hello" in terminal

### 2. The REPL (~200 words)

- Import readline, create the prompt loop
- Explain: "we need a way for users to type messages, readline gives us that"
- The ask() pattern with rl.question
- Checkpoint: run it, type something, see it echoed back

Code at this point: ~20 lines

### 3. Calling the API (~300 words)

- Import Anthropic, create client
- Inside the ask handler, call client.messages.create with the user's input
- Print the response text
- Explain: conversationHistory array, push user message, push assistant response
- Show that follow-up messages work because history carries forward
- Checkpoint: run it, type "hello", see AI response. Type a follow-up, see it remembers.

Code at this point: ~40 lines

### 4. The agentic loop (~400 words)

- Explain: right now the model can only talk. We want it to DO things. That means tools.
- Define one simple tool (get_time) with the JSON schema format
- Explain what input_schema is (briefly, readers know JSON)
- Add the while(true) loop: call API, check for tool_use blocks, execute, push results, continue
- Explain: check content blocks not stop_reason (unreliable)
- Add maxTurns safety limit
- Extract agentLoop() as a function
- Checkpoint: run it, ask "what time is it?", see it call the tool and respond

Code at this point: ~80 lines

### 5. Real tools (~300 words)

- Replace get_time with real tools: read_file, write_file, list_files, search_files, run_command
- Use Zod for input schemas, add zodToJsonSchema converter
- Add the Tool interface (name, description, inputSchema, call)
- Collect tools in an array, wire into the loop with tools.find()
- Add input validation with safeParse
- For each tool: brief description of what it does + the code. No line-by-line walkthrough.
- search_files: wrap RegExp in try/catch (the security fix)
- Checkpoint: run it, ask "what files are in this directory?", see it list files

Code at this point: ~170 lines

### 6. The edit tool (~300 words)

- Add edit_file tool with string.replace
- Explain why string.replace (not AST, not line numbers)
- Uniqueness check: count with split().length - 1
- Quote normalization with findActualString
- Staleness detection with readTimestamps Map
- Explain: production agents use callback replacement to avoid $1 patterns
- Create a small test file to edit
- Checkpoint: run it, ask "change X to Y in test file", see it edit the file

Code at this point: ~220 lines

### 7. System prompt (~200 words)

- Add SYSTEM_PROMPT constant
- Three rules: read before edit, search before assuming, understand before modifying
- Pass system: SYSTEM_PROMPT in the API call
- Add hints in tool descriptions
- Explain: the prompt shapes behavior. Without it, the model guesses file paths. With it, it searches first.
- Checkpoint: run it, ask something ambiguous, see the model search first instead of guessing

Code at this point: ~240 lines

### 8. Context compression (~400 words)

- Explain: every API call sends the full history. Tokens grow. Eventually hits the limit.
- Add estimateTokens function (chars / 4)
- Log token count each turn
- Add truncateResult: cap tool results at 10k chars
- Add clearOldResults: replace old tool results with "[Cleared]"
- Add autoCompact: when tokens exceed threshold, make a side API call to summarize
- Wire into the loop: compress before each API call
- Explain: cheap layers first (string manipulation), expensive layer last (API call)
- Checkpoint: have a long conversation, watch token counts drop when compression kicks in

Code at this point: ~310 lines

### 9. Streaming (~300 words)

- Replace client.messages.create with client.messages.stream
- Process events: content_block_start, content_block_delta, content_block_stop
- Stream text with process.stdout.write
- Buffer tool inputs with input_json_delta, parse on block stop
- Explain: same loop, just incremental output instead of waiting for the full response
- Mention thinking blocks briefly
- Checkpoint: run it, see text appear word by word

Code at this point: ~350 lines

### 10. Permissions (~200 words)

- Add checkPermissions to Tool interface
- read_file returns "allow", edit_file returns "ask", run_command checks the command
- Add askUserPermission function with readline
- Wire into the loop between tool detection and execution
- Explain: this is the gate between what the model wants and what actually happens
- Checkpoint: run it, ask it to edit a file, see the permission prompt

Code at this point: ~400 lines

### 11. Done (~100 words)

- Recap what we built
- Point to the chapters for deeper explanations of each concept
- Point to the existing examples for features not covered (subagents, concurrency, web access, persistence)
- "The loop is dumb. The model is smart. Now go build something."

## What is NOT in the tutorial

These are covered in the chapters but skipped in the tutorial to keep it focused:

- Subagents (adds complexity, not essential for a working agent)
- Concurrent tool execution (optimization, not core)
- Web access (additional feature)
- Persistence (additional feature)
- These are mentioned in the "Done" section with pointers to the chapters

## Checkpoints summary

1. Setup: "hello" printed
2. REPL: echo user input
3. API: AI responds to "hello"
4. Loop: model calls get_time tool
5. Tools: model lists files
6. Edit: model edits a file
7. System prompt: model searches before editing
8. Compression: token counts drop
9. Streaming: text appears word by word
10. Permissions: user approves an edit

## How to write it

- Write in one pass, section by section
- After each section, show the FULL current state of agent.ts (since code accumulates)
- Or show only the diff/additions with clear markers like "add this after the imports:" and "replace the agentLoop function with:"
- The second approach is better for readability (no repeated code) but the reader needs to know where to put things
- Use "add this" for new code, "replace X with" for modifications
- At key checkpoints, show the full file so the reader can verify they are on track
