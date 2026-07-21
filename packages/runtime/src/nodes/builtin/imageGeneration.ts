import { z } from "zod";
import { createRuntimeError, normalizeError } from "@ai-native-flow/flow-ir";
import { defineNode } from "@ai-native-flow/node-sdk";
import {
  generateOpenAICompatibleImage,
  IMAGE_MEDIA_TYPES,
  IMAGE_QUALITIES,
  IMAGE_SIZES,
  type ImageReferenceInput,
} from "../imageGenerationProvider.js";

const configSchema = z.object({
  baseUrl: z.string().min(1).default("$var:LLM_BASE_URL"),
  apiKey: z.string().min(1).default("$var:LLM_API_KEY"),
  model: z.string().min(1).default("$var:IMAGE_DEFAULT_MODEL"),
  prompt: z.string().default(""),
  size: z.enum(IMAGE_SIZES).default("1024x1024"),
  quality: z.enum(IMAGE_QUALITIES).default("auto"),
}).passthrough();

export function createImageGenerationNode(fetchImpl: typeof fetch) {
  return defineNode({
    type: "image_generation",
    typeVersion: "1.0.0",
    title: "Image Generation",
    description: "Generate or edit an image through an OpenAI-compatible endpoint.",
    capabilities: {
      supportsCancel: true,
      requiredPermissions: ["network.http", "secret.read"],
    },
    config: configSchema,
    fieldMeta: {
      baseUrl: { label: "Base URL", order: 1 },
      apiKey: { label: "API key", order: 2 },
      model: { label: "Model", order: 3 },
      prompt: { label: "Prompt", control: "textarea", order: 4 },
      size: { label: "Size", control: "select", order: 5 },
      quality: { label: "Quality", control: "select", order: 6 },
    },
    ports: [
      { id: "prompt", direction: "input", kind: "data", label: "Prompt", schema: { type: "string" } },
      { id: "referenceImage", direction: "input", kind: "data", label: "Reference image", schema: { type: "object" } },
      { id: "image", direction: "output", kind: "data", label: "Image", schema: { type: "object" } },
      { id: "src", direction: "output", kind: "data", label: "Source", schema: { type: "string" } },
      { id: "summary", direction: "output", kind: "data", label: "Summary" },
    ],
    validateInput: false,
    async run({ input, config, ctx }) {
      const raw = input as Record<string, unknown>;
      const prompt = typeof raw.prompt === "string" ? raw.prompt : config.prompt;
      const baseUrl = resolve(config.baseUrl, ctx.variables);
      const apiKey = resolve(config.apiKey, ctx.variables);
      const model = resolve(config.model, ctx.variables);
      const referenceImage = readReferenceImage(raw.referenceImage);
      if (raw.referenceImage !== undefined && !referenceImage) {
        return {
          kind: "error",
          error: createRuntimeError({
            code: "node.image_generation.invalid_reference",
            kind: "validation",
            category: "author",
            message: "referenceImage requires base64 data and a PNG, JPEG, or WebP mediaType",
            source: { module: "node_logic", nodeId: ctx.nodeId },
          }) as unknown as { code: string; message: string; [key: string]: unknown },
        };
      }
      if (!prompt?.trim() || !baseUrl || !apiKey || !model) {
        return {
          kind: "error",
          error: createRuntimeError({
            code: "node.image_generation.missing_config",
            kind: "validation",
            category: "author",
            message: "image_generation requires prompt, baseUrl, apiKey, and model",
            source: { module: "node_logic", nodeId: ctx.nodeId },
          }) as unknown as { code: string; message: string; [key: string]: unknown },
        };
      }
      try {
        const image = await generateOpenAICompatibleImage(baseUrl, apiKey, {
          prompt,
          model,
          size: config.size ?? "1024x1024",
          quality: config.quality ?? "auto",
          ...(referenceImage ? { referenceImage } : {}),
          signal: ctx.signal,
        }, fetchImpl);
        return {
          kind: "success",
          outputs: {
            out: image,
            image,
            src: image.src,
            summary: {
              model: image.model,
              size: image.size,
              quality: image.quality,
              mode: image.mode,
              revisedPrompt: image.revisedPrompt ?? "",
            },
          },
        };
      } catch (cause) {
        return {
          kind: "error",
          error: normalizeError(cause, { module: "node_logic", nodeId: ctx.nodeId }) as unknown as {
            code: string; message: string; [key: string]: unknown;
          },
        };
      }
    },
  });
}

export const imageGenerationNode = createImageGenerationNode((input, init) => globalThis.fetch(input, init));

function resolve(
  value: string | undefined,
  variables: { getString(name: string): string | undefined },
): string | undefined {
  if (!value) return undefined;
  const match = /^\$(?:var|secret):([A-Za-z0-9_.:-]+)$/.exec(value.trim());
  return match?.[1] ? variables.getString(match[1]) : value.trim() || undefined;
}

function readReferenceImage(value: unknown): ImageReferenceInput | undefined {
  if (!value || typeof value !== "object") return undefined;
  const image = value as { data?: unknown; mediaType?: unknown; fileName?: unknown };
  if (typeof image.data !== "string" || !image.data) return undefined;
  if (!IMAGE_MEDIA_TYPES.includes(image.mediaType as ImageReferenceInput["mediaType"])) return undefined;
  return {
    data: image.data,
    mediaType: image.mediaType as ImageReferenceInput["mediaType"],
    ...(typeof image.fileName === "string" && image.fileName.trim()
      ? { fileName: image.fileName.trim().slice(0, 120) }
      : {}),
  };
}
