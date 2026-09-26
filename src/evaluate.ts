import { canonicalize } from "./canonical";
import type { EvidenceFieldCriterion, TriState, VerificationCriterion } from "./criterion";
import type { EvidenceRecord } from "./evidence-contract";

export const MAX_DETAIL_STRING_CHARS = 2000;

export type PerRecordEval = {
  evidence_id: string;
  observed_at: string;
  present: boolean;
  actual?: unknown;
  actual_truncated?: boolean;
  result: TriState;
  reason_code: string;
};

export type EvalNode = {
  kind: string;
  operator?: string;
  path?: string;
  expected?: unknown;
  result: TriState;
  reason_code: string;
  evidence_ids?: string[];
  stale_excluded?: string[];
  per_record?: PerRecordEval[];
  children?: EvalNode[];
};

export type Evaluation = {
  result: TriState;
  reason_code: string;
  details: EvalNode;
};

function boundValue(value: unknown): { value: unknown; truncated: boolean } {
  if (typeof value === "string" && value.length > MAX_DETAIL_STRING_CHARS) {
    return { value: value.slice(0, MAX_DETAIL_STRING_CHARS), truncated: true };
  }
  return { value, truncated: false };
}

function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalize(a) === canonicalize(b);
}

type PathLookup = { present: boolean; value?: unknown };

/** Resolve a dot path rooted at the record. Arrays accept numeric indices. */
export function lookupPath(record: EvidenceRecord, path: string): PathLookup {
  const segments = path.split(".");
  let current: unknown = record;
  for (const seg of segments) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(seg) || Number(seg) >= current.length) return { present: false };
      current = current[Number(seg)];
    } else if (typeof current === "object" && current !== null) {
      const obj = current as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(obj, seg)) return { present: false };
      current = obj[seg];
    } else {
      return { present: false };
    }
  }
  if (current === undefined) return { present: false };
  return { present: true, value: current };
}

function leafApplicable(
  leaf: EvidenceFieldCriterion,
  record: EvidenceRecord,
): { applicable: boolean; stale: boolean } {
  if (leaf.evidence_kind !== undefined && record.kind !== leaf.evidence_kind) {
    return { applicable: false, stale: false };
  }
  if (leaf.evidence_id !== undefined && record.evidence_id !== leaf.evidence_id) {
    return { applicable: false, stale: false };
  }
  if (leaf.subject !== undefined && record.subject !== leaf.subject) {
    return { applicable: false, stale: false };
  }
  if (leaf.source_kind !== undefined && record.source.kind !== leaf.source_kind) {
    return { applicable: false, stale: false };
  }
  if (
    leaf.min_observed_at !== undefined &&
    record.observed_at < leaf.min_observed_at
  ) {
    return { applicable: false, stale: true };
  }
  return { applicable: true, stale: false };
}

function evalOperator(
  operator: EvidenceFieldCriterion["operator"],
  actual: unknown,
  present: boolean,
  expected: unknown,
): { result: TriState; reason_code: string } {
  if (operator === "EXISTS") {
    return present
      ? { result: "TRUE", reason_code: "EVIDENCE_VALUE_MATCH" }
      : { result: "FALSE", reason_code: "EVIDENCE_FIELD_ABSENT" };
  }
  if (!present) {
    return { result: "UNKNOWN", reason_code: "EVIDENCE_FIELD_MISSING" };
  }
  switch (operator) {
    case "EQUALS":
      return deepEqual(actual, expected)
        ? { result: "TRUE", reason_code: "EVIDENCE_VALUE_MATCH" }
        : { result: "FALSE", reason_code: "EVIDENCE_VALUE_MISMATCH" };
    case "NOT_EQUALS":
      return deepEqual(actual, expected)
        ? { result: "FALSE", reason_code: "EVIDENCE_VALUE_MISMATCH" }
        : { result: "TRUE", reason_code: "EVIDENCE_VALUE_MATCH" };
    case "CONTAINS": {
      if (typeof actual === "string" && typeof expected === "string") {
        return actual.includes(expected)
          ? { result: "TRUE", reason_code: "EVIDENCE_VALUE_MATCH" }
          : { result: "FALSE", reason_code: "EVIDENCE_VALUE_MISMATCH" };
      }
      if (Array.isArray(actual)) {
        return actual.some((item) => deepEqual(item, expected))
          ? { result: "TRUE", reason_code: "EVIDENCE_VALUE_MATCH" }
          : { result: "FALSE", reason_code: "EVIDENCE_VALUE_MISMATCH" };
      }
      return { result: "FALSE", reason_code: "TYPE_MISMATCH" };
    }
    case "MATCHES": {
      if (typeof actual !== "string" || typeof expected !== "string") {
        return { result: "FALSE", reason_code: "TYPE_MISMATCH" };
      }
      return new RegExp(expected).test(actual)
        ? { result: "TRUE", reason_code: "EVIDENCE_VALUE_MATCH" }
        : { result: "FALSE", reason_code: "EVIDENCE_VALUE_MISMATCH" };
    }
    case "GT":
    case "GTE":
    case "LT":
    case "LTE": {
      if (typeof actual !== "number" || typeof expected !== "number") {
        return { result: "FALSE", reason_code: "TYPE_MISMATCH" };
      }
      let holds = false;
      if (operator === "GT") holds = actual > expected;
      if (operator === "GTE") holds = actual >= expected;
      if (operator === "LT") holds = actual < expected;
      if (operator === "LTE") holds = actual <= expected;
      return holds
        ? { result: "TRUE", reason_code: "EVIDENCE_VALUE_MATCH" }
        : { result: "FALSE", reason_code: "EVIDENCE_VALUE_MISMATCH" };
    }
  }
}

/**
 * Existential combination over matching records: TRUE if any record is
 * TRUE; FALSE if at least one record matched and all are FALSE; else
 * UNKNOWN. Never collapses UNKNOWN into FALSE.
 */
function combineAny(results: TriState[]): TriState {
  if (results.includes("TRUE")) return "TRUE";
  if (results.length > 0 && results.every((r) => r === "FALSE")) return "FALSE";
  return "UNKNOWN";
}

function unknownReason(subs: { result: TriState; reason_code: string }[]): string {
  const unknowns = subs.filter((s) => s.result === "UNKNOWN").map((s) => s.reason_code);
  if (unknowns.includes("NO_APPLICABLE_EVIDENCE")) return "NO_APPLICABLE_EVIDENCE";
  if (unknowns.includes("EVIDENCE_FIELD_MISSING")) return "EVIDENCE_FIELD_MISSING";
  return "COMPOSITE_UNKNOWN";
}

function evalLeaf(leaf: EvidenceFieldCriterion, records: EvidenceRecord[]): EvalNode {
  const stale_excluded: string[] = [];
  const applicable: EvidenceRecord[] = [];
  for (const record of records) {
    const sel = leafApplicable(leaf, record);
    if (sel.stale) stale_excluded.push(record.evidence_id);
    else if (sel.applicable) applicable.push(record);
  }
  const node: EvalNode = {
    kind: "evidence_field",
    operator: leaf.operator,
    path: leaf.path,
    ...(leaf.expected !== undefined ? { expected: boundValue(leaf.expected).value } : {}),
    result: "UNKNOWN",
    reason_code: "NO_APPLICABLE_EVIDENCE",
    evidence_ids: applicable.map((r) => r.evidence_id),
    ...(stale_excluded.length > 0 ? { stale_excluded } : {}),
  };
  if (applicable.length === 0) return node;

  const per_record: PerRecordEval[] = applicable.map((record) => {
    const lookup = lookupPath(record, leaf.path);
    const op = evalOperator(leaf.operator, lookup.value, lookup.present, leaf.expected);
    const bounded = lookup.present ? boundValue(lookup.value) : null;
    return {
      evidence_id: record.evidence_id,
      observed_at: record.observed_at,
      present: lookup.present,
      ...(bounded !== null
        ? { actual: bounded.value, ...(bounded.truncated ? { actual_truncated: true } : {}) }
        : {}),
      result: op.result,
      reason_code: op.reason_code,
    };
  });
  const result = combineAny(per_record.map((p) => p.result));
  let reason_code: string;
  if (result === "TRUE") {
    reason_code = "EVIDENCE_VALUE_MATCH";
  } else if (result === "FALSE") {
    reason_code = per_record.some((p) => p.reason_code === "EVIDENCE_VALUE_MISMATCH")
      ? "EVIDENCE_VALUE_MISMATCH"
      : "TYPE_MISMATCH";
  } else {
    reason_code = unknownReason(per_record);
  }
  node.per_record = per_record;
  node.result = result;
  node.reason_code = reason_code;
  return node;
}

function evalAll(children: EvalNode[]): { result: TriState; reason_code: string } {
  if (children.some((c) => c.result === "FALSE")) return { result: "FALSE", reason_code: "COMPOSITE_FALSE" };
  if (children.some((c) => c.result === "UNKNOWN")) {
    return { result: "UNKNOWN", reason_code: unknownReason(children) };
  }
  return { result: "TRUE", reason_code: "COMPOSITE_TRUE" };
}

function evalAny(children: EvalNode[]): { result: TriState; reason_code: string } {
  if (children.some((c) => c.result === "TRUE")) return { result: "TRUE", reason_code: "COMPOSITE_TRUE" };
  if (children.some((c) => c.result === "UNKNOWN")) {
    return { result: "UNKNOWN", reason_code: unknownReason(children) };
  }
  return { result: "FALSE", reason_code: "COMPOSITE_FALSE" };
}

function evalNot(child: EvalNode): { result: TriState; reason_code: string } {
  if (child.result === "TRUE") return { result: "FALSE", reason_code: "COMPOSITE_FALSE" };
  if (child.result === "FALSE") return { result: "TRUE", reason_code: "COMPOSITE_TRUE" };
  return { result: "UNKNOWN", reason_code: "COMPOSITE_UNKNOWN" };
}

export function evalCriterion(
  criterion: VerificationCriterion,
  records: EvidenceRecord[],
): EvalNode {
  // Sorted input order keeps evaluation deterministic regardless of supply order.
  const ordered = [...records].sort((a, b) => (a.evidence_id < b.evidence_id ? -1 : 1));
  if (criterion.kind === "evidence_field") return evalLeaf(criterion, ordered);
  if (criterion.kind === "not") {
    const child = evalCriterion(criterion.criterion as VerificationCriterion, ordered);
    const combo = evalNot(child);
    return { kind: "not", result: combo.result, reason_code: combo.reason_code, children: [child] };
  }
  const children = (criterion.criteria as VerificationCriterion[]).map((c) => evalCriterion(c, ordered));
  const combo = criterion.kind === "all" ? evalAll(children) : evalAny(children);
  return {
    kind: criterion.kind,
    result: combo.result,
    reason_code: combo.reason_code,
    children,
  };
}

/** Outer boundary: TRUE -> caller maps to PASS, FALSE -> FAIL, UNKNOWN -> INCONCLUSIVE. */
export function evaluate(
  criterion: VerificationCriterion,
  records: EvidenceRecord[],
): Evaluation {
  const details = evalCriterion(criterion, records);
  let reason_code: string;
  if (details.result === "TRUE") reason_code = "CRITERION_SATISFIED";
  else if (details.result === "FALSE") reason_code = "CRITERION_VIOLATED";
  else reason_code = details.reason_code;
  return { result: details.result, reason_code, details };
}
