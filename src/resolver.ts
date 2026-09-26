import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkEvidenceIntegrity, validateEvidenceRecord, type EvidenceRecord } from "./evidence-contract";

export const MAX_EVIDENCE_FILE_BYTES = 1_048_576;

/** Loose-coupling seam: the core takes records; only the edge resolves ids. */
export interface EvidenceResolver {
  resolve(evidence_id: string): EvidenceRecord | null;
}

export class MapResolver implements EvidenceResolver {
  private readonly byId = new Map<string, EvidenceRecord>();
  constructor(records: EvidenceRecord[]) {
    for (const r of records) this.byId.set(r.evidence_id, r);
  }
  resolve(evidence_id: string): EvidenceRecord | null {
    return this.byId.get(evidence_id) ?? null;
  }
}

/**
 * Read-only file resolver over an opencode-evidence store layout
 * (<storeDir>/records/<id>.json). Reads only; never writes, never mutates.
 * Couples to the documented layout, not to Evidence code.
 */
export class FileStoreResolver implements EvidenceResolver {
  constructor(readonly evidenceStoreDir: string) {}
  resolve(evidence_id: string): EvidenceRecord | null {
    if (!/^ev_[0-9a-f]{32}$/.test(evidence_id)) {
      throw new Error(`INVALID_EVIDENCE: malformed evidence_id "${evidence_id}"`);
    }
    const path = join(this.evidenceStoreDir, "records", `${evidence_id}.json`);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      return null;
    }
    if (stat.size > MAX_EVIDENCE_FILE_BYTES) {
      throw new Error(`INVALID_EVIDENCE: stored file for ${evidence_id} exceeds size cap`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error(`INVALID_EVIDENCE: stored file for ${evidence_id} is not valid JSON`);
    }
    const structural = validateEvidenceRecord(parsed);
    if (!structural.ok) {
      throw new Error(`${structural.code}: ${structural.message}`);
    }
    const integrity = checkEvidenceIntegrity(structural.record);
    if (!integrity.ok) {
      throw new Error(`${integrity.code}: ${integrity.message}`);
    }
    return structural.record;
  }
}
