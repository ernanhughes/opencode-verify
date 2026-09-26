import { canonicalize, sha256Hex } from "./canonical";
import type { Claim } from "./claim";
import type { VerificationCriterion } from "./criterion";
import type { Evaluation } from "./evaluate";
import type { EvidenceRecord } from "./evidence-contract";
import { PLUGIN_ID, PLUGIN_VERSION, VERIFICATION_SCHEMA } from "./version";

export type VerificationVerdict = "PASS" | "FAIL" | "INCONCLUSIVE";

export const VERDICTS: readonly string[] = ["PASS", "FAIL", "INCONCLUSIVE"];

export type VerificationReceipt = {
  schema: typeof VERIFICATION_SCHEMA;
  verification_id: string;
  claim: Claim;
  criterion: VerificationCriterion;
  evidence_ids: string[];
  /** content_hash of each evaluated record: binds the exact bytes checked. */
  evidence_hashes: Record<string, string>;
  verdict: VerificationVerdict;
  evaluation: {
    result: "TRUE" | "FALSE" | "UNKNOWN";
    reason_code: string;
    details: unknown;
  };
  evaluated_at: string;
  verifier: {
    plugin: typeof PLUGIN_ID;
    version: string;
  };
  content_hash: string;
};

/**
 * Receipt-side verdict-shaped fields that must never appear. The receipt's
 * own `verdict` is its job; task completion, authority, proof, and
 * confidence belong to other components (Work, Authority, Proof) or to no
 * deterministic component at all.
 */
const FORBIDDEN_RECEIPT_FIELDS: readonly string[] = [
  "task_complete",
  "task_completed",
  "task_success",
  "authorized",
  "allowed",
  "denied",
  "proof",
  "confidence",
  "trust_score",
];

export const VERIFICATION_ID_PATTERN = /^vr_[0-9a-f]{32}$/;
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

export function verdictFor(result: "TRUE" | "FALSE" | "UNKNOWN"): VerificationVerdict {
  if (result === "TRUE") return "PASS";
  if (result === "FALSE") return "FAIL";
  return "INCONCLUSIVE";
}

/**
 * Receipt identity (v0.1):
 * verification_id = "vr_" + sha256(canonical({
 *   schema, claim, criterion, evidence_ids(sorted), evidence_hashes,
 *   verdict, evaluation.result, evaluation.reason_code,
 *   verifier: {plugin, version}
 * }))[0:32]
 *
 * Included: claim + criterion + exact evidence (ids AND hashes) + outcome +
 * verifier identity/version. Evaluator semantics can change between
 * versions, so the version participates in identity — unlike Evidence,
 * where the producer was excluded.
 * Excluded: evaluated_at (provenance, not content: re-evaluating the same
 * inputs is idempotent and returns the originally recorded timestamp) and
 * storage path.
 *
 * content_hash covers the same decision inputs as the identity (minus
 * content_hash itself and minus evaluated_at). Consequence, stated plainly:
 * tampering with evaluated_at alone is NOT detected by the hash — it is
 * annotation, not decision. Tampering with anything that determined the
 * outcome IS detected. This mirrors Evidence, where observed_at is likewise
 * outside the hash.
 */
export function receiptIdentityInput(input: {
  claim: Claim;
  criterion: VerificationCriterion;
  evidence_ids: string[];
  evidence_hashes: Record<string, string>;
  verdict: VerificationVerdict;
  result: string;
  reason_code: string;
  verifierVersion: string;
}): Record<string, unknown> {
  return {
    criterion: input.criterion,
    claim: {
      claim_id: input.claim.claim_id,
      scope: input.claim.scope ?? null,
      statement: input.claim.statement,
      subject: input.claim.subject ?? null,
    },
    evidence_hashes: input.evidence_hashes,
    evidence_ids: [...input.evidence_ids].sort(),
    reason_code: input.reason_code,
    result: input.result,
    schema: VERIFICATION_SCHEMA,
    verdict: input.verdict,
    verifier: { plugin: PLUGIN_ID, version: input.verifierVersion },
  };
}

export function deriveVerificationId(identityInput: Record<string, unknown>): string {
  return `vr_${sha256Hex(canonicalize(identityInput)).slice(0, 32)}`;
}

function receiptBodyHash(receipt: Record<string, unknown>): string {
  const { content_hash: _hashOmitted, evaluated_at: _timeOmitted, ...body } = receipt;
  return sha256Hex(canonicalize(body));
}

export function buildReceipt(input: {
  claim: Claim;
  criterion: VerificationCriterion;
  evidence: EvidenceRecord[];
  evaluation: Evaluation;
  evaluated_at?: string;
  verifierVersion?: string;
}): VerificationReceipt {
  const evidence_ids = [...new Set(input.evidence.map((r) => r.evidence_id))].sort();
  const evidence_hashes: Record<string, string> = {};
  for (const id of evidence_ids) {
    const rec = input.evidence.find((r) => r.evidence_id === id);
    if (rec) evidence_hashes[id] = rec.content_hash;
  }
  const verdict = verdictFor(input.evaluation.result);
  const verifierVersion = input.verifierVersion ?? PLUGIN_VERSION;
  const identity = receiptIdentityInput({
    claim: input.claim,
    criterion: input.criterion,
    evidence_ids,
    evidence_hashes,
    verdict,
    result: input.evaluation.result,
    reason_code: input.evaluation.reason_code,
    verifierVersion,
  });
  const evaluated_at = input.evaluated_at ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(evaluated_at))) {
    throw new Error("INVALID_RECEIPT_TIME: evaluated_at must be a parseable timestamp string");
  }
  const receipt: VerificationReceipt = {
    schema: VERIFICATION_SCHEMA,
    verification_id: deriveVerificationId(identity),
    claim: input.claim,
    criterion: input.criterion,
    evidence_ids,
    evidence_hashes,
    verdict,
    evaluation: {
      result: input.evaluation.result,
      reason_code: input.evaluation.reason_code,
      details: input.evaluation.details,
    },
    evaluated_at,
    verifier: { plugin: PLUGIN_ID, version: verifierVersion },
    content_hash: "",
  };
  receipt.content_hash = receiptBodyHash(receipt as unknown as Record<string, unknown>);
  return receipt;
}

export type ReceiptValidation =
  | { ok: true; receipt: VerificationReceipt }
  | { ok: false; code: string; message: string };

function fail(code: string, message: string): ReceiptValidation {
  return { ok: false, code, message };
}

/** Structural validation of a parsed receipt. Never judges the verdict. */
export function validateReceipt(parsed: unknown): ReceiptValidation {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail("RECEIPT_MALFORMED", "receipt must be a JSON object");
  }
  const rec = parsed as Record<string, unknown>;
  for (const field of FORBIDDEN_RECEIPT_FIELDS) {
    if (rec[field] !== undefined) {
      return fail("RECEIPT_FORBIDDEN_FIELD", `receipt must not carry "${field}" (belongs to Work/Authority/Proof)`);
    }
  }
  if (rec["schema"] !== VERIFICATION_SCHEMA) {
    return fail("RECEIPT_SCHEMA_MISMATCH", `receipt schema must be "${VERIFICATION_SCHEMA}"`);
  }
  if (typeof rec["verification_id"] !== "string" || !VERIFICATION_ID_PATTERN.test(rec["verification_id"])) {
    return fail("RECEIPT_BAD_ID", "verification_id must match /^vr_[0-9a-f]{32}$/");
  }
  if (typeof rec["claim"] !== "object" || rec["claim"] === null) {
    return fail("RECEIPT_BAD_CLAIM", "claim must be an object");
  }
  if (typeof rec["criterion"] !== "object" || rec["criterion"] === null) {
    return fail("RECEIPT_BAD_CRITERION", "criterion must be an object");
  }
  if (!Array.isArray(rec["evidence_ids"]) || !rec["evidence_ids"].every((id) => typeof id === "string")) {
    return fail("RECEIPT_BAD_EVIDENCE", "evidence_ids must be an array of strings");
  }
  if (typeof rec["evidence_hashes"] !== "object" || rec["evidence_hashes"] === null || Array.isArray(rec["evidence_hashes"])) {
    return fail("RECEIPT_BAD_EVIDENCE", "evidence_hashes must be an object");
  }
  if (typeof rec["verdict"] !== "string" || !VERDICTS.includes(rec["verdict"])) {
    return fail("RECEIPT_BAD_VERDICT", "verdict must be one of PASS, FAIL, INCONCLUSIVE");
  }
  const evaluation = rec["evaluation"];
  if (typeof evaluation !== "object" || evaluation === null || Array.isArray(evaluation)) {
    return fail("RECEIPT_BAD_EVALUATION", "evaluation must be an object");
  }
  const ev = evaluation as Record<string, unknown>;
  if (ev["result"] !== "TRUE" && ev["result"] !== "FALSE" && ev["result"] !== "UNKNOWN") {
    return fail("RECEIPT_BAD_EVALUATION", "evaluation.result must be TRUE, FALSE, or UNKNOWN");
  }
  if (typeof ev["reason_code"] !== "string" || ev["reason_code"].length === 0) {
    return fail("RECEIPT_BAD_EVALUATION", "evaluation.reason_code must be a non-empty string");
  }
  if (ev["details"] === undefined) {
    return fail("RECEIPT_BAD_EVALUATION", "evaluation.details must be present");
  }
  const verdictMatches =
    (ev["result"] === "TRUE" && rec["verdict"] === "PASS") ||
    (ev["result"] === "FALSE" && rec["verdict"] === "FAIL") ||
    (ev["result"] === "UNKNOWN" && rec["verdict"] === "INCONCLUSIVE");
  if (!verdictMatches) {
    return fail("RECEIPT_VERDICT_MISMATCH", "verdict must match evaluation.result (TRUE->PASS, FALSE->FAIL, UNKNOWN->INCONCLUSIVE)");
  }
  if (typeof rec["evaluated_at"] !== "string" || Number.isNaN(Date.parse(rec["evaluated_at"]))) {
    return fail("RECEIPT_BAD_TIME", "evaluated_at must be a parseable timestamp string");
  }
  const verifier = rec["verifier"];
  if (typeof verifier !== "object" || verifier === null || Array.isArray(verifier)) {
    return fail("RECEIPT_BAD_VERIFIER", "verifier must be an object");
  }
  const vv = verifier as Record<string, unknown>;
  if (vv["plugin"] !== PLUGIN_ID) {
    return fail("RECEIPT_BAD_VERIFIER", `verifier.plugin must be "${PLUGIN_ID}"`);
  }
  if (typeof vv["version"] !== "string" || vv["version"].length === 0) {
    return fail("RECEIPT_BAD_VERIFIER", "verifier.version must be a non-empty string");
  }
  if (typeof rec["content_hash"] !== "string" || !CONTENT_HASH_PATTERN.test(rec["content_hash"])) {
    return fail("RECEIPT_BAD_HASH", "content_hash must be 64 lowercase hex chars");
  }
  return { ok: true, receipt: parsed as VerificationReceipt };
}

export type ReceiptIntegrity =
  | { ok: true; recomputed_id: string; recomputed_hash: string }
  | { ok: false; code: string; message: string };

/** Recompute verification_id and content_hash; any mismatch is tampering. */
export function checkReceiptIntegrity(receipt: VerificationReceipt): ReceiptIntegrity {
  const structural = validateReceipt(receipt);
  if (!structural.ok) {
    return { ok: false, code: structural.code, message: structural.message };
  }
  const identity = receiptIdentityInput({
    claim: receipt.claim,
    criterion: receipt.criterion,
    evidence_ids: receipt.evidence_ids,
    evidence_hashes: receipt.evidence_hashes,
    verdict: receipt.verdict,
    result: receipt.evaluation.result,
    reason_code: receipt.evaluation.reason_code,
    verifierVersion: receipt.verifier.version,
  });
  const recomputed_id = deriveVerificationId(identity);
  if (recomputed_id !== receipt.verification_id) {
    return {
      ok: false,
      code: "RECEIPT_ID_MISMATCH",
      message: `stored verification_id ${receipt.verification_id} != recomputed ${recomputed_id}`,
    };
  }
  const recomputed_hash = receiptBodyHash(receipt as unknown as Record<string, unknown>);
  if (recomputed_hash !== receipt.content_hash) {
    return {
      ok: false,
      code: "RECEIPT_HASH_MISMATCH",
      message: "stored content_hash does not match receipt body",
    };
  }
  return { ok: true, recomputed_id, recomputed_hash };
}
