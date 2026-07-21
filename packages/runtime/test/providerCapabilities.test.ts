import { describe, expect, it, vi } from "vitest";
import {
  generateOpenAICompatibleImage,
  MAX_REFERENCE_IMAGE_BYTES,
} from "../src/nodes/imageGenerationProvider.js";
import { searchSearxng } from "../src/nodes/webSearchProvider.js";

describe("portable provider capabilities", () => {
  it("normalizes and bounds SearXNG results", async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      results: [
        { title: " Result ", url: "https://example.test/a", content: " summary " },
        { title: "unsafe", url: "file:///tmp/a", content: "ignored" },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(searchSearxng(
      "https://search.example.test/",
      "search-secret",
      " latest release ",
      request,
      { maxResults: 3 },
    )).resolves.toEqual([
      { title: "Result", url: "https://example.test/a", content: "summary" },
    ]);

    const [url, init] = request.mock.calls[0]!;
    expect(url).toEqual(new URL("https://search.example.test/search?q=latest+release&format=json"));
    expect(init?.headers).toMatchObject({ "X-API-Key": "search-secret" });
  });

  it("uses the JSON generations endpoint for text-to-image", async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      data: [{ b64_json: "aW1hZ2U=", revised_prompt: "A polished prompt" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(generateOpenAICompatibleImage(
      "https://example.test/v1/",
      "secret-key",
      { model: "gpt-image", prompt: " draw a bird ", size: "1024x1024", quality: "low" },
      request,
    )).resolves.toEqual({
      src: "data:image/png;base64,aW1hZ2U=",
      revisedPrompt: "A polished prompt",
      model: "gpt-image",
      size: "1024x1024",
      quality: "low",
      mode: "generation",
    });

    const [url, init] = request.mock.calls[0]!;
    expect(url).toEqual(new URL("https://example.test/v1/images/generations"));
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "gpt-image",
      prompt: "draw a bird",
      response_format: "b64_json",
    });
  });

  it("supports multipart image edits and redacts provider secrets", async () => {
    const editRequest = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      data: [{ url: "https://cdn.example.test/result.png" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await expect(generateOpenAICompatibleImage(
      "https://example.test/v1",
      "secret-key",
      {
        model: "gpt-image",
        prompt: "make it red",
        size: "1536x1024",
        quality: "medium",
        referenceImage: { data: "cG5n", mediaType: "image/png", fileName: "reference.png" },
      },
      editRequest,
    )).resolves.toMatchObject({ src: "https://cdn.example.test/result.png", mode: "edit" });
    expect(editRequest.mock.calls[0]![1]?.body).toBeInstanceOf(FormData);

    const failed = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      error: { message: "invalid image for never-print-this" },
    }), { status: 400, headers: { "Content-Type": "application/json" } }));
    const error = await generateOpenAICompatibleImage(
      "https://example.test/v1",
      "never-print-this",
      { model: "gpt-image", prompt: "draw", size: "1024x1024", quality: "low" },
      failed,
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("never-print-this");
  });

  it("rejects oversized reference images before issuing a request", async () => {
    const data = "a".repeat(Math.ceil((MAX_REFERENCE_IMAGE_BYTES + 1) * 4 / 3));
    const request = vi.fn();
    await expect(generateOpenAICompatibleImage(
      "https://example.test/v1",
      "secret-key",
      {
        model: "gpt-image",
        prompt: "edit",
        size: "1024x1024",
        quality: "low",
        referenceImage: { data, mediaType: "image/png" },
      },
      request,
    )).rejects.toThrow("20 MB");
    expect(request).not.toHaveBeenCalled();
  });
});
