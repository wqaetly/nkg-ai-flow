import { describe, expect, it } from "vitest";
import {
  BUNDLED_EXAMPLE_SOURCES,
  auditBundledExampleFlows,
  discoverBundledExampleFlowSources,
} from "../../../scripts/audit-example-flows.js";

describe("bundled example Flow audit", () => {
  it("classifies every bundled Flow source", () => {
    expect(discoverBundledExampleFlowSources()).toEqual(
      [...BUNDLED_EXAMPLE_SOURCES].sort(),
    );
  });

  it("validates every asset and executes every deterministic portable example", async () => {
    const audit = await auditBundledExampleFlows();

    expect(audit.structural).toEqual({ passed: 3, total: 3, rate: 1 });
    expect(audit.deterministicExecution).toEqual({ passed: 1, total: 1, rate: 1 });
    expect(audit.flows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "loop_block_showcase",
        structural: "passed",
        execution: "passed",
        hostClass: "portable",
        missingPortableCapabilities: [],
      }),
      expect.objectContaining({
        id: "helloagent",
        structural: "passed",
        execution: "not_applicable",
        hostClass: "desktop-power",
        missingPortableCapabilities: ["filesystem.write"],
      }),
      expect.objectContaining({
        id: "skill_to_flow",
        structural: "passed",
        execution: "not_applicable",
        hostClass: "desktop-power",
        missingPortableCapabilities: ["filesystem.write", "process.spawn"],
      }),
    ]));
  });
});
