# Chapter 0: Introduction

## What we are building

We are building an AI coding agent. A command-line tool where you type something like "change the button color to red" and the AI figures out which file to open, what to change, and does it for you.

This is the same idea behind tools like Claude Code, Cursor, Windsurf, and other AI coding assistants. They all share the same core architecture. Once you understand it, the magic disappears. It is simpler than you think.

By the end of this guide, you will have built an agent that can:

- Search your codebase for files and patterns
- Read and understand source code
- Edit files with precision
- Run shell commands and react to the output
- Manage long conversations without running out of context
- Ask for permission before doing dangerous things
- Delegate work to sub-agents
- Stream responses in real-time
- Run multiple safe operations at the same time

Each chapter adds one concept. Each comes with a runnable TypeScript example. You can follow along from start to finish, or jump to whatever interests you.

## A note on the AI provider

The concepts in this guide work with any LLM that supports tool use (function calling). OpenAI, Google Gemini, Anthropic Claude, and others all support the same core pattern: you define tools, the model calls them, you return results.

We use Claude and the Anthropic SDK in our examples because that is what we are most familiar with. But the architecture is the same regardless of which provider you use. If you prefer OpenAI, swap the SDK and the model name. The loop, the tools, the permissions, the compression... all of it stays the same.

## What you need

- **Node.js 18 or later**
- **An Anthropic API key** (used in our examples) - you can get one at [console.anthropic.com](https://console.anthropic.com/)
- **Basic TypeScript knowledge** - you do not need to be an expert, but you should be comfortable reading TypeScript code

## Project setup

Clone this repo (or create the folder yourself), then install the dependencies:

```bash
cd build-your-own-ai-coding-agent
npm install
```

Copy the environment file and add your API key:

```bash
cp .env.example .env
```

Open `.env` and add your API key.

## The sample project

Inside `sample-project/` there is a small React app with a few components. Our agent will operate on these files throughout the guide. You do not need to run the React app. The agent just reads and edits the files.

```
sample-project/
├── src/
│   ├── App.tsx
│   └── components/
│       ├── Button.tsx
│       └── Header.tsx
```

These are small, simple files on purpose. They give our agent something real to work with without adding complexity.

## How to run the examples

Each chapter has a matching example file in `examples/`. Run them with:

```bash
npm run example:01
```

The examples build on each other. Example 02 adds tools to the loop from example 01. Example 03 adds the edit tool on top of that. And so on.

You do not have to run every example. But if you want to see the concepts in action, they are there.

## What is coming next

In the next chapter, we will build the core of everything: the agentic loop. It is a `while` loop. Seriously. That is the entire foundation.
