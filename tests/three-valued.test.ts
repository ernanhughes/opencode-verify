import { describe, expect, test } from "bun:test";
import { evaluate } from "../src/evaluate";
import type { VerificationCriterion } from "../src/criterion";
import { commandRecord, tempEngine } from "./helpers";

const LEAF = {
  kind: "evidence_field",
  evidence_kind: "command_result",
  path: "observation.exit_code",
  operator: "EQUALS",
  expected: 0,
} as const;

const T = () => commandRecord(0);
const F = () => commandRecord(1);
const U = () => commandRecord(undefined);

function all(...cs: VerificationCriterion[]): VerificationCriterion {
  return { kind: "all", criteria: cs };
}
function any(...cs: VerificationCriterion[]): VerificationCriterion {
  return { kind: "any", criteria: cs };
}
function not(c: VerificationCriterion): VerificationCriterion {
  return { kind: "not", criterion: c };
}

describe("three-valued combination", () => {
  test("ALL truth table", () => {
    // Single-record worlds force each branch; multi-record worlds mix them.
    expect(evaluate(all(LEAF, LEAF), [T()]).result).toBe("TRUE");
    expect(evaluate(all(LEAF, LEAF), [F()]).result).toBe("FALSE");
    expect(evaluate(all(LEAF, LEAF), [U()]).result).toBe("UNKNOWN");
    // TRUE + UNKNOWN -> UNKNOWN (UNKNOWN never collapses into TRUE...)
    expect(evaluate(all(LEAF, { ...LEAF, path: "observation.missing" }), [T()]).result).toBe("UNKNOWN");
    // FALSE dominates UNKNOWN in ALL.
    expect(evaluate(all(LEAF, { ...LEAF, path: "observation.missing" }), [F()]).result).toBe("FALSE");
  });

  test("ANY truth table", () => {
    expect(evaluate(any(LEAF, LEAF), [T()]).result).toBe("TRUE");
    expect(evaluate(any(LEAF, LEAF), [F()]).result).toBe("FALSE");
    expect(evaluate(any(LEAF, LEAF), [U()]).result).toBe("UNKNOWN");
    // TRUE dominates UNKNOWN in ANY.
    expect(evaluate(any(LEAF, { ...LEAF, path: "observation.missing" }), [T()]).result).toBe("TRUE");
    // FALSE + UNKNOWN -> UNKNOWN (...nor into FALSE).
    expect(evaluate(any(LEAF, { ...LEAF, path: "observation.missing" }), [F()]).result).toBe("UNKNOWN");
  });

  test("NOT truth table", () => {
    expect(evaluate(not(LEAF), [T()]).result).toBe("FALSE");
    expect(evaluate(not(LEAF), [F()]).result).toBe("TRUE");
    expect(evaluate(not(LEAF), [U()]).result).toBe("UNKNOWN");
    expect(evaluate(not(LEAF), []).result).toBe("UNKNOWN");
  });

  test("multi-record existential leaf aggregation", () => {
    expect(evaluate(LEAF, [T(), F()]).result).toBe("TRUE");
    expect(evaluate(LEAF, [F(), F()]).result).toBe("FALSE");
    expect(evaluate(LEAF, [F(), U()]).result).toBe("UNKNOWN");
    expect(evaluate(LEAF, []).result).toBe("UNKNOWN");
    expect(evaluate(LEAF, []).reason_code).toBe("NO_APPLICABLE_EVIDENCE");
  });

  test("verdict mapping TRUE->PASS FALSE->FAIL UNKNOWN->INCONCLUSIVE", () => {
    const engine = tempEngine();
    const claim = { statement: "s" };
    const pass = engine.check({ claim, criterion: LEAF, evidence: [T()] });
    const fail = engine.check({ claim, criterion: LEAF, evidence: [F()] });
    const incon = engine.check({ claim, criterion: LEAF, evidence: [U()] });
    expect(pass.receipt.verdict).toBe("PASS");
    expect(pass.receipt.evaluation.result).toBe("TRUE");
    expect(fail.receipt.verdict).toBe("FAIL");
    expect(fail.receipt.evaluation.result).toBe("FALSE");
    expect(incon.receipt.verdict).toBe("INCONCLUSIVE");
    expect(incon.receipt.evaluation.result).toBe("UNKNOWN");
  });

  test("evaluation is deterministic under input reordering", () => {
    const engine = tempEngine();
    const claim = { statement: "s" };
    const a = engine.check({
      claim,
      criterion: LEAF,
      evidence: [T(), F()],
      evaluated_at: "2026-09-26T00:00:00.000Z",
    });
    const b = engine.check({
      claim,
      criterion: LEAF,
      evidence: [F(), T()],
      evaluated_at: "2026-09-26T01:00:00.000Z",
    });
    expect(a.receipt.verification_id).toBe(b.receipt.verification_id);
    expect(a.receipt.verdict).toBe(b.receipt.verdict);
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true); // re-check is idempotent, not a collision
    expect(b.receipt).toEqual(a.receipt);
  });
});
