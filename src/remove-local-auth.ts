import { removeLegacyLocalAuth } from "./auth/legacy-migration.js";
import { EnvelopeObjectStore } from "./envelope-store.js";
import {
  loadScopeMaterial,
} from "./server-keys.js";
import {
  createConfiguredProviderStore,
  parseProvider,
} from "./providers/configured.js";
import { PrefixObjectStore } from "./stores.js";

const provider = process.env.THIMBLE_PROVIDER ?? "local";
const material = await loadScopeMaterial({
  scopeId: "system-auth",
  encrypted: true,
  keyVersion: 1,
  local: provider === "local",
});
const store = new EnvelopeObjectStore(
  new PrefixObjectStore(
    await createConfiguredProviderStore(parseProvider(provider), "auth"),
    "auth-v1",
  ),
  {
    key: material.key!,
    keyId: material.keyId!,
    compression: "gzip",
    objectKeyPrefix: "auth-v1",
  },
);
const result = await removeLegacyLocalAuth(
  store,
  (value) =>
    material.addressNode(new TextEncoder().encode(value)),
);
console.log(JSON.stringify(result, null, 2));
material.rawKey?.fill(0);
