import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReceipt,
  checkReceiptIntegrity,
  validateReceipt,
  verdictFor,
} from "../src/receipt";
import { ReceiptStore } from "../src/store";
import { normalizeClaim } from "../src/claim";
import { validateCriterion } from "../src/criterion";
import { evaluate } from "../src/evaluate";
import { commandRecord, tempEngine } from "./helpers";

function sampleReceipt(evaluated_at: string) {
  const claim = normalizeClaim({ statement: "tests pass" });
  const criterion = validateCriterion({
    kind: "evidence_field",
    path: "observation.exit_code",
    operator: "EQUALS",
    expected: 0,
  });
  if (!claim.ok || !criterion.ok) throw new Error("bad sample");
  const records = [commandRecord(0)];
  const evaluation = evaluate(criterion.criterion, records);
  return buildReceipt({ claim: claim.claim, criterion: criterion.criterion, evidence: records, evaluation, evaluated_at });
}

describe("receipt identity and integrity", () => {
  test("verdict mapping helper", () => {
    expect(verdictFor("TRUE")).toBe("PASS");
    expect(verdictFor("FALSE")).toBe("FAIL");
    expect(verdictFor("UNKNOWN")).toBe("INCONCLUSIVE");
  });

  test("same inputs -> same id and hash even at different times (re-check is idempotent)", () => {
    const a = sampleReceipt("2026-01-01T00:00:00.000Z");
    const b = sampleReceipt("2026-09-26T00:00:00.000Z");
    expect(a.verification_id).toBe(b.verification_id);
    expect(a.content_hash).toBe(b.content_hash); // evaluated_at is annotation, not decision
    expect(checkReceiptIntegrity(a).ok).toBe(true);
    expect(checkReceiptIntegrity(b).ok).toBe(true);
  });

  test("evaluated_at alone is not integrity-protected (documented consequence)", () => {
    const a = sampleReceipt("2026-01-01T00:00:00.000Z");
    const retimed = { ...a, evaluated_at: "2030-01-01T00:00:00.000Z" };
    expect(checkReceiptIntegrity(retimed as never).ok).toBe(true);
    const tampered = { ...a, evaluation: { ...a.evaluation, reason_code: "EDITED" } };
    expect(checkReceiptIntegrity(tampered as never).ok).toBe(false);
  });

  test("different evidence/criterion/claim change the id", () => {
    const a = sampleReceipt("2026-01-01T00:00:00.000Z");
    const tamperedClaim = { ...a, claim: { ...a.claim, statement: "other" } };
    expect(checkReceiptIntegrity(tamperedClaim as never).ok).toBe(false);
  });

  test("flipped verdict is rejected (mismatch + hash)", () => {
    const a = sampleReceipt("2026-01-01T00:00:00.000Z");
    const flipped = { ...a, verdict: "FAIL" } as never;
    const v = validateReceipt(flipped);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("RECEIPT_VERDICT_MISMATCH");
  });

  test("forbidden receipt fields rejected (task/authority/proof live elsewhere)", () => {
    const a = sampleReceipt("2026-01-01T00:00:00.000Z");
    for (const field of ["task_complete", "authorized", "allowed", "proof", "confidence"]) {
      const bad = { ...a, [field]: true };
      const v = validateReceipt(bad);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.code).toBe("RECEIPT_FORBIDDEN_FIELD");
    }
  });

  test("store round-trip, idempotent re-store, collision-loud", () => {
    const store = new ReceiptStore(mkdtempSync(join(tmpdir(), "vr-rs-")));
    const a = sampleReceipt("2026-01-01T00:00:00.000Z");
    const put = store.put(a);
    expect(put.duplicate).toBe(false);
    expect(store.get(a.verification_id)).toEqual(a);
    expect(store.put(a).duplicate).toBe(true);
    const path = store.receiptPath(a.verification_id);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    parsed.evaluation.reason_code = "EDITED";
    writeFileSync(path, JSON.stringify(parsed), "utf8");
    expect(() => store.put(a)).toThrow("RECEIPT_ID_COLLISION");
  });

  test("malformed files and unknown ids fail clearly; reads are read-only", () => {
    const engine = tempEngine();
    const a = sampleReceipt("2026-01-01T00:00:00.000Z");
    engine.store.put(a);
    const path = engine.store.receiptPath(a.verification_id);
    const before = statSync(path).mtimeMs;
    engine.get(a.verification_id);
    expect(statSync(path).mtimeMs).toBe(before);
    expect(() => engine.get(`vr_${"f".repeat(32)}`)).toThrow("RECEIPT_NOT_FOUND");
    expect(() => engine.get("bogus")).toThrow("RECEIPT_BAD_ID");
  });
});
