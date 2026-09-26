import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prettyCanonical } from "./canonical";
import { checkReceiptIntegrity, validateReceipt, VERIFICATION_ID_PATTERN, type VerificationReceipt } from "./receipt";

export const MAX_RECEIPT_BYTES = 1_048_576;

/**
 * Local receipt persistence. Same philosophy as the evidence store, kept
 * physically separate: receipts live under <storeDir>/receipts/, never
 * mixed with evidence records.
 */
export class ReceiptStore {
  constructor(readonly dir: string) {}

  receiptsDir(): string {
    return join(this.dir, "receipts");
  }

  receiptPath(verification_id: string): string {
    if (!VERIFICATION_ID_PATTERN.test(verification_id)) {
      throw new Error("RECEIPT_BAD_ID: verification_id must match /^vr_[0-9a-f]{32}$/");
    }
    return join(this.receiptsDir(), `${verification_id}.json`);
  }

  /** Atomic (tmp + rename), idempotent, collision-loud. Never overwrites. */
  put(receipt: VerificationReceipt): { verification_id: string; path: string; duplicate: boolean } {
    const structural = validateReceipt(receipt);
    if (!structural.ok) {
      throw new Error(`${structural.code}: ${structural.message}`);
    }
    const integrity = checkReceiptIntegrity(receipt);
    if (!integrity.ok) {
      throw new Error(`${integrity.code}: ${integrity.message}`);
    }
    const serialized = prettyCanonical(receipt);
    if (serialized.length > MAX_RECEIPT_BYTES) {
      throw new Error(`RECEIPT_TOO_LARGE: receipt is ${serialized.length} bytes (cap ${MAX_RECEIPT_BYTES})`);
    }
    mkdirSync(this.receiptsDir(), { recursive: true });
    const dest = this.receiptPath(receipt.verification_id);
    let existing: Buffer | null = null;
    try {
      existing = readFileSync(dest);
    } catch {
      existing = null;
    }
    if (existing !== null) {
      if (existing.toString("utf8") === serialized) {
        return { verification_id: receipt.verification_id, path: dest, duplicate: true };
      }
      throw new Error(
        `RECEIPT_ID_COLLISION: ${dest} already holds a different receipt under ${receipt.verification_id}`,
      );
    }
    const tmp = join(this.receiptsDir(), `.tmp-${receipt.verification_id}-${process.pid}-${Date.now()}.json`);
    writeFileSync(tmp, serialized, "utf8");
    renameSync(tmp, dest);
    return { verification_id: receipt.verification_id, path: dest, duplicate: false };
  }

  /** Read-only retrieval. Never mutates the stored receipt. */
  get(verification_id: string): VerificationReceipt {
    const dest = this.receiptPath(verification_id);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(dest);
    } catch {
      throw new Error(`RECEIPT_NOT_FOUND: no receipt for ${verification_id}`);
    }
    if (stat.size > MAX_RECEIPT_BYTES) {
      throw new Error(`RECEIPT_TOO_LARGE: stored file is ${stat.size} bytes`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(dest, "utf8"));
    } catch {
      throw new Error(`RECEIPT_MALFORMED: ${dest} is not valid JSON`);
    }
    const structural = validateReceipt(parsed);
    if (!structural.ok) {
      throw new Error(`${structural.code}: ${structural.message} (${dest})`);
    }
    return structural.receipt;
  }
}
