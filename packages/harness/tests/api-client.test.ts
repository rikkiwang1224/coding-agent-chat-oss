import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LlmClient, LlmApiError } from "../src/api-client.js";
import type { LlmConfig } from "../src/types.js";

// Helper: create a ReadableStream from a string (simulating SSE)
function createSSEStream(data: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(data));
      controller.close();
    },
  });
}

// Helper: create chunked SSE stream (multiple enqueues)
function createChunkedSSEStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

const mockConfig: LlmConfig = { apiKey: "test-key", baseUrl: "https://mock.api" };

describe("LlmClient - SSE parsing", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("parses a complete SSE stream with content deltas", async () => {
    const ssePayload = [
      'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}',
      "",
      'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createSSEStream(ssePayload),
    });

    const client = new LlmClient(mockConfig);
    const chunks = [];
    for await (const chunk of client.stream({ messages: [{ role: "user", content: "hi" }] })) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBe(2);
    expect(chunks[0].choices[0].delta.content).toBe("Hello");
    expect(chunks[1].choices[0].delta.content).toBe(" world");
  });

  it("handles chunked delivery (split across network packets)", async () => {
    const line1 = 'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n\n';
    const line2 = "data: [DONE]\n";

    // Split in the middle of a JSON payload
    const part1 = line1.slice(0, 20);
    const part2 = line1.slice(20) + line2;

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createChunkedSSEStream([part1, part2]),
    });

    const client = new LlmClient(mockConfig);
    const chunks = [];
    for await (const chunk of client.stream({ messages: [{ role: "user", content: "hi" }] })) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBe(1);
    expect(chunks[0].choices[0].delta.content).toBe("Hi");
  });

  it("skips comment lines (starting with :)", async () => {
    const ssePayload = [
      ": this is a keep-alive comment",
      'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createSSEStream(ssePayload),
    });

    const client = new LlmClient(mockConfig);
    const chunks = [];
    for await (const chunk of client.stream({ messages: [{ role: "user", content: "hi" }] })) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBe(1);
    expect(chunks[0].choices[0].delta.content).toBe("ok");
  });

  it("handles tool_calls in stream deltas", async () => {
    const ssePayload = [
      'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":"}}]},"finish_reason":null}]}',
      "",
      'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"test.txt\\"}"}}]},"finish_reason":null}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createSSEStream(ssePayload),
    });

    const client = new LlmClient(mockConfig);
    const chunks = [];
    for await (const chunk of client.stream({ messages: [{ role: "user", content: "hi" }] })) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBe(2);
    expect(chunks[0].choices[0].delta.tool_calls![0].id).toBe("call_1");
    expect(chunks[0].choices[0].delta.tool_calls![0].function!.name).toBe("read_file");
  });

  it("includes usage in final chunk", async () => {
    const ssePayload = [
      'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}',
      "",
      'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createSSEStream(ssePayload),
    });

    const client = new LlmClient(mockConfig);
    const chunks = [];
    for await (const chunk of client.stream({ messages: [{ role: "user", content: "hi" }] })) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBe(2);
    expect(chunks[1].usage?.prompt_tokens).toBe(10);
    expect(chunks[1].usage?.completion_tokens).toBe(5);
  });
});

describe("LlmClient - error handling", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws LlmApiError on 4xx response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Unauthorized"),
    });

    const client = new LlmClient(mockConfig);
    const gen = client.stream({ messages: [{ role: "user", content: "hi" }] });

    await expect(gen.next()).rejects.toThrow("401");
  });

  it("throws LlmApiError on 429 rate limit", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve("Rate limit exceeded"),
    });

    const client = new LlmClient(mockConfig);
    const gen = client.stream({ messages: [{ role: "user", content: "hi" }] });

    await expect(gen.next()).rejects.toThrow("429");
  });

  it("throws LlmApiError when response body is null", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: null,
    });

    const client = new LlmClient(mockConfig);
    const gen = client.stream({ messages: [{ role: "user", content: "hi" }] });

    await expect(gen.next()).rejects.toThrow("null");
  });

  it("throws on missing API key", () => {
    expect(() => new LlmClient({ apiKey: "" })).toThrow("API key");
  });
});

describe("LlmClient - configuration", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends correct model and parameters in request body", async () => {
    let capturedBody: any;
    globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse(init.body as string);
      return {
        ok: true,
        body: createSSEStream("data: [DONE]\n"),
      };
    });

    const client = new LlmClient({
      apiKey: "key",
      baseUrl: "https://api.example.com",
      model: "custom-model",
      maxTokens: 8192,
      temperature: 0.5,
    });

    const gen = client.stream({ messages: [{ role: "user", content: "hi" }] });
    // exhaust the generator
    for await (const _ of gen) { /* drain */ }

    expect(capturedBody.model).toBe("custom-model");
    expect(capturedBody.max_tokens).toBe(8192);
    expect(capturedBody.temperature).toBe(0.5);
    expect(capturedBody.stream).toBe(true);
  });

  it("includes tools when provided", async () => {
    let capturedBody: any;
    globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse(init.body as string);
      return {
        ok: true,
        body: createSSEStream("data: [DONE]\n"),
      };
    });

    const client = new LlmClient(mockConfig);
    const tools = [
      { type: "function" as const, function: { name: "test", description: "test tool", parameters: {} } },
    ];

    const gen = client.stream({ messages: [{ role: "user", content: "hi" }], tools });
    for await (const _ of gen) { /* drain */ }

    expect(capturedBody.tools).toEqual(tools);
    expect(capturedBody.tool_choice).toBe("auto");
  });

  it("enables thinking mode when configured", async () => {
    let capturedBody: any;
    globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse(init.body as string);
      return {
        ok: true,
        body: createSSEStream("data: [DONE]\n"),
      };
    });

    const client = new LlmClient({ ...mockConfig, thinking: true, reasoningEffort: "high" });
    const gen = client.stream({ messages: [{ role: "user", content: "hi" }] });
    for await (const _ of gen) { /* drain */ }

    expect(capturedBody.thinking).toEqual({ type: "enabled" });
    expect(capturedBody.reasoning_effort).toBe("high");
  });
});
