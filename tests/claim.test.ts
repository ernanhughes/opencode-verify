import { describe, expect, test } from "bun:test";
import { deriveClaimId, normalizeClaim } from "../src/claim";

describe("claims", () => {
  test("valid claim derives a stable content id", () => {
    const a = normalizeClaim({ statement: "tests pass", subject: "suite" });
    const b = normalizeClaim({ subject: "suite", statement: "tests pass" });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.claim.claim_id).toBe(b.claim.claim_id);
      expect(a.claim.claim_id).toMatch(/^cl_[0-9a-f]{32}$/);
    }
  });

  test("different statements/subjects/scopes give different ids", () => {
    const ids = new Set(
      [
        normalizeClaim({ statement: "a" }),
        normalizeClaim({ statement: "b" }),
        normalizeClaim({ statement: "a", subject: "s" }),
        normalizeClaim({ statement: "a", scope: { env: "prod" } }),
      ].map((r) => (r.ok ? r.claim.claim_id : "INVALID")),
    );
    expect(ids.size).toBe(4);
  });

  test("explicit claim_id is kept when well-formed", () => {
    const id = deriveClaimId({ statement: "x" });
    const r = normalizeClaim({ claim_id: id, statement: "x" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.claim.claim_id).toBe(id);
  });

  test("invalid claims fail closed", () => {
    expect(normalizeClaim(null).ok).toBe(false);
    expect(normalizeClaim({}).ok).toBe(false);
    expect(normalizeClaim({ statement: "" }).ok).toBe(false);
    expect(normalizeClaim({ statement: 42 }).ok).toBe(false);
    expect(normalizeClaim({ statement: "x", claim_id: "bogus" }).ok).toBe(false);
    expect(normalizeClaim({ statement: "x", scope: [1] }).ok).toBe(false);
    expect(normalizeClaim({ statement: "x".repeat(65537) }).ok).toBe(false);
    for (const bad of [
      normalizeClaim(null),
      normalizeClaim({ statement: "" }),
      normalizeClaim({ statement: "x", claim_id: "bogus" }),
    ]) {
      if (!bad.ok) expect(bad.code).toBe("INVALID_CLAIM");
    }
  });
});
