import { argon2id } from "hash-wasm";

export type Values = Record<string, string>;
export type Params = {
  memory: number;
  iterations: number;
  parallelism: number;
};
export type Envelope = {
  version: 1;
  keys: string[];
  encryption: {
    algorithm: "AES-256-GCM";
    kdf: "Argon2id";
    salt: string;
    nonce: string;
    ciphertext: string;
    params: Params;
  };
};
export type Session = {
  key: CryptoKey;
  salt: string;
  params: Params;
  values: Values;
};
const utf8 = new TextEncoder();
const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
export const validKey = (key: string) =>
  /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+$/.test(key) && key.length <= 200;
function validateValues(value: unknown): asserts value is Values {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.entries(value).some(
      ([k, v]) => !validKey(k) || typeof v !== "string",
    )
  )
    throw new Error("Invalid vault payload");
}
export function parseEnvelope(raw: string): Envelope {
  const e = JSON.parse(raw) as Envelope;
  const x = e?.encryption,
    p = x?.params;
  if (
    e.version !== 1 ||
    !Array.isArray(e.keys) ||
    e.keys.some((k) => typeof k !== "string" || !validKey(k)) ||
    new Set(e.keys).size !== e.keys.length ||
    x?.algorithm !== "AES-256-GCM" ||
    x?.kdf !== "Argon2id" ||
    !p ||
    !Number.isInteger(p.memory) ||
    p.memory < 65536 ||
    p.memory > 262144 ||
    !Number.isInteger(p.iterations) ||
    p.iterations < 3 ||
    p.iterations > 10 ||
    p.parallelism !== 1 ||
    unb64(x.salt).length !== 16 ||
    unb64(x.nonce).length !== 12 ||
    unb64(x.ciphertext).length < 16
  )
    throw new Error("Unsupported or malformed vault");
  return e;
}
async function derive(
  password: string,
  salt: string,
  params: Params,
): Promise<CryptoKey> {
  const passwordBytes = utf8.encode(password.normalize("NFC"));
  try {
    const bytes = await argon2id({
      password: passwordBytes,
      salt: unb64(salt),
      memorySize: params.memory,
      iterations: params.iterations,
      parallelism: params.parallelism,
      hashLength: 32,
      outputType: "binary",
    });
    try {
      return await crypto.subtle.importKey(
        "raw",
        bytes as Uint8Array<ArrayBuffer>,
        "AES-GCM",
        false,
        ["encrypt", "decrypt"],
      );
    } finally {
      bytes.fill(0);
    }
  } finally {
    passwordBytes.fill(0);
  }
}
function aad(e: Envelope): Uint8Array<ArrayBuffer> {
  const x = e.encryption;
  return utf8.encode(
    JSON.stringify({
      version: e.version,
      keys: e.keys,
      encryption: {
        algorithm: x.algorithm,
        kdf: x.kdf,
        salt: x.salt,
        nonce: x.nonce,
        params: {
          memory: x.params.memory,
          iterations: x.params.iterations,
          parallelism: x.params.parallelism,
        },
      },
    }),
  );
}
export async function createSession(
  password: string,
  values: Values = {},
): Promise<Session> {
  if (password.normalize("NFC").length < 10)
    throw new Error("Use a master password with at least 10 characters");
  validateValues(values);
  const salt = b64(random(16));
  const params = { memory: 65536, iterations: 3, parallelism: 1 };
  const start = performance.now();
  await derive(password, salt, params);
  params.iterations = Math.max(
    3,
    Math.min(10, Math.ceil((3 * 300) / Math.max(1, performance.now() - start))),
  );
  return {
    key: await derive(password, salt, params),
    salt,
    params,
    values: { ...values },
  };
}
export async function encrypt(session: Session): Promise<Envelope> {
  validateValues(session.values);
  const envelope: Envelope = {
    version: 1,
    keys: Object.keys(session.values).sort(),
    encryption: {
      algorithm: "AES-256-GCM",
      kdf: "Argon2id",
      salt: session.salt,
      nonce: b64(random(12)),
      ciphertext: "",
      params: { ...session.params },
    },
  };
  const bytes = utf8.encode(JSON.stringify(session.values));
  try {
    const cipher = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: unb64(envelope.encryption.nonce),
        additionalData: aad(envelope),
      },
      session.key,
      bytes,
    );
    envelope.encryption.ciphertext = b64(new Uint8Array(cipher));
    return envelope;
  } finally {
    bytes.fill(0);
  }
}
export async function unlock(raw: string, password: string): Promise<Session> {
  const e = parseEnvelope(raw);
  const key = await derive(password, e.encryption.salt, e.encryption.params);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: unb64(e.encryption.nonce),
          additionalData: aad(e),
        },
        key,
        unb64(e.encryption.ciphertext),
      ),
    );
  } catch {
    throw new Error("Incorrect password or modified vault");
  }
  try {
    const values: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    validateValues(values);
    if (JSON.stringify(Object.keys(values).sort()) !== JSON.stringify(e.keys))
      throw new Error("Vault key index does not match encrypted contents");
    return {
      key,
      salt: e.encryption.salt,
      params: e.encryption.params,
      values,
    };
  } finally {
    bytes.fill(0);
  }
}
export function references(markdown: string): string[] {
  return [...markdown.matchAll(/\{\{vault\.([a-zA-Z0-9_.-]+)\}\}/g)].map(
    (m) => m[1],
  );
}
export function auditReferences(notes: string[], keys: string[]) {
  const used = new Set(notes.flatMap(references));
  const index = new Set(keys);
  return {
    missing: [...used].filter((k) => !index.has(k)).sort(),
    unused: keys.filter((k) => !used.has(k)).sort(),
  };
}
