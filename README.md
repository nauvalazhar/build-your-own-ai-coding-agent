# Build Your Own AI Coding Agent From Scratch

Ever wonder how AI coding tools like Claude Code and Cursor actually work under the hood? It is simpler than you think. The core is a while loop, some tools, and a few clever tricks.

This is a step-by-step guide that takes you from zero to a working AI coding agent. No frameworks. No magic. Just TypeScript and an LLM API. Each chapter introduces one concept, explains why it is designed that way, and comes with a runnable example you can try immediately.

The concepts work with any LLM that supports tool use (Claude, GPT, Gemini, etc.). Our examples use Claude and the Anthropic SDK, but the architecture is provider-agnostic.

## Who is this for

- Developers curious about how AI coding tools work internally
- Anyone who wants to build their own AI-powered dev tools
- People who learn best by building, not just reading

You need basic TypeScript knowledge and an LLM API key. That is it.

## What you will build

A CLI tool that uses an LLM to read, search, edit files, and run commands. By the end, your agent will have streaming, permissions, subagents, context compression, and concurrent tool execution. The same core ideas behind tools like Claude Code, Cursor, and other AI coding assistants.

## Prerequisites

- Node.js 18+
- An Anthropic API key ([get one here](https://console.anthropic.com/)) - used in our examples, but the concepts apply to any LLM
- Basic TypeScript knowledge

## Setup

```bash
npm install
cp .env.example .env
# Add your API key to .env
```

## Chapters

| # | Chapter | What you will learn |
|---|---------|-------------------|
| 00 | [Introduction](chapters/00-introduction.md) | What we are building and project setup |
| 01 | [The Agentic Loop](chapters/01-agentic-loop.md) | The while(true) core that drives everything |
| 02 | [Tools](chapters/02-tools.md) | Giving the model eyes and hands |
| 03 | [The Edit Tool](chapters/03-edit-tool.md) | How AI actually edits files (it is simpler than you think) |
| 04 | [System Prompts](chapters/04-system-prompts.md) | Teaching the model to search before it edits |
| 05 | [Context](chapters/05-context.md) | How conversation history makes follow-ups work |
| 06 | [Context Compression](chapters/06-context-compression.md) | Keeping conversations going when context runs out |
| 07 | [Permissions](chapters/07-permissions.md) | Stopping the model from running rm -rf / |
| 08 | [Subagents](chapters/08-subagents.md) | Delegating work to isolated child agents |
| 09 | [Streaming](chapters/09-streaming.md) | Showing responses token by token |
| 10 | [Concurrent Tools](chapters/10-concurrent-tools.md) | Running safe tools in parallel |
| 11 | [Web Access](chapters/11-web-access.md) | Fetching URLs and searching the web |
| 12 | [Persistence](chapters/12-persistence.md) | Saving conversations and project instructions |
| 13 | [What's Next](chapters/13-whats-next.md) | Where to go from here |

## Running examples

Each chapter has a matching example file. Run them with:

```bash
npm run example:01
npm run example:02
# ... and so on
```

Examples build on each other. Start from 01 and work your way up.

## The sample project

The `sample-project/` folder contains a small React app that the agent operates on. The examples use these files for reading, searching, and editing.
