/**
 * Public exports of the AI Stream package.
 *
 * Adapters live alongside the `AiStreamEvent` discriminated union so
 * downstream packages can import everything from one place:
 *
 *     import {
 *       OpenAICompatibleStreamAdapter,
 *       type AiStreamEvent,
 *     } from "@ai-native-flow/ai-stream";
 */

export * from "./types.js";
export * from "./openaiAdapter.js";
