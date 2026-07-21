/** Portable Runtime entry point for browser, WebView, Worker and JS hosts. */
export * from "./browser.js";
export {
  createBrowserRuntime as createPortableRuntime,
  createBrowserRuntime as createRuntime,
  type CreateBrowserRuntimeOptions as CreatePortableRuntimeOptions,
  type CreateBrowserRuntimeOptions as CreateRuntimeOptions,
} from "./createBrowserRuntime.js";
