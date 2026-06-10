/**
 * Deprecated compatibility export.
 *
 * Environment values now use a single `VariableStore`. This class keeps old
 * `InMemorySecretStore` imports working while storing ordinary variable
 * values.
 */

import { InMemoryVariableStore } from "./inMemoryVariableStore.js";
import type {
  MutableSecretStore,
  SecretMetadata,
  VariableValue,
} from "./types.js";

export class InMemorySecretStore
  extends InMemoryVariableStore
  implements MutableSecretStore
{
  constructor(
    initial?: Iterable<{
      name: string;
      value: VariableValue;
      metadata?: SecretMetadata;
    }>,
  ) {
    super(initial);
  }
}
