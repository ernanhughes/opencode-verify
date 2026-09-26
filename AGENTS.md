# AGENTS.md — working rules for opencode-verify

This repo decides criterion satisfaction. It must never grow judgment beyond
that. Every rule below is a review gate.

## Hard boundaries

1. **Never collapse INCONCLUSIVE into FAIL.** Missing or inapplicable
   evidence is `UNKNOWN`. Tests pin this; keep them.
2. **Never infer a criterion from a claim in the deterministic core.**
   Criteria arrive from the caller. "Helpful" criterion synthesis is a
   different component (and a different risk class).
3. **Never treat model prose as external verification.** Caller-supplied
   words inside `observation` are inert data. A criterion may match them as
   bytes; that checks what the record *says*, never what is *true*.
4. **Never treat PASS as universal truth.** PASS = this criterion held on
   this evidence under this verifier version. Say exactly that.
5. **Never treat PASS as task completion.** No `task_complete`-shaped
   fields, outputs, or helpers. `FORBIDDEN` receipt fields are enforced —
   extend, never shrink, without review.
6. **Never treat PASS as authority.** No allow/deny/permit semantics. Ever.
7. **Never mutate evidence.** No writes to evidence stores, no
   "normalization" of records, no re-hashing into new ids. Read-only.
8. **Never silently accept failed evidence integrity.** Tampered or
   unsupported evidence is a request error, never a verdict input.
9. **Never introduce model inference into deterministic verification
   without an explicit new verifier class and architectural review.**
   A `src/` scan test bans model/network code — keep it green and extend
   the pattern list with any new threat.

## Determinism and purity

- New operators need unambiguous truth tables over `TRUE/FALSE/UNKNOWN`
  plus missing/type-mismatch behavior, all tested — including the
  `UNKNOWN`-preservation cases (`ALL(FALSE,UNKNOWN)→FALSE`,
  `ANY(TRUE,UNKNOWN)→TRUE`, `NOT(UNKNOWN)→UNKNOWN`).
- Unknown criterion fields fail closed. Strictness here is load-bearing:
  a typo must error, never silently narrow a check.
- Identity inputs are frozen (claim, criterion, evidence ids+hashes,
  outcome, verifier). `evaluated_at` stays annotation. Changing identity
  semantics orphans stored receipts — document and review.
- `ReceiptStore.get` stays read-only; `put` stays atomic + idempotent-at-
  engine + collision-loud-at-store.
- Keep dependencies boring: no model SDKs, no network, no embeddings.
  Justify every addition.

## Privacy and size

- Detail strings are capped (`MAX_DETAIL_STRING_CHARS`) with flags; raising
  caps needs justification, silent truncation is a bug.
- Default storage stays outside repos; receipts and evidence never mix.
- Never fetch evidence from anywhere the caller did not point at.

## Tests must pin boundaries, not only paths

- Every behavior needs its adversarial twin: tampered bytes, wrong schema,
  unresolvable refs, empty evidence, stale-only evidence, model-assertion
  records, reordered inputs, re-checks at new timestamps.
- Gate: `bun run check` green before commit.

## Siblings

`opencode-evidence` owns observation (upstream contract pinned at
`EVIDENCE_CONTRACT_REF`; never "fix" Verify by loosening evidence
validation). `opencode-proof` owns packaging (receipts are its inputs, not
its outputs). Do not implement either responsibility here "temporarily".
