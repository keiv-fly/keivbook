import { describe, it, expect } from "vitest";
import {
  createSession,
  encrypt,
  unlock,
  parseEnvelope,
  auditReferences,
} from "./vault";
describe("encrypted vault", () => {
  it("round-trips Unicode passwords and values with fresh nonces", async () => {
    const s = await createSession("Café-password-🔐", {
      "personal.password": "секрет 🔑",
      "personal.username": "keiv",
    });
    const a = await encrypt(s),
      b = await encrypt(s);
    expect(a.encryption.nonce).not.toBe(b.encryption.nonce);
    expect(JSON.stringify(a)).not.toContain("секрет");
    expect(
      (await unlock(JSON.stringify(a), "Cafe\u0301-password-🔐")).values,
    ).toEqual(s.values);
    await expect(unlock(JSON.stringify(a), "wrong password")).rejects.toThrow(
      "Incorrect password",
    );
    a.keys.push("tampered.key");
    await expect(unlock(JSON.stringify(a), "Café-password-🔐")).rejects.toThrow(
      "modified vault",
    );
  }, 20000);
  it("rejects hostile KDF costs before allocating memory", () => {
    expect(() =>
      parseEnvelope(
        JSON.stringify({
          version: 1,
          keys: [],
          encryption: {
            algorithm: "AES-256-GCM",
            kdf: "Argon2id",
            params: { memory: 2 ** 31, iterations: 3, parallelism: 1 },
          },
        }),
      ),
    ).toThrow();
  });
  it("audits references without decrypting values", () => {
    expect(
      auditReferences(
        ["{{vault.personal.password}} {{vault.missing.key}}"],
        ["personal.password", "unused.key"],
      ),
    ).toEqual({ missing: ["missing.key"], unused: ["unused.key"] });
  });
});
