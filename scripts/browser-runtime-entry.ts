// Verify both the public default and the compatibility browser entry. If the
// package root ever reaches a Node-only module, this production bundle fails.
export * from "../packages/runtime/src/index.js";
export { createBrowserRuntime } from "../packages/runtime/src/browser.js";
export {
  createHttpHandler,
  createPortableHttpRuntime,
} from "../packages/transport-http/src/index.js";
