# opencode-verify

**One job:** decide whether supplied evidence satisfies an explicit criterion.

```text
Claim + VerificationCriterion + EvidenceRecord[]
        │
        ▼
  opencode-verify
        │
        ▼
VerificationReceipt: PASS | FAIL | INCONCLUSIVE
```

It answers **"Does the supplied evidence satisfy this criterion?"** Nothing more.

## The three questions stay separate

```text
Evidence:  "What was observed?"
Verify:    "Does the supplied evidence satisfy this criterion?"  ← this repo
Proof:     "Can evidence + verification be packaged into a replayable artifact?"
```

A PASS means exactly this:

> The supplied valid evidence satisfied the supplied criterion,
> as evaluated by this verifier version at this time.

It does **not** mean the claim is universally true, the task is complete,
the action is permitted, or a proof exists:

```text
PASS != universal truth
PASS != task completion
PASS != authority
PASS != proof
```

## Why three outcomes, not boolean

Absence of sufficient evidence is not evidence of failure.

```text
expected exit_code = 0, observed exit_code = 0  → PASS
expected exit_code = 0, observed exit_code = 1  → FAIL
expected exit_code = 0, no applicable evidence   → INCONCLUSIVE
```

```text
missing evidence != failure
```

The evaluator works in three-valued logic (`TRUE / FALSE / UNKNOWN`) and
maps at the boundary: `TRUE → PASS`, `FALSE → FAIL`, `UNKNOWN →
INCONCLUSIVE`. `UNKNOWN` is never collapsed into `FALSE` — the `ALL` / `ANY`
/ `NOT` tables are Kleene-strong and pinned by tests.

## No LLM judge

The core path requires **zero model inference, zero network, zero semantic
guessing**. Criteria are explicit machine-checkable predicates over record
fields — nine operators (`EQUALS NOT_EQUALS CONTAINS MATCHES GT GTE LT LTE
EXISTS`) plus `all / any / not` composition with deterministic selectors
(evidence kind, id, subject, source kind) and an optional `min_observed_at`
freshness gate. A test scans `src/` to prove no model/network code exists.

## Install

Prerequisites: [Bun](https://bun.sh) ≥ 1.0 (Node ≥ 22 also works for built output).

```sh
bun install
bun run check   # typecheck + tests
bun run build
```

```json
{ "plugins": ["file:///absolute/path/to/opencode-verify"] }
```

## Tools (four)

| Tool | Purpose |
|---|---|
| `verify_check` | Evaluate claim + criterion + evidence → persisted `VerificationReceipt`. Errors (bad claim/criterion, tampered or unresolvable evidence) return `ok:false` with a machine-readable `error_code` — never a verdict. |
| `verify_get` | Retrieve a receipt by id. Read-only. |
| `verify_explain` | Render the deterministic evaluation trace plus what the verdict does **not** establish. Data rendering, not a new judgment. |
| `verify_health` | Readiness: versions, supported evidence schemas, store writability, `model_inference: none`, `network: none`. |

No `verify_validate` tool: validation failures already surface as explicit
`verify_check` error codes (`INVALID_CLAIM`, `INVALID_CRITERION`,
`UNSUPPORTED_OPERATOR`, …).

## Example

```text
Claim:     "test command exited successfully"
Criterion: command_result.observation.exit_code EQUALS 0
Evidence:  ev_e2da7b2f… (exit_code observed as 0)
Receipt:   vr_bf0cbcf2… PASS / CRITERION_SATISFIED
```

Same evidence against `expected: 1` → `FAIL / CRITERION_VIOLATED`.
No evidence supplied → `INCONCLUSIVE / NO_APPLICABLE_EVIDENCE`.
Tampered evidence → error `EVIDENCE_INTEGRITY_FAILURE`, never a verdict.

See `receipt.example.json` for the full receipt shape
(`opencode.verification.v1`).

## Evidence integration (no runtime dependency)

Verify consumes `opencode.evidence.v1` through a **pinned, attributed,
read-only vendored contract** (`src/evidence-contract.ts` + canonicalization),
frozen against `opencode-evidence@88cc2e6` — that package is local-only with
no registry presence, and Verify must run against bare record JSON on any
machine. Drift is detected, not prevented:

- `tests/fixtures/evidence-example.json` is a byte-identical real upstream
  record; the suite reproduces its hash/id exactly;
- smoke cross-checks a Verify-built record against upstream's own
  `validateRecord` when a checkout is adjacent.

Every supplied record is structurally validated and integrity-recomputed
before evaluation. Invalid requests fail explicitly; insufficient evidence
yields `INCONCLUSIVE`.

Evidence may arrive inline (full records), by id with `evidence_store_dir`
(read-only resolution over an evidence-store layout), or via a custom
`EvidenceResolver`. Verify never writes, mutates, discovers, or executes.

## Receipt identity

`verification_id = vr_ + sha256(canonical({schema, claim, criterion,
evidence_ids, evidence_hashes, verdict, result, reason_code,
verifier{plugin,version}}))[0:32]`. The verifier version participates —
evaluator semantics can change. `evaluated_at` is provenance annotation
(first-write-wins; re-checks are idempotent, `duplicate: true`), covered by
neither identity nor `content_hash`, exactly like Evidence's `observed_at`.
Receipts persist under `<store>/receipts/<id>.json`, physically separate
from evidence, with atomic writes and collision-loud semantics.

## Checks

```sh
bun run typecheck
bun test            # 64 tests, 290 assertions, 10 files
bun run build
bun src/dev-cli.ts load    # module loads, 4 tools register, health clean
bun src/dev-cli.ts smoke   # PASS / FAIL / INCONCLUSIVE + retrieval + integrity
```

Live OpenCode-runtime integration is **UNVERIFIED** here; offline load proves
everything provable without inference.

## Boundaries (see DESIGN.md, AGENTS.md)

Verification authorizes nothing, completes no tasks, generates no proofs,
discovers no evidence, executes nothing, and judges no prose. Boring
deterministic verification is the point.
