import type { JsonValue, ObjectStore } from "../core.js";
import {
  decodeJson,
  encodeJson,
  isPreconditionFailure,
} from "../shared-utils.js";
import type { AuthUser, Identity } from "./types.js";

type LegacyLocalIdentity = {
  provider: "local";
  subject: string;
};

type LegacyAuthUser = Omit<AuthUser, "identities"> & {
  identities: Array<Identity | LegacyLocalIdentity>;
  password?: unknown;
};

export type LegacyAuthMigrationResult = {
  usersSanitized: number;
  sessionsRevoked: number;
  identityIndexesRemoved: number;
};

export async function removeLegacyLocalAuth(
  store: ObjectStore,
  indexValue: (
    value: string,
  ) => Promise<string> | string,
): Promise<LegacyAuthMigrationResult> {
  const result: LegacyAuthMigrationResult = {
    usersSanitized: 0,
    sessionsRevoked: 0,
    identityIndexesRemoved: 0,
  };
  for (const userKey of await store.list("users/")) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const object = await store.get(userKey);
      if (!object) {
        break;
      }
      const legacy = decodeJson<LegacyAuthUser>(object.bytes);
      const localIdentities = legacy.identities.filter(
        (identity): identity is LegacyLocalIdentity =>
          identity.provider === "local",
      );
      if (
        localIdentities.length === 0 &&
        !Object.hasOwn(legacy, "password")
      ) {
        break;
      }
      const externalIdentities = legacy.identities.filter(
        (identity): identity is Identity =>
          identity.provider === "entra" ||
          identity.provider === "oidc",
      );
      const {
        password: _password,
        identities: _identities,
        ...base
      } = legacy;
      const updated: AuthUser = {
        ...base,
        status:
          externalIdentities.length > 0
            ? legacy.status
            : "disabled",
        authVersion: legacy.authVersion + 1,
        identities: externalIdentities,
        updatedAt: new Date().toISOString(),
      };
      try {
        await store.put(
          userKey,
          encodeJson(updated as unknown as JsonValue),
          { ifMatch: object.etag },
        );
      } catch (error) {
        if (isPreconditionFailure(error)) {
          continue;
        }
        throw error;
      }

      const sessionPrefix = `sessions/${legacy.id}/`;
      const sessionKeys = await store.list(sessionPrefix);
      await Promise.all(
        sessionKeys.map((key) => store.delete(key)),
      );
      result.sessionsRevoked += sessionKeys.length;

      for (const identity of localIdentities) {
        const digest = await indexValue(
          `local|${identity.subject}`,
        );
        await store.delete(`identities/${digest}.json`);
        result.identityIndexesRemoved += 1;
      }
      result.usersSanitized += 1;
      break;
    }
  }
  return result;
}
