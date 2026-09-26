import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize, sha256Hex } from "../src/canonical";
import { VerificationEngine } from "../src/engine";
import type { EvidenceRecord } from "../src/evidence-contract";

/** Build a valid opencode.evidence.v1 record (same algorithm upstream uses). */
export function makeRecord(input: {
  kind?: string;
  subject?: string;
  observation: unknown;
  sourceKind?: string;
  sourceLocator?: string;
  observed_at?: string;
  producerVersion?: string;
}): EvidenceRecord {
  const kind = input.kind ?? "command_result";
  const source = {
    kind: input.sourceKind ?? "process",
    locator: input.sourceLocator ?? null,
    version: null,
  };
  const identity = { kind, observation: input.observation, source, subject: input.subject ?? null };
  const content_hash = sha256Hex(canonicalize(identity));
  return {
    schema: "opencode.evidence.v1",
    evidence_id: `ev_${content_hash.slice(0, 32)}`,
    kind: kind as EvidenceRecord["kind"],
    ...(input.subject !== undefined ? { subject: input.subject } : {}),
    observation: input.observation,
    source: {
      kind: input.sourceKind ?? "process",
      ...(input.sourceLocator !== undefined ? { locator: input.sourceLocator } : {}),
    },
    observed_at: input.observed_at ?? "2026-09-26T00:00:00.000Z",
    content_hash,
    producer: { plugin: "opencode-evidence", version: input.producerVersion ?? "0.1.0" },
  } as EvidenceRecord;
}

export function commandRecord(exit_code: number | undefined, stdout = ""): EvidenceRecord {
  const observation: Record<string, unknown> = { command: "bun test" };
  if (exit_code !== undefined) observation["exit_code"] = exit_code;
  if (stdout) observation["stdout"] = stdout;
  return makeRecord({ kind: "command_result", subject: "test-suite", observation });
}

export function tempEngine(): VerificationEngine {
  return new VerificationEngine(mkdtempSync(join(tmpdir(), "vr-t-proj-")), {
    store_dir: mkdtempSync(join(tmpdir(), "vr-t-store-")),
  });
}
