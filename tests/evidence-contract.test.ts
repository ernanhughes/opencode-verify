import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkEvidenceIntegrity,
  recomputeEvidenceHash,
  validateEvidenceRecord,
} from "../src/evidence-contract";
import { makeRecord } from "./helpers";

/**
 * The fixture is tests/fixtures/evidence-example.json: byte-identical to
 * opencode-evidence@88cc2e6 evidence.example.json (a real record produced
 * by upstream code). If the vendored contract drifts, these fail.
 */
function fixture(): unknown {
  return JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "evidence-example.json"), "utf8"));
}

describe("evidence contract (upstream pin)", () => {
  test("real upstream record validates", () => {
    const v = validateEvidenceRecord(fixture());
    expect(v.ok).toBe(true);
  });

  test("vendored code reproduces the upstream hash and id byte-exactly", () => {
    const v = validateEvidenceRecord(fixture());
    if (!v.ok) throw new Error("fixture failed validation");
    expect(recomputeEvidenceHash(v.record)).toBe(v.record.content_hash);
    expect(v.record.content_hash).toBe(
      "e2da7b2f71a12f38894de2350ab5373a0b39d8f79f8803784b35af2ed7965dc5",
    );
    expect(v.record.evidence_id).toBe("ev_e2da7b2f71a12f38894de2350ab5373a");
    expect(checkEvidenceIntegrity(v.record).ok).toBe(true);
  });

  test("tampered observation fails integrity, not a verdict", () => {
    const rec = { ...(fixture() as Record<string, unknown>), observation: { exit_code: 999 } };
    const v = validateEvidenceRecord(rec);
    expect(v.ok).toBe(true); // structurally fine...
    if (v.ok) {
      const i = checkEvidenceIntegrity(v.record);
      expect(i.ok).toBe(false);
      if (!i.ok) expect(i.code).toBe("EVIDENCE_INTEGRITY_FAILURE");
    }
  });

  test("unsupported evidence schema fails clearly", () => {
    const rec = { ...(fixture() as Record<string, unknown>), schema: "opencode.evidence.v99" };
    const v = validateEvidenceRecord(rec);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("UNSUPPORTED_EVIDENCE_SCHEMA");
  });

  test("verdict-shaped top-level fields are rejected", () => {
    for (const field of ["verified", "verdict", "confidence", "task_success", "success"]) {
      const rec = { ...(fixture() as Record<string, unknown>), [field]: true };
      const v = validateEvidenceRecord(rec);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.code).toBe("INVALID_EVIDENCE");
    }
  });

  test("wrong producer plugin is rejected (mirrors upstream)", () => {
    const rec = {
      ...(fixture() as Record<string, unknown>),
      producer: { plugin: "something-else", version: "1.0" },
    };
    expect(validateEvidenceRecord(rec).ok).toBe(false);
  });

  test("malformed ids, hashes, and non-objects rejected", () => {
    expect(validateEvidenceRecord(null).ok).toBe(false);
    expect(validateEvidenceRecord([]).ok).toBe(false);
    const badId = { ...(fixture() as Record<string, unknown>), evidence_id: "nope" };
    expect(validateEvidenceRecord(badId).ok).toBe(false);
    const badHash = { ...(fixture() as Record<string, unknown>), content_hash: "zz" };
    expect(validateEvidenceRecord(badHash).ok).toBe(false);
    const missing = makeRecord({ observation: { a: 1 } }) as unknown as Record<string, unknown>;
    delete missing["observation"];
    const v = validateEvidenceRecord(missing);
    expect(v.ok).toBe(false);
  });
});
