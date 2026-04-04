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

This works for simple pages but loses structure. Headings, lists, and code blocks all become flat text. Production agents use proper HTML-to-Markdown libraries (like [Turndown](https://github.com/mixmark-io/turndown)) that preserve the document structure. A heading stays a heading. A code block stays a code block. The model can read the result much better.

For our example, regex stripping is fine. If you want better results, add Turndown as a dependency and replace the function with `new Turndown().turndown(html)`.

### The basic fetch tool

```typescript
const MAX_CONTENT_LENGTH = 50_000;

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

    // 2. Convert HTML to text
    const text = htmlToText(html);

    // 3. Truncate if too long
    const truncated = text.length > MAX_CONTENT_LENGTH
      ? text.slice(0, MAX_CONTENT_LENGTH) + "\n[Truncated]"
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

Search is trickier than fetching because you need a search provider. There are a few options:

- **API-based**: Use a search API like Google Custom Search, Bing Search, or Brave Search. These require API keys and have rate limits.
- **Server-side**: Some LLM providers offer built-in web search as a server-side tool. The search happens on the provider's side, and you get results back.

For our example, we will keep search simple. We build the tool interface but acknowledge that the search backend depends on what API you have access to:

```typescript
const webSearchTool: Tool = {
  name: "web_search",
  description: "Search the web and return a list of results with titles and URLs.",
  inputSchema: z.object({
    query: z.string().describe("The search query"),
  }),
  async call(input) {
    const query = input.query as string;

    // This is where you would call a search API.
    // For example, with Brave Search:
    // const results = await braveSearch(query);

    // For now, return a message explaining how to set this up
    return "Web search requires a search API key (Google, Bing, or Brave). " +
      "Configure one and replace this placeholder. " +
      "The tool should return titles and URLs that the model can then fetch.";
  },
};
```

The pattern is the same either way: the model calls `web_search`, gets back titles and URLs, and then uses `web_fetch` to read the pages that look relevant. Search finds the pages. Fetch reads them.

## Permissions

Web access should ask for permission. You do not want the agent silently fetching random URLs. It could be sending your code to an external service, or fetching from a malicious site.

```typescript
checkPermissions(input) {
  return "ask";  // Always ask before fetching
}
```

Production agents are more nuanced. They maintain a list of preapproved domains (like official documentation sites) that skip the permission prompt. Other domains always ask. This way, fetching `react.dev` is automatic but fetching `random-site.com` needs approval.

## What is still missing

Our agent lives in the moment. Close it, and everything is gone. The conversation, the files it read, the decisions it made. In the next chapter, we will add persistence so the agent can save its state and pick up where it left off.

## Running the example

```bash
npm run example:11
```

Try:
- "Fetch https://example.com and tell me what it says"
- "What is on the Anthropic homepage?" (it will fetch and summarize)

Note: The web search tool is a placeholder in this example. To use real web search, you need a search API key.
