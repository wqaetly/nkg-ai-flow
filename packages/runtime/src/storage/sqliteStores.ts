import type { EventStore } from "@ai-native-flow/event-bus";
import type { RegistryStore } from "./registryStore.js";
import type { RunStore } from "./runStore.js";

export interface SqliteStores {
  runStore: RunStore;
  registryStore: RegistryStore;
  eventStore: EventStore;
  /** Close the underlying database. */
  close(): void;
}

export interface OpenSqliteStoresOptions {
  /** File path; use `:memory:` for ephemeral testing. */
  filename: string;
}

/**
 * Open SQLite-backed stores.
 *
 * A Node-native SQLite adapter has not been wired yet. Until then, callers
 * should use the default in-memory stores or provide their own RunStore,
 * RegistryStore and EventStore implementations.
 */
export async function openSqliteStores(
  _options: OpenSqliteStoresOptions,
): Promise<SqliteStores> {
  throw new Error(
    "openSqliteStores is not available until a Node-native SQLite adapter is configured.",
  );
}
