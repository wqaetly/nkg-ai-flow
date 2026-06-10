/**
 * Helpers that turn variable / secret access failures into structured
 * RuntimeErrors. Centralising these keeps error codes consistent across
 * every node and logic site that consumes the stores.
 */

import {
  RuntimeErrorException,
  createRuntimeError,
  type RuntimeError,
} from "@ai-native-flow/flow-ir";

export function variableNotFound(name: string): RuntimeError {
  return createRuntimeError({
    code: "variable.not_found",
    kind: "not_found",
    category: "user_input",
    message: `variable "${name}" is not defined`,
    source: { module: "node_logic" },
    context: { variable: name },
  });
}

export function variableTypeMismatch(
  name: string,
  expected: string,
  actual: string,
): RuntimeError {
  return createRuntimeError({
    code: "variable.type_mismatch",
    kind: "validation",
    category: "author",
    message: `variable "${name}" expected ${expected} but got ${actual}`,
    source: { module: "node_logic" },
    context: { variable: name, expected, actual },
  });
}

export function secretNotFound(name: string): RuntimeError {
  return createRuntimeError({
    code: "secret.not_found",
    kind: "not_found",
    category: "user_input",
    message: `secret "${name}" is not defined`,
    source: { module: "node_logic" },
    // Intentionally no `value` in context; only the name.
    context: { secret: name },
  });
}

export function throwVariableNotFound(name: string): never {
  throw new RuntimeErrorException(variableNotFound(name));
}

export function throwSecretNotFound(name: string): never {
  throw new RuntimeErrorException(secretNotFound(name));
}

export function throwVariableTypeMismatch(
  name: string,
  expected: string,
  actual: string,
): never {
  throw new RuntimeErrorException(variableTypeMismatch(name, expected, actual));
}
