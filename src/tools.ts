import type { Info as ToolInfo } from "@opencode/plugin/promise/tool";
import { VerifyError, type VerificationEngine } from "./engine";

function text(result: unknown): { content: string } {
  return { content: JSON.stringify(result, null, 2) };
}

function failure(error: unknown): { content: string } {
  if (error instanceof VerifyError) {
    return text({ ok: false, error_code: error.code, error: error.message });
  }
  const message = error instanceof Error ? error.message : String(error);
  return text({ ok: false, error_code: "VERIFY_INTERNAL", error: message });
}

const CLAIM_SCHEMA = {
  type: "object",
  properties: {
    claim_id: { type: "string" },
    statement: { type: "string" },
    subject: { type: "string" },
    scope: { type: "object" },
  },
  required: ["statement"],
  additionalProperties: false,
};

export function VerifyCheckTool(engine: VerificationEngine): ToolInfo {
  return {
    name: "verify_check",
    description:
      "Deterministically check whether supplied evidence satisfies an explicit criterion for a claim. " +
      "Returns a persisted VerificationReceipt with verdict PASS, FAIL, or INCONCLUSIVE. " +
      "Missing evidence yields INCONCLUSIVE, never FAIL. Tampered or malformed evidence fails the " +
      "request as an error, never a verdict. PASS means the criterion held on this evidence only: " +
      "not universal truth, not task completion, not permission to act. No model inference.",
    input: {
      type: "object",
      properties: {
        claim: CLAIM_SCHEMA,
        criterion: {},
        evidence: { type: "array" },
        evidence_store_dir: { type: "string" },
      },
      required: ["claim", "criterion", "evidence"],
      additionalProperties: false,
    },
    async execute(input) {
      try {
        const args = input as {
          claim: unknown;
          criterion: unknown;
          evidence: never[];
          evidence_store_dir?: string;
        };
        const result = engine.check({
          claim: args.claim,
          criterion: args.criterion,
          evidence: args.evidence,
          ...(args.evidence_store_dir !== undefined
            ? { evidence_store_dir: args.evidence_store_dir }
            : {}),
        });
        return text({ ok: true, ...result });
      } catch (error) {
        return failure(error);
      }
    },
  };
}

export function VerifyGetTool(engine: VerificationEngine): ToolInfo {
  return {
    name: "verify_get",
    description: "Retrieve a persisted VerificationReceipt by id. Read-only.",
    input: {
      type: "object",
      properties: {
        verification_id: { type: "string", minLength: 1 },
      },
      required: ["verification_id"],
      additionalProperties: false,
    },
    async execute(input) {
      try {
        const args = input as { verification_id: string };
        return text({ ok: true, receipt: engine.get(args.verification_id) });
      } catch (error) {
        return failure(error);
      }
    },
  };
}

export function VerifyExplainTool(engine: VerificationEngine): ToolInfo {
  return {
    name: "verify_explain",
    description:
      "Render a receipt's deterministic evaluation trace: claim, criterion, evidence used, " +
      "per-record results, and what the verdict does NOT establish. Generated from stored " +
      "data only; never a model explanation, never a new judgment.",
    input: {
      type: "object",
      properties: {
        verification_id: { type: "string", minLength: 1 },
      },
      required: ["verification_id"],
      additionalProperties: false,
    },
    async execute(input) {
      try {
        const args = input as { verification_id: string };
        return text({ ok: true, explanation: engine.explain(args.verification_id) });
      } catch (error) {
        return failure(error);
      }
    },
  };
}

export function VerifyHealthTool(engine: VerificationEngine): ToolInfo {
  return {
    name: "verify_health",
    description:
      "Report verifier readiness: plugin/schema versions, supported evidence schemas, " +
      "receipt store writability. Runtime checks only; no model inference, no network.",
    input: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      return text(engine.doctor());
    },
  };
}

export const VERIFY_TOOL_NAMES = [
  "verify_check",
  "verify_get",
  "verify_explain",
  "verify_health",
] as const;
