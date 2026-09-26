import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeClaim, type Claim } from "./claim";
import { resolveEvidenceStoreDir, resolveStoreDir, type VerifyConfig } from "./config";
import { validateCriterion, type VerificationCriterion } from "./criterion";
import { evaluate, type EvalNode } from "./evaluate";
import {
  checkEvidenceIntegrity,
  validateEvidenceRecord,
  type EvidenceRecord,
} from "./evidence-contract";
import { buildReceipt, checkReceiptIntegrity, type VerificationReceipt } from "./receipt";
import { FileStoreResolver, MapResolver, type EvidenceResolver } from "./resolver";
import { ReceiptStore } from "./store";
import {
  EVIDENCE_CONTRACT_REF,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SUPPORTED_EVIDENCE_SCHEMAS,
  VERIFICATION_SCHEMA,
} from "./version";

export type EvidenceInput = EvidenceRecord | { evidence_id: string };

export type CheckInput = {
  claim: unknown;
  criterion: unknown;
  evidence: EvidenceInput[];
  evidence_store_dir?: string;
  evaluated_at?: string;
};

export class VerifyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

function isFullRecord(input: EvidenceInput): input is EvidenceRecord {
  const r = input as Record<string, unknown>;
  return typeof r["observation"] !== "undefined" || typeof r["content_hash"] === "string";
}

/**
 * VerificationEngine: deterministic Claim + Criterion + EvidenceRecord[]
 * -> VerificationReceipt. Pure evaluation; the only I/O is receipt
 * persistence and optional file-backed evidence resolution.
 */
export class VerificationEngine {
  readonly store: ReceiptStore;
  readonly storeDir: string;
  private readonly extraResolvers: EvidenceResolver[];

  constructor(
    readonly projectDir: string,
    overrides: VerifyConfig = {},
    extraResolvers: EvidenceResolver[] = [],
  ) {
    this.storeDir = resolveStoreDir(projectDir, overrides);
    this.store = new ReceiptStore(this.storeDir);
    this.extraResolvers = extraResolvers;
  }

  check(input: CheckInput): {
    receipt: VerificationReceipt;
    path: string;
    duplicate: boolean;
  } {
    const claim = normalizeClaim(input.claim);
    if (!claim.ok) throw new VerifyError(claim.code, claim.message);
    const criterion = validateCriterion(input.criterion);
    if (!criterion.ok) throw new VerifyError(criterion.code, criterion.message);
    if (!Array.isArray(input.evidence)) {
      throw new VerifyError("INVALID_EVIDENCE", "evidence must be an array of records or {evidence_id} refs");
    }

    // Partition inputs: full records validate directly; refs resolve.
    const inlineFull: EvidenceRecord[] = [];
    const refs: string[] = [];
    for (const item of input.evidence) {
      if (typeof item !== "object" || item === null) {
        throw new VerifyError("INVALID_EVIDENCE", "each evidence item must be an object");
      }
      if (isFullRecord(item)) inlineFull.push(item);
      else if (typeof (item as { evidence_id?: unknown }).evidence_id === "string") {
        refs.push((item as { evidence_id: string }).evidence_id);
      } else {
        throw new VerifyError("INVALID_EVIDENCE", "each evidence item must be a record or {evidence_id}");
      }
    }

    // A caller-supplied store dir enables file resolution for this call only.
    const callResolvers: EvidenceResolver[] = [];
    const storeDir =
      input.evidence_store_dir ?? resolveEvidenceStoreDir(this.projectDir);
    if (storeDir) callResolvers.push(new FileStoreResolver(storeDir));

    const seen = new Set<string>();
    const records: EvidenceRecord[] = [];
    const take = (record: EvidenceRecord) => {
      const structural = validateEvidenceRecord(record);
      if (!structural.ok) throw new VerifyError(structural.code, structural.message);
      const integrity = checkEvidenceIntegrity(structural.record);
      if (!integrity.ok) throw new VerifyError(integrity.code, integrity.message);
      if (!seen.has(structural.record.evidence_id)) {
        seen.add(structural.record.evidence_id);
        records.push(structural.record);
      }
    };
    for (const r of inlineFull) take(r);
    const map = new MapResolver(inlineFull);
    for (const id of refs) {
      const fromMap = map.resolve(id);
      if (fromMap) {
        take(fromMap);
        continue;
      }
      let hit: EvidenceRecord | null = null;
      for (const resolver of [...this.extraResolvers, ...callResolvers]) {
        hit = resolver.resolve(id);
        if (hit) break;
      }
      if (!hit) {
        throw new VerifyError(
          "EVIDENCE_UNRESOLVABLE",
          `no supplied record and no configured resolver for ${id} (pass the full record or set evidence_store_dir)`,
        );
      }
      take(hit);
    }

    const evaluation = evaluate(criterion.criterion, records);
    const receipt = buildReceipt({
      claim: claim.claim,
      criterion: criterion.criterion,
      evidence: records,
      evaluation,
      ...(input.evaluated_at !== undefined ? { evaluated_at: input.evaluated_at } : {}),
    });
    // Idempotent re-check: the verification_id binds the full decision
    // (claim + criterion + exact evidence + outcome + verifier). If it is
    // already recorded, return the stored receipt — first-write-wins on
    // evaluated_at — instead of colliding on the timestamp annotation.
    try {
      const existing = this.store.get(receipt.verification_id);
      const integrity = checkReceiptIntegrity(existing);
      if (!integrity.ok) {
        throw new VerifyError(integrity.code, `${integrity.message} (stored receipt)`);
      }
      return {
        receipt: existing,
        path: this.store.receiptPath(receipt.verification_id),
        duplicate: true,
      };
    } catch (error) {
      // A corrupt stored receipt must fail loudly, not be papered over.
      if (error instanceof VerifyError) throw error;
      // Not yet recorded; persist below (validates + integrity-checks).
    }
    const stored = this.store.put(receipt);
    return { receipt, path: stored.path, duplicate: stored.duplicate };
  }

  get(verification_id: string): VerificationReceipt {
    return this.store.get(verification_id);
  }

  /**
   * Mechanically render the evaluation trace as text. Generated from stored
   * deterministic data only — no model involved.
   */
  explain(verification_id: string): Record<string, unknown> {
    const receipt = this.store.get(verification_id);
    const integrity = checkReceiptIntegrity(receipt);
    return {
      verification_id: receipt.verification_id,
      claim: receipt.claim,
      criterion: receipt.criterion,
      evidence_ids: receipt.evidence_ids,
      evidence_hashes: receipt.evidence_hashes,
      verdict: receipt.verdict,
      evaluation: {
        result: receipt.evaluation.result,
        reason_code: receipt.evaluation.reason_code,
      },
      trace: renderTrace(receipt.evaluation.details as EvalNode, 0),
      evaluated_at: receipt.evaluated_at,
      verifier: receipt.verifier,
      integrity: integrity.ok
        ? { stored_bytes_match: true }
        : { stored_bytes_match: false, code: integrity.code, message: integrity.message },
      does_not_establish: [
        "whether the claim is universally true (PASS = this criterion on this evidence);",
        "whether evidence sources are trustworthy;",
        "whether the human's task is complete;",
        "whether any action is permitted (verification != authority);",
        "a proof artifact (receipts are inputs to opencode-proof, not proofs);",
        "freshness beyond recorded observed_at/evaluated_at timestamps.",
      ],
    };
  }

  doctor(): Record<string, unknown> {
    let store_writable = false;
    let message: string | undefined;
    try {
      mkdirSync(join(this.storeDir, "receipts"), { recursive: true });
      const probe = join(this.storeDir, "receipts", ".write-probe");
      writeFileSync(probe, "ok", "utf8");
      unlinkSync(probe);
      store_writable = true;
    } catch (error) {
      message = `store not writable: ${String(error).slice(0, 200)}`;
    }
    return {
      ok: store_writable,
      plugin: PLUGIN_ID,
      version: PLUGIN_VERSION,
      schema: VERIFICATION_SCHEMA,
      supported_evidence_schemas: [...SUPPORTED_EVIDENCE_SCHEMAS],
      evidence_contract: EVIDENCE_CONTRACT_REF,
      store_dir: this.storeDir,
      store_writable,
      model_inference: "none",
      network: "none",
      node: process.version,
      ...(message !== undefined ? { message } : {}),
    };
  }
}

export type { Claim, VerificationCriterion, VerificationReceipt };

function renderTrace(node: EvalNode, depth: number): string[] {
  const pad = "  ".repeat(depth);
  const head =
    node.kind === "evidence_field"
      ? `${node.kind} ${node.path} ${node.operator} => ${node.result} (${node.reason_code})`
      : `${node.kind} => ${node.result} (${node.reason_code})`;
  const lines = [`${pad}${head}`];
  for (const p of node.per_record ?? []) {
    const shown =
      p.actual === undefined
        ? "missing"
        : JSON.stringify(p.actual).slice(0, 160) + (p.actual_truncated ? "…[truncated]" : "");
    lines.push(`${pad}  - ${p.evidence_id} observed=${shown} => ${p.result} (${p.reason_code})`);
  }
  for (const child of node.children ?? []) lines.push(...renderTrace(child, depth + 1));
  return lines;
}
