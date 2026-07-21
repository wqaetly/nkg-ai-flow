export const IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;
export const IMAGE_QUALITIES = ["low", "medium", "high", "auto"] as const;
export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;

export type ImageSize = (typeof IMAGE_SIZES)[number];
export type ImageQuality = (typeof IMAGE_QUALITIES)[number];
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

export interface ImageReferenceInput {
  data: string;
  mediaType: ImageMediaType;
  fileName?: string;
}

export interface ImageGenerationRequest {
  model: string;
  prompt: string;
  size: ImageSize;
  quality: ImageQuality;
  referenceImage?: ImageReferenceInput;
  signal?: AbortSignal;
}

export interface ImageGenerationResult {
  src: string;
  revisedPrompt?: string;
  model: string;
  size: ImageSize;
  quality: ImageQuality;
  mode: "generation" | "edit";
}

/** OpenAI-compatible image generation/edit client with no Node-only imports. */
export async function generateOpenAICompatibleImage(
  baseUrl: string,
  apiKey: string,
  request: ImageGenerationRequest,
  fetchImpl: typeof fetch,
): Promise<ImageGenerationResult> {
  const prompt = request.prompt.trim();
  const model = request.model.trim();
  if (!prompt) throw new Error("image prompt must not be empty");
  if (!model) throw new Error("image model must not be empty");
  if (!IMAGE_SIZES.includes(request.size)) throw new Error("unsupported image size");
  if (!IMAGE_QUALITIES.includes(request.quality)) throw new Error("unsupported image quality");
  validateReferenceImage(request.referenceImage);

  const mode = request.referenceImage ? "edit" : "generation";
  const response = await fetchImpl(
    imageEndpoint(baseUrl, mode),
    request.referenceImage
      ? editRequestInit(apiKey, request, prompt, model)
      : generationRequestInit(apiKey, request, prompt, model),
  );
  if (!response.ok) {
    const detail = await readProviderError(response, apiKey);
    throw new Error(`image request failed: HTTP ${response.status}${detail ? ` · ${detail}` : ""}`);
  }

  const item = firstImageItem((await response.json()) as unknown);
  const src = typeof item.b64_json === "string" && item.b64_json
    ? `data:image/png;base64,${item.b64_json}`
    : safeResultUrl(item.url);
  if (!src) throw new Error("image provider returned no usable image data");

  return {
    src,
    model,
    size: request.size,
    quality: request.quality,
    mode,
    ...(typeof item.revised_prompt === "string" && item.revised_prompt.trim()
      ? { revisedPrompt: item.revised_prompt.trim() }
      : {}),
  };
}

function generationRequestInit(
  apiKey: string,
  request: ImageGenerationRequest,
  prompt: string,
  model: string,
): RequestInit {
  return {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      model,
      prompt,
      n: 1,
      size: request.size,
      quality: request.quality,
      response_format: "b64_json",
    }),
    signal: request.signal,
  };
}

function editRequestInit(
  apiKey: string,
  request: ImageGenerationRequest,
  prompt: string,
  model: string,
): RequestInit {
  const reference = request.referenceImage!;
  const form = new FormData();
  form.set("model", model);
  form.set("prompt", prompt);
  form.set(
    "image",
    new Blob([decodeBase64(reference.data)], { type: reference.mediaType }),
    reference.fileName?.trim() || "reference.png",
  );
  form.set("n", "1");
  form.set("size", request.size);
  form.set("quality", request.quality);
  form.set("response_format", "b64_json");
  return {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey.trim()}`, Accept: "application/json" },
    body: form,
    signal: request.signal,
  };
}

function imageEndpoint(baseUrl: string, mode: "generation" | "edit"): URL {
  const endpoint = new URL(baseUrl.trim());
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new Error("image API URL must use HTTP or HTTPS");
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/images/${mode === "edit" ? "edits" : "generations"}`;
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint;
}

function validateReferenceImage(reference?: ImageReferenceInput): void {
  if (!reference) return;
  if (!reference.data) throw new Error("reference image must not be empty");
  if (!IMAGE_MEDIA_TYPES.includes(reference.mediaType)) {
    throw new Error("reference image must be PNG, JPEG, or WebP");
  }
  const estimatedBytes = Math.floor(reference.data.length * 3 / 4);
  if (estimatedBytes > MAX_REFERENCE_IMAGE_BYTES) {
    throw new Error("reference image must not exceed 20 MB");
  }
}

function decodeBase64(data: string): ArrayBuffer {
  const normalized = data.replace(/^data:[^;]+;base64,/, "");
  const binary = globalThis.atob(normalized);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return buffer;
}

async function readProviderError(response: Response, apiKey: string): Promise<string> {
  try {
    const payload = (await response.json()) as unknown;
    const error = payload && typeof payload === "object"
      ? (payload as { error?: unknown }).error
      : undefined;
    const message = error && typeof error === "object"
      ? (error as { message?: unknown }).message
      : undefined;
    if (typeof message === "string" && message.trim()) {
      const secret = apiKey.trim();
      return (secret ? message.split(secret).join("[redacted]") : message).trim().slice(0, 300);
    }
  } catch {
    // The status code remains actionable when the provider body is not JSON.
  }
  return "";
}

function firstImageItem(payload: unknown): {
  b64_json?: unknown;
  url?: unknown;
  revised_prompt?: unknown;
} {
  if (!payload || typeof payload !== "object") return {};
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data) || !data[0] || typeof data[0] !== "object") return {};
  return data[0] as { b64_json?: unknown; url?: unknown; revised_prompt?: unknown };
}

function safeResultUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}
