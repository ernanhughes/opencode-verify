import { canonicalize, sha256Hex } from "./canonical";

// Worker objectives may carry bounded, authoritative application context;
// claims must preserve the same statement without truncation.
export const MAX_CLAIM_STATEMENT_CHARS = 65536;
export const MAX_CLAIM_SCOPE_BYTES = 16_384;
export const CLAIM_ID_PATTERN = /^cl_[0-9a-f]{32}$/;

export type Claim = {
  claim_id: string;
  statement: string;
  subject?: string;
  scope?: Record<string, unknown>;
};

export type ClaimValidation =
  | { ok: true; claim: Claim }
  | { ok: false; code: string; message: string };

function fail(code: string, message: string): ClaimValidation {
  return { ok: false, code, message };
}

/**
 * Claim identity (v0.1): content-derived unless the caller supplies an id.
 * claim_id = "cl_" + sha256(canonical({statement, subject ?? null,
 * scope ?? null}))[0:32]. A receipt references the exact normalized claim
 * it evaluated, so identical claim text always verifies under one identity.
 */
export function deriveClaimId(input: {
  statement: string;
  subject?: string;
  scope?: Record<string, unknown>;
}): string {
  return `cl_${sha256Hex(canonicalize({ statement: input.statement, subject: input.subject ?? null, scope: input.scope ?? null })).slice(0, 32)}`;
}

export function normalizeClaim(input: unknown): ClaimValidation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fail("INVALID_CLAIM", "claim must be a JSON object");
  }
  const c = input as Record<string, unknown>;
  if (typeof c["statement"] !== "string" || c["statement"].length === 0) {
    return fail("INVALID_CLAIM", "claim.statement must be a non-empty string");
  }
  if (c["statement"].length > MAX_CLAIM_STATEMENT_CHARS) {
    return fail(
      "INVALID_CLAIM",
      `claim.statement is ${c["statement"].length} chars (cap ${MAX_CLAIM_STATEMENT_CHARS})`,
    );
  }
  if (c["subject"] !== undefined && typeof c["subject"] !== "string") {
    return fail("INVALID_CLAIM", "claim.subject must be a string when present");
  }
  let scope: Record<string, unknown> | undefined;
  if (c["scope"] !== undefined) {
    if (typeof c["scope"] !== "object" || c["scope"] === null || Array.isArray(c["scope"])) {
      return fail("INVALID_CLAIM", "claim.scope must be an object when present");
    }
    scope = c["scope"] as Record<string, unknown>;
    let bytes: number;
    try {
      bytes = canonicalize(scope).length;
    } catch {
      return fail("INVALID_CLAIM", "claim.scope must be canonicalizable JSON");
    }
    if (bytes > MAX_CLAIM_SCOPE_BYTES) {
      return fail("INVALID_CLAIM", `claim.scope is ${bytes} bytes (cap ${MAX_CLAIM_SCOPE_BYTES})`);
    }
  }
  const claim: Claim = {
    claim_id: "",
    statement: c["statement"],
    ...(typeof c["subject"] === "string" ? { subject: c["subject"] } : {}),
    ...(scope !== undefined ? { scope } : {}),
  };
  if (c["claim_id"] !== undefined) {
    if (typeof c["claim_id"] !== "string" || !CLAIM_ID_PATTERN.test(c["claim_id"])) {
      return fail("INVALID_CLAIM", "claim.claim_id must match /^cl_[0-9a-f]{32}$/ when supplied");
    }
    claim.claim_id = c["claim_id"];
  } else {
    claim.claim_id = deriveClaimId(claim);
  }
  return { ok: true, claim };
}
