export type TriState = "TRUE" | "FALSE" | "UNKNOWN";

export type LeafOperator =
  | "EQUALS"
  | "NOT_EQUALS"
  | "CONTAINS"
  | "MATCHES"
  | "GT"
  | "GTE"
  | "LT"
  | "LTE"
  | "EXISTS";

export const LEAF_OPERATORS: readonly string[] = [
  "EQUALS",
  "NOT_EQUALS",
  "CONTAINS",
  "MATCHES",
  "GT",
  "GTE",
  "LT",
  "LTE",
  "EXISTS",
];

export type EvidenceFieldCriterion = {
  kind: "evidence_field";
  /** Dot path rooted at the EvidenceRecord, e.g. "observation.exit_code". */
  path: string;
  operator: LeafOperator;
  /** Required for every operator except EXISTS (which must not carry it). */
  expected?: unknown;
  /** Which records this leaf may consume. All present selectors must match. */
  evidence_kind?: string;
  evidence_id?: string;
  subject?: string;
  source_kind?: string;
  /**
   * Simple deterministic freshness gate: only records with
   * observed_at >= min_observed_at are applicable. Older records are
   * excluded (counted in details), never silently evaluated.
   */
  min_observed_at?: string;
};

export type CompositeCriterion = {
  kind: "all" | "any" | "not";
  criteria?: VerificationCriterion[];
  criterion?: VerificationCriterion;
};

export type VerificationCriterion = EvidenceFieldCriterion | CompositeCriterion;

export type CriterionValidation =
  | { ok: true; criterion: VerificationCriterion }
  | { ok: false; code: string; message: string };

function fail(code: string, message: string): CriterionValidation {
  return { ok: false, code, message };
}

function validateLeaf(c: Record<string, unknown>, where: string): CriterionValidation {
  if (typeof c["path"] !== "string" || c["path"].length === 0) {
    return fail("INVALID_CRITERION", `${where}: evidence_field.path must be a non-empty string`);
  }
  if (typeof c["operator"] !== "string" || !LEAF_OPERATORS.includes(c["operator"])) {
    return fail(
      "UNSUPPORTED_OPERATOR",
      `${where}: operator must be one of ${LEAF_OPERATORS.join(", ")}`,
    );
  }
  const operator = c["operator"] as LeafOperator;
  const hasExpected = c["expected"] !== undefined;
  if (operator === "EXISTS") {
    if (hasExpected) {
      return fail("INVALID_CRITERION", `${where}: EXISTS must not carry expected`);
    }
  } else if (!hasExpected) {
    return fail("INVALID_CRITERION", `${where}: ${operator} requires expected`);
  }
  if ((operator === "GT" || operator === "GTE" || operator === "LT" || operator === "LTE") && typeof c["expected"] !== "number") {
    return fail("INVALID_CRITERION", `${where}: ${operator} requires a numeric expected`);
  }
  if (operator === "MATCHES") {
    if (typeof c["expected"] !== "string") {
      return fail("INVALID_CRITERION", `${where}: MATCHES requires a string regex in expected`);
    }
    try {
      new RegExp(c["expected"]);
    } catch {
      return fail("INVALID_CRITERION", `${where}: MATCHES expected is not a valid regex`);
    }
  }
  for (const sel of ["evidence_kind", "evidence_id", "subject", "source_kind"] as const) {
    if (c[sel] !== undefined && typeof c[sel] !== "string") {
      return fail("INVALID_CRITERION", `${where}: ${sel} selector must be a string when present`);
    }
  }
  if (c["min_observed_at"] !== undefined) {
    if (typeof c["min_observed_at"] !== "string" || Number.isNaN(Date.parse(c["min_observed_at"]))) {
      return fail("INVALID_CRITERION", `${where}: min_observed_at must be a parseable timestamp`);
    }
  }
  // Reject unknown keys: a misspelled operator/selector must fail closed, not be ignored.
  const allowed = new Set([
    "kind",
    "path",
    "operator",
    "expected",
    "evidence_kind",
    "evidence_id",
    "subject",
    "source_kind",
    "min_observed_at",
  ]);
  for (const key of Object.keys(c)) {
    if (!allowed.has(key)) {
      return fail("INVALID_CRITERION", `${where}: unknown field "${key}"`);
    }
  }
  return { ok: true, criterion: c as unknown as VerificationCriterion };
}

export function validateCriterion(input: unknown, where = "criterion"): CriterionValidation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fail("INVALID_CRITERION", `${where}: criterion must be a JSON object`);
  }
  const c = input as Record<string, unknown>;
  if (c["kind"] === "evidence_field") return validateLeaf(c, where);
  if (c["kind"] === "all" || c["kind"] === "any") {
    if (!Array.isArray(c["criteria"]) || c["criteria"].length === 0) {
      return fail("INVALID_CRITERION", `${where}: ${String(c["kind"])} requires a non-empty criteria array`);
    }
    const criteria: VerificationCriterion[] = [];
    for (let i = 0; i < c["criteria"].length; i++) {
      const sub = validateCriterion(c["criteria"][i], `${where}.${String(c["kind"])}[${i}]`);
      if (!sub.ok) return sub;
      criteria.push(sub.criterion);
    }
    return { ok: true, criterion: { kind: c["kind"], criteria } };
  }
  if (c["kind"] === "not") {
    if (c["criterion"] === undefined) {
      return fail("INVALID_CRITERION", `${where}: not requires a single criterion`);
    }
    const sub = validateCriterion(c["criterion"], `${where}.not`);
    if (!sub.ok) return sub;
    return { ok: true, criterion: { kind: "not", criterion: sub.criterion } };
  }
  return fail(
    "INVALID_CRITERION",
    `${where}: kind must be one of evidence_field, all, any, not`,
  );
}
