/**
 * Public exports of the Flow Graph IR.
 *
 * Downstream packages (`flow-validator`, `flow-builder`, `runtime`) must
 * import from this entry point only.
 */

export * from "./schemaVersion.js";
export * from "./types.js";
export * from "./schema.js";
export * from "./errors.js";
export * from "./registry.js";
export * from "./ids.js";
