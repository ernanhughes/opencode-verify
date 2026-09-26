# DESIGN.md — opencode-verify v0.1

## Responsibility

Decide whether supplied evidence satisfies an explicit criterion:
`Claim + VerificationCriterion + EvidenceRecord[] → VerificationReceipt
(PASS | FAIL | INCONCLUSIVE)`. Deterministic, local, inference-free.

## Non-responsibilities

Evidence capture/discovery/execution (Evidence, shell, orchestrator);
criterion authorship (caller/human/system supplies it); universal truth;
task completion (Work); permission (Authority); proof packaging (Proof).

Non-goals: LLM judge, embeddings, RAG, semantic search, evidence discovery,
shell/file execution or mutation, authority or completion decisions, proof
generation, theorem proving, Lean, probabilities, generic policy language,
remote services, consensus, signing infrastructure.

## Claim

`{claim_id, statement, subject?, scope?}`. `claim_id` is caller-supplied
(`/^cl_[0-9a-f]{32}$/`) or content-derived (`cl_ + sha256(canonical(
{statement, subject ?? null, scope ?? null}))[0:32]`). Bounds: statement
4 KiB, scope 16 KiB canonical. A receipt embeds the exact normalized claim
evaluated. No ontology, no graph.

## VerificationCriterion

Leaf: `{kind: "evidence_field", path, operator, expected?, selectors?,
min_observed_at?}`. `path` is a dot path rooted at the record
(`observation.exit_code`, `source.kind`, array indices allowed). Operators:
`EQUALS NOT_EQUALS CONTAINS MATCHES GT GTE LT LTE EXISTS` — only those with
unambiguous deterministic semantics. `expected` required except `EXISTS`
(which must not carry it); `MATCHES` takes a regex source (partial match,
no flags; invalid regex is `INVALID_CRITERION`); comparisons are strict
(no coercion). Selectors (`evidence_kind`, `evidence_id`, `subject`,
`source_kind`) state consumable evidence explicitly — no relevance magic.
`min_observed_at` excludes older records (reported as `stale_excluded`).
Composite: `all` / `any` (non-empty arrays) / `not` (single). Unknown object
keys fail closed.

## Evaluator semantics (three-valued)

Per record: `EXISTS` on absent field → `FALSE`; any other operator on a
missing path → `UNKNOWN` (`EVIDENCE_FIELD_MISSING`); present-but-wrong-type
→ `FALSE` (`TYPE_MISMATCH`); else the operator decides. Leaf over matches is
existential: any `TRUE` → `TRUE`; all `FALSE` (≥1) → `FALSE`; else `UNKNOWN`
— `UNKNOWN` never collapses. Composition is Kleene-strong: `ALL` is `FALSE`
if any child is `FALSE`, else `UNKNOWN` if any is `UNKNOWN`, else `TRUE`;
`ANY` dual; `NOT` flips `TRUE/FALSE`, preserves `UNKNOWN`. Empty evidence or
no selector match → `UNKNOWN` (`NO_APPLICABLE_EVIDENCE`). Boundary maps
`TRUE→PASS, FALSE→FAIL, UNKNOWN→INCONCLUSIVE`.

## Evidence consumption

Core takes validated records; the edge resolves `{evidence_id}` refs via
`EvidenceResolver` (`MapResolver`, read-only `FileStoreResolver` over an
evidence-store layout, or per-call `evidence_store_dir`). Resolution order:
inline → engine resolvers → per-call store dir. Unresolvable ids,
structural defects, schema mismatch, and integrity failure are **request
errors** (`EVIDENCE_UNRESOLVABLE`, `INVALID_EVIDENCE`,
`UNSUPPORTED_EVIDENCE_SCHEMA`, `EVIDENCE_INTEGRITY_FAILURE`) — never
verdicts. Valid requests with insufficient evidence → `INCONCLUSIVE`.

Dependency decision: no runtime dependency on opencode-evidence (local-only
package, no registry; Verify must work on bare JSON anywhere). Instead a
vendored read-only contract pinned to `opencode-evidence@88cc2e6`
(`src/evidence-contract.ts`, `src/canonical.ts`) with byte-compat fixtures
and an optional smoke-time cross-check against upstream code. Producer must
be `opencode-evidence`, mirroring upstream exactly.

## Receipt schema

`opencode.verification.v1`: `verification_id`, `claim`, `criterion`,
`evidence_ids` (sorted), `evidence_hashes` (id → content_hash: binds exact
bytes evaluated), `verdict`, `evaluation{result, reason_code, details}`,
`evaluated_at`, `verifier{plugin, version}`, `content_hash`. Forbidden:
`task_complete(d)`, `task_success`, `authorized`, `allowed`, `denied`,
`proof`, `confidence`, `trust_score` (`RECEIPT_FORBIDDEN_FIELD`).
`verdict` must match `result`. `details` holds the full per-record
evaluation tree (strings capped at 2 KiB, flagged).

## Identity semantics (deliberately not Evidence's)

`verification_id = vr_ + sha256(canonical({schema, claim, criterion,
evidence_ids, evidence_hashes, verdict, result, reason_code,
verifier{plugin,version}}))[0:32]`. Verifier version is included (semantics
can change); evidence hashes are included (bytes matter). `evaluated_at`
and storage path excluded; `content_hash` covers the same decision inputs
minus itself and minus `evaluated_at`. Stated plainly: `evaluated_at`
tampering alone is undetectable — it is annotation, like Evidence's
`observed_at`. Engine re-checks are idempotent: existing id → stored receipt
returned first-write-wins with `duplicate: true` (after integrity-checking
the stored copy); the store itself stays byte-exact and collision-loud.

## Storage

`ReceiptStore` under `<storeDir>/receipts/<id>.json` (pretty-canonical
JSON, tmp+rename atomicity, 1 MiB cap, read-only `get`). Default store is
per-project user-data space (`vr-<hash12>`), never mixed with evidence;
overrides via `OPENCODE_VERIFY_DIR` / `.opencode/verify.json`.

## Error vs verdict

`INVALID_CLAIM / INVALID_CRITERION / UNSUPPORTED_OPERATOR /
INVALID_EVIDENCE / EVIDENCE_INTEGRITY_FAILURE / UNSUPPORTED_EVIDENCE_SCHEMA /
EVIDENCE_UNRESOLVABLE / RECEIPT_*` are request/store failures surfaced as
`ok:false` + `error_code`. `PASS/FAIL/INCONCLUSIVE` are verdicts over valid
inputs only. The two families never mix.

## Temporal limitations

Receipts record `evaluated_at` and per-record `observed_at`; criteria can
gate with `min_observed_at`. Nothing more is claimed: ordering, staleness
policy beyond the gate, and "does this evidence still describe the world"
belong downstream (Proof/Work). Freshness beyond timestamps is an explicit
non-goal, documented on every explanation.

## Boundaries

Evidence (observation), Proof (packaging), Authority (permission), Work
(completion) are separate components. `verify_explain` renders traces; it
judges nothing new.
