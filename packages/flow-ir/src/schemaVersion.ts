/**
 * Schema version constants for IR contracts.
 *
 * See `docs/decisions/schema-versioning.md` for the versioning strategy.
 * `schemaVersion` follows the form `flow.graph.v{MAJOR}` and only changes
 * when the IR contract introduces a breaking change.
 */

export const FLOW_GRAPH_SCHEMA_VERSION = "flow.graph.v1" as const;
export type FlowGraphSchemaVersion = typeof FLOW_GRAPH_SCHEMA_VERSION;

/**
 * The set of schemaVersions a current runtime can load.
 * Per the versioning policy, runtimes must support the current MAJOR and the
 * previous MAJOR. There is no previous major yet.
 */
export const SUPPORTED_FLOW_GRAPH_SCHEMA_VERSIONS: readonly FlowGraphSchemaVersion[] =
  Object.freeze([FLOW_GRAPH_SCHEMA_VERSION]);
