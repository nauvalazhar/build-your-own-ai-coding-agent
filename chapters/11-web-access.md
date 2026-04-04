# Chapter 11: Web Access

## The problem

Our agent can only see local files. If the user asks "how do I use the useEffect hook?", the agent can search the codebase for examples, but it cannot look up the official React documentation. If an error message appears that the agent has never seen, it cannot search for solutions online.

Developers constantly reference the web: documentation, Stack Overflow, blog posts, API references. An agent without web access is like a developer without a browser.

## What is web access?

Web access for an agent means two tools:

1. **Fetch**: Give it a URL, get back the page content. Like opening a specific link.
2. **Search**: Give it a query, get back a list of results with titles and URLs. Like typing into a search engine.

The model uses search to find relevant pages, then fetch to read them. Same way you would.

## Walkthrough: "How do I use useEffect?"

```
Turn 1:
  [tool] web_fetch({
    url: "https://react.dev/reference/react/useEffect",
    prompt: "Explain how useEffect works with examples"
  })
  [result] "useEffect is a React Hook that lets you synchronize a component
            with an external system. Basic usage: useEffect(() => { ... }, [deps]).
            The first argument is the setup function..."

Turn 2:
  [text] "useEffect lets you run side effects in your components.
          Here is how it works: ..."
```

The agent fetched the React docs and extracted the relevant information. The user gets an answer grounded in real documentation, not just the model's training data.

## Building the fetch tool

The fetch tool takes a URL and returns the page content as text. But there are a few problems to solve:

**HTML is noisy.** A web page is full of navigation, ads, scripts, and styling. The model does not need any of that. We need to convert HTML to clean text.

**Pages can be huge.** Some documentation pages are 100,000+ characters. Dumping all of that into the context wastes tokens. We need to truncate.

**The model needs focus.** Instead of sending the entire page content, we can ask the model "here is the page, extract the part about X." This gives the main model a focused summary instead of a wall of text.

### Converting HTML to text

The simplest approach is stripping HTML tags with regex:

```typescript
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
```

This works for simple pages but loses structure. Headings, lists, and code blocks all become flat text.

A better approach is converting HTML to Markdown using a library like [Turndown](https://github.com/mixmark-io/turndown). It preserves the document structure so the model can read it properly:

```typescript
import Turndown from "turndown";
const turndown = new Turndown();

function htmlToMarkdown(html: string): string {
  return turndown.turndown(html);
}
```

One dependency, one line. Headings stay headings, code blocks stay code blocks, links stay links. This is what production agents use. Our example uses Turndown since it is simple and gives much better results.

### The basic fetch tool

```typescript
const MAX_WEB_CONTENT = 50_000;

const webFetchTool: Tool = {
  name: "web_fetch",
  description:
    "Fetch a web page and extract content based on a prompt. " +
    "Returns the relevant content from the page.",
  inputSchema: z.object({
    url: z.string().describe("The URL to fetch"),
    prompt: z.string().describe("What to extract from the page"),
  }),
  async call(input) {
    const url = input.url as string;
    const prompt = input.prompt as string;

    // 1. Fetch the page
    const response = await fetch(url);
    if (!response.ok) {
      return `Error: HTTP ${response.status} ${response.statusText}`;
    }
    const html = await response.text();

    // 2. Convert HTML to markdown
    const text = htmlToMarkdown(html);

    // 3. Truncate if too long
    const truncated = text.length > MAX_WEB_CONTENT
      ? text.slice(0, MAX_WEB_CONTENT) + "\n[Truncated]"
      : text;

    return truncated;
  },
};
```

This fetches the page, converts to text, and truncates. The model gets readable content it can reason about.

### Using a secondary model for extraction

The basic version sends the whole page (up to 50,000 chars) to the main model. That works, but it wastes tokens. Most of the page is irrelevant to what the user asked.

Production agents solve this with a **secondary model call**. They send the page content to a cheap, fast model with the prompt "extract the part about X" and return the summary to the main model:

```typescript
async call(input) {
  const url = input.url as string;
  const prompt = input.prompt as string;

  // ... fetch and strip HTML (same as before) ...

  // Use a cheap model to extract relevant content
  const extraction = await client.messages.create({
    model: "claude-haiku-4-5-20251001",  // cheap and fast
    max_tokens: 2048,
    system: "Extract the relevant information from this web page based on the user's prompt. Be concise.",
    messages: [
      {
        role: "user",
        content: `Prompt: ${prompt}\n\nPage content:\n${truncated}`,
      },
    ],
  });

  const extractedText = extraction.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return extractedText;
}
```

Now the main model gets a focused 200-500 token summary instead of 50,000 characters of page content. This saves tokens and keeps the context clean.

The tradeoff: an extra API call per fetch. But it is a cheap model, so the cost is small compared to the tokens saved.

## Caching

The agent might fetch the same URL multiple times in one session. Maybe it fetched the React docs on turn 3 and wants to reference them again on turn 10. Fetching the same page twice is wasteful.

A simple in-memory cache fixes this:

```typescript
const urlCache = new Map<string, string>();

async call(input) {
  const url = input.url as string;

  // Check cache first
  const cached = urlCache.get(url);
  if (cached) {
    return cached;
  }

  // ... fetch and process ...

  // Store in cache
  urlCache.set(url, result);
  return result;
}
```

The cache lasts for the session. When the agent restarts, the cache is empty. This is fine because web content can change, and you do not want stale cached pages persisting forever.

## Web search

Search is trickier than fetching. You need a search backend. There are two approaches:

- **External API**: Use a search API like Google Custom Search, Bing Search, or Brave Search. These require separate API keys and have rate limits.
- **Built-in server-side**: Some LLM providers offer web search as a built-in feature. You pass a special tool definition in your API call, and the provider performs the search on their side.

Our examples use the Anthropic SDK, which supports built-in web search. You pass a `web_search` tool in the API call, and Claude searches the web server-side. No extra API key needed.

The idea is simple: instead of our agent calling the search tool, we make a separate API call to Claude with the web search tool enabled. Claude performs the search and returns the results. Our agent then parses those results.

```typescript
const webSearchTool: Tool = {
  name: "web_search",
  description: "Search the web and return results with titles and URLs.",
  inputSchema: z.object({
    query: z.string().describe("The search query"),
  }),
  async call(input) {
    const query = input.query as string;

    // Make a separate API call with the server-side web search tool
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: "Perform the web search and return the results.",
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
      messages: [{ role: "user", content: `Search the web for: ${query}` }],
    });

    // Extract search results and text from the response
    const parts: string[] = [];
    for (const block of response.content) {
      if (block.type === "web_search_tool_result") {
        if (Array.isArray(block.content)) {
          for (const result of block.content) {
            parts.push(`- ${result.title}: ${result.url}`);
          }
        }
      } else if (block.type === "text") {
        parts.push(block.text);
      }
    }

    return parts.join("\n") || "No results found.";
  },
};
```

The model gets back titles, URLs, and sometimes a text summary. It can then use `web_fetch` on any URL that looks relevant. Search finds the pages. Fetch reads them.

If you are using a different LLM provider, replace this with their equivalent. OpenAI has a similar server-side search feature. Or use an external API like Brave Search and parse the JSON response yourself.

## Permissions

Web access should ask for permission. You do not want the agent silently fetching random URLs. It could be sending your code to an external service, or fetching from a malicious site.

```typescript
checkPermissions(input) {
  return "ask";  // Always ask before fetching
}
```

Production agents are more nuanced. They maintain a list of preapproved domains (like official documentation sites) that skip the permission prompt. Other domains always ask:

```typescript
const PREAPPROVED_HOSTS = new Set([
  "react.dev",
  "developer.mozilla.org",
  "docs.python.org",
  "doc.rust-lang.org",
  "go.dev",
  // ... other trusted documentation sites
]);

checkPermissions(input) {
  const hostname = new URL(input.url as string).hostname;
  if (PREAPPROVED_HOSTS.has(hostname)) {
    return "allow";  // Trusted docs site, no need to ask
  }
  return "ask";  // Unknown domain, ask the user
}
```

This way, fetching `react.dev` is automatic but fetching `random-site.com` needs approval.

## What is still missing

Our agent lives in the moment. Close it, and everything is gone. The conversation, the files it read, the decisions it made. In the next chapter, we will add persistence so the agent can save its state and pick up where it left off.

## Running the example

```bash
npm run example:11
```

Try:
- "Fetch https://example.com and tell me what it says"
- "Search the web for how to use React useEffect"
- "What is on the Anthropic homepage?" (it will fetch and summarize)
