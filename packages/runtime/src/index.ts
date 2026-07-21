/**
 * Platform-neutral default entry point.
 *
 * Business code can import `createRuntime()` from this package without
 * selecting a host. The default composition uses portable in-memory stores
 * and never imports Node builtins. Node processes that need filesystem or
 * process tools must opt in through `@ai-native-flow/runtime/node`.
 */
export * from "./portable.js";
