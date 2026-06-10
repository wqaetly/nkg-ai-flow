import { describe, expect, test } from "vitest";
import type { FieldDescriptor, NodeTypeDefinition } from "@ai-native-flow/flow-ir";
import { getBuiltinNodeDefinitions } from "../packages/runtime/src/builtinDefinitions.js";
import createSkillToFlowNodes from "../apps/skill-to-flow/nodes/index.js";
import { STUDIO_FIELD_LABEL_DICTIONARIES } from "../packages/studio/src/fields/fieldLabels.js";
import { STUDIO_NODE_LABEL_DICTIONARIES } from "../packages/studio/src/paletteLabels.js";
import { STUDIO_PORT_LABEL_DICTIONARIES } from "../packages/studio/src/portLabels.js";

function configFields(definition: NodeTypeDefinition): FieldDescriptor[] {
  const schema = definition.configSchema as
    | { fields?: FieldDescriptor[] }
    | undefined;
  return Array.isArray(schema?.fields) ? schema.fields : [];
}

function currentNodeDefinitions(): NodeTypeDefinition[] {
  return [
    ...getBuiltinNodeDefinitions(),
    ...createSkillToFlowNodes().map((node) => node.definition),
  ];
}

function containsChinese(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text);
}

describe("Studio field label localization", () => {
  test("LLM-bearing node config fields are required and ordered consistently", () => {
    const expected: Record<string, string[]> = {
      llm: ["baseUrl", "apiKey", "model", "temperature", "maxTokens"],
      agent: ["baseUrl", "apiKey", "model", "temperature", "maxTokens"],
      skill_planner: ["base_url", "api_key", "model", "temperature", "max_tokens"],
      node_designer: ["base_url", "api_key", "model", "temperature", "max_tokens"],
      code_synthesizer: ["base_url", "api_key", "model", "temperature", "max_tokens"],
    };
    const definitions = new Map(
      currentNodeDefinitions().map((definition) => [definition.type, definition]),
    );

    for (const [nodeType, orderedNames] of Object.entries(expected)) {
      const definition = definitions.get(nodeType);
      if (!definition) throw new Error(`missing node definition ${nodeType}`);
      const fields = configFields(definition);
      const ordered = [...fields]
        .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity))
        .slice(0, orderedNames.length);

      expect(ordered.map((field) => field.name)).toEqual(orderedNames);
      for (const name of orderedNames) {
        const field = fields.find((candidate) => candidate.name === name);
        expect(field?.optional).toBe(false);
      }
    }
  });

  test("all currently loadable node config fields have explicit Chinese labels", () => {
    const dictionary = STUDIO_FIELD_LABEL_DICTIONARIES["zh-CN"];
    const missing: string[] = [];
    const notChinese: string[] = [];

    for (const definition of currentNodeDefinitions()) {
      for (const field of configFields(definition)) {
        const label =
          dictionary.nodes[definition.type]?.[field.name] ??
          dictionary.common[field.name];
        const key = `${definition.type}.${field.name}`;

        if (!label) {
          missing.push(key);
        } else if (!containsChinese(label)) {
          notChinese.push(`${key}=${label}`);
        }
      }
    }

    expect(missing).toEqual([]);
    expect(notChinese).toEqual([]);
  });

  test("all currently loadable node types have explicit Chinese palette titles", () => {
    const dictionary = STUDIO_NODE_LABEL_DICTIONARIES["zh-CN"];
    const missing: string[] = [];
    const notChinese: string[] = [];

    for (const definition of currentNodeDefinitions()) {
      const label = dictionary.nodes[definition.type]?.title;
      if (!label) {
        missing.push(definition.type);
      } else if (!containsChinese(label)) {
        notChinese.push(`${definition.type}=${label}`);
      }
    }

    expect(missing).toEqual([]);
    expect(notChinese).toEqual([]);
  });

  test("all currently loadable node ports have explicit Chinese labels", () => {
    const dictionary = STUDIO_PORT_LABEL_DICTIONARIES["zh-CN"];
    const missing: string[] = [];
    const notChinese: string[] = [];

    for (const definition of currentNodeDefinitions()) {
      for (const port of definition.defaultPorts) {
        const label =
          dictionary.nodes[definition.type]?.[port.id] ??
          dictionary.common[port.id];
        const key = `${definition.type}.${port.id}`;

        if (!label) {
          missing.push(key);
        } else if (!containsChinese(label)) {
          notChinese.push(`${key}=${label}`);
        }
      }
    }

    expect(missing).toEqual([]);
    expect(notChinese).toEqual([]);
  });
});
