import {
  argon2id,
  argon2Verify,
} from "hash-wasm";

export type PasswordHashOptions = {
  memorySizeKiB?: number;
  iterations?: number;
  parallelism?: number;
};

export class PasswordHasher {
  private readonly memorySizeKiB: number;
  private readonly iterations: number;
  private readonly parallelism: number;
  private readonly pepperKey: Promise<CryptoKey>;
  private dummyHashPromise: Promise<string> | undefined;

  constructor(
    pepper: Uint8Array,
    options: PasswordHashOptions = {},
  ) {
    if (pepper.byteLength < 32) {
      throw new Error("Password pepper must contain at least 32 bytes");
    }
    this.memorySizeKiB = options.memorySizeKiB ?? 19_456;
    this.iterations = options.iterations ?? 2;
    this.parallelism = options.parallelism ?? 1;
    this.pepperKey = crypto.subtle.importKey(
      "raw",
      bufferView(pepper),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  }

  async hash(password: string): Promise<string> {
    validatePassword(password);
    return this.hashPrepared(await this.prepare(password));
  }

  async verify(
    password: string,
    encoded: string,
  ): Promise<boolean> {
    if (password.length > 4_096 || encoded.length > 2_048) {
      return false;
    }
    try {
      return await argon2Verify({
        password: await this.prepare(password),
        hash: encoded,
      });
    } catch {
      return false;
    }
  }

  async runDummyVerification(password: string): Promise<void> {
    this.dummyHashPromise ??= this.hashPrepared(
      crypto.getRandomValues(new Uint8Array(32)),
    );
    await this.verify(password, await this.dummyHashPromise);
  }

  private async prepare(password: string): Promise<Uint8Array> {
    const key = await this.pepperKey;
    return new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(password),
      ),
    );
  }

  private async hashPrepared(
    prepared: Uint8Array,
  ): Promise<string> {
    return argon2id({
      password: prepared,
      salt: crypto.getRandomValues(new Uint8Array(16)),
      parallelism: this.parallelism,
      iterations: this.iterations,
      memorySize: this.memorySizeKiB,
      hashLength: 32,
      outputType: "encoded",
    });
  }
}

export function validatePassword(password: string): void {
  const bytes = new TextEncoder().encode(password).byteLength;
  if (bytes < 12) {
    throw new Error("Password must contain at least 12 UTF-8 bytes");
  }
  if (bytes > 1_024) {
    throw new Error("Password exceeds the 1024-byte limit");
  }
}

function bufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}
