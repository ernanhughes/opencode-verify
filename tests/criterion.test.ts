import { describe, expect, test } from "bun:test";
import { validateCriterion } from "../src/criterion";

function leaf(overrides: Record<string, unknown> = {}) {
  return {
    kind: "evidence_field",
    path: "observation.exit_code",
    operator: "EQUALS",
    expected: 0,
    ...overrides,
  };
}

describe("criterion validation", () => {
  test("accepts leaves and composites", () => {
    expect(validateCriterion(leaf()).ok).toBe(true);
    expect(
      validateCriterion({ kind: "all", criteria: [leaf(), leaf({ expected: 1 })] }).ok,
    ).toBe(true);
    expect(validateCriterion({ kind: "any", criteria: [leaf()] }).ok).toBe(true);
    expect(validateCriterion({ kind: "not", criterion: leaf() }).ok).toBe(true);
    expect(validateCriterion({ ...leaf(), operator: "EXISTS", expected: undefined }).ok).toBe(true);
    expect(
      validateCriterion({ ...leaf(), min_observed_at: "2026-01-01T00:00:00.000Z" }).ok,
    ).toBe(true);
  });

  test("rejects unknown kinds, operators, and fields", () => {
    expect(validateCriterion({ kind: "sometimes" }).ok).toBe(false);
    const badOp = validateCriterion(leaf({ operator: "MAYBE" }));
    expect(badOp.ok).toBe(false);
    if (!badOp.ok) expect(badOp.code).toBe("UNSUPPORTED_OPERATOR");
    const badField = validateCriterion(leaf({ operatr: "EQUALS" }) as never);
    expect(badField.ok).toBe(false);
  });

  test("enforces expected presence/shape per operator", () => {
    const { expected: _drop, ...noExpected } = leaf();
    expect(validateCriterion(noExpected).ok).toBe(false);
    expect(validateCriterion(leaf({ operator: "EXISTS", expected: 0 })).ok).toBe(false);
    expect(validateCriterion(leaf({ operator: "GT", expected: "0" })).ok).toBe(false);
    expect(validateCriterion(leaf({ operator: "MATCHES", expected: 42 })).ok).toBe(false);
    expect(validateCriterion(leaf({ operator: "MATCHES", expected: "(unclosed" })).ok).toBe(false);
  });

  test("enforces composite shape and freshness format", () => {
    expect(validateCriterion({ kind: "all", criteria: [] }).ok).toBe(false);
    expect(validateCriterion({ kind: "any" }).ok).toBe(false);
    expect(validateCriterion({ kind: "not" }).ok).toBe(false);
    expect(validateCriterion({ kind: "all", criteria: [leaf(), { kind: "bogus" }] }).ok).toBe(false);
    expect(validateCriterion(leaf({ min_observed_at: "not-a-time" })).ok).toBe(false);
    expect(validateCriterion(leaf({ evidence_kind: 7 })).ok).toBe(false);
    for (const bad of [
      validateCriterion({ kind: "all", criteria: [] }),
      validateCriterion({ kind: "not" }),
      validateCriterion(leaf({ min_observed_at: "nope" })),
    ]) {
      if (!bad.ok) expect(bad.code).toBe("INVALID_CRITERION");
    }
  });
});
