/** Developer CLI: health, load, and smoke checks. No model inference, no network. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalize, sha256Hex } from "./canonical";
import { VerificationEngine } from "./engine";
import { checkReceiptIntegrity } from "./receipt";

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function check(cond: boolean, message: string): void {
  if (!cond) fail(message);
  console.log(`ok: ${message}`);
}

function tempEngine(): VerificationEngine {
  const projectDir = mkdtempSync(join(tmpdir(), "vr-proj-"));
  const storeDir = mkdtempSync(join(tmpdir(), "vr-store-"));
  return new VerificationEngine(projectDir, { store_dir: storeDir });
}

/**
 * Build an opencode.evidence.v1 record with the vendored (pinned)
 * canonicalization. Byte-compatible with opencode-evidence@88cc2e6 by
 * construction; tests/fixtures/evidence-example.json pins that claim,
 * and smoke cross-checks against upstream code when a checkout is present.
 */
function makeEvidenceRecord(input: {
  kind: string;
  subject?: string;
  observation: unknown;
  source: { kind: string; locator?: string };
  observed_at: string;
}) {
  const identity = {
    kind: input.kind,
    observation: input.observation,
    source: {
      kind: input.source.kind,
      locator: input.source.locator ?? null,
      version: null,
    },
    subject: input.subject ?? null,
  };
  const content_hash = sha256Hex(canonicalize(identity));
  return {
    schema: "opencode.evidence.v1",
    evidence_id: `ev_${content_hash.slice(0, 32)}`,
    kind: input.kind,
    ...(input.subject !== undefined ? { subject: input.subject } : {}),
    observation: input.observation,
    source: { kind: input.source.kind, ...(input.source.locator ? { locator: input.source.locator } : {}) },
    observed_at: input.observed_at,
    content_hash,
    producer: { plugin: "opencode-evidence", version: "0.1.0" },
  };
}

async function cmdHealth(projectDir: string): Promise<void> {
  console.log(JSON.stringify(new VerificationEngine(projectDir).doctor(), null, 2));
}

async function cmdLoad(projectDir: string): Promise<void> {
  const mod = await import("./plugin");
  check(typeof mod.default === "object" && mod.default !== null, "plugin module loads with default export");
  const plugin = mod.default as { setup: (ctx: unknown) => Promise<void> };
  check(typeof plugin.setup === "function", "plugin exposes setup()");
  const added: string[] = [];
  await plugin.setup({
    location: { directory: projectDir },
    tool: {
      transform: async (fn: (editor: { add: (t: { name: string }) => void }) => void) => {
        fn({ add: (t) => void added.push(t.name) });
      },
    },
    session: { hook: async () => {} },
  });
  const expected = ["verify_check", "verify_get", "verify_explain", "verify_health"];
  check(JSON.stringify(added) === JSON.stringify(expected), `tools registered: ${added.join(", ")}`);
  const health = new VerificationEngine(projectDir).doctor() as {
    model_inference: string;
    network: string;
  };
  check(health.model_inference === "none", "health reports model_inference=none");
  check(health.network === "none", "health reports network=none");
  console.log(JSON.stringify({ load: "PASS", tools: added }, null, 2));
}

async function cmdSmoke(): Promise<void> {
  const engine = tempEngine();
  const evidence = makeEvidenceRecord({
    kind: "command_result",
    subject: "test-suite",
    observation: {
      command: "bun test",
      exit_code: 0,
      stdout: "43 passed, 0 failed",
      stdout_truncated: false,
      stderr: "",
      stderr_truncated: false,
    },
    source: { kind: "process", locator: "local" },
    observed_at: "2026-09-26T00:00:00.000Z",
  });
  const claim = { statement: "test command exited successfully", subject: "test-suite" };
  const passCriterion = {
    kind: "evidence_field",
    evidence_kind: "command_result",
    path: "observation.exit_code",
    operator: "EQUALS",
    expected: 0,
  };

  const pass = engine.check({ claim, criterion: passCriterion, evidence: [evidence] });
  check(pass.receipt.verdict === "PASS", `exit_code 0 vs EQUALS 0 -> PASS (${pass.receipt.verification_id})`);

  const fail = engine.check({
    claim,
    criterion: { ...passCriterion, expected: 1 },
    evidence: [evidence],
  });
  check(fail.receipt.verdict === "FAIL", `exit_code 0 vs EQUALS 1 -> FAIL (${fail.receipt.verification_id})`);

  const inconclusive = engine.check({ claim, criterion: passCriterion, evidence: [] });
  check(
    inconclusive.receipt.verdict === "INCONCLUSIVE",
    `no evidence -> INCONCLUSIVE (${inconclusive.receipt.evaluation.reason_code})`,
  );

  for (const r of [pass.receipt, fail.receipt, inconclusive.receipt]) {
    const fetched = engine.get(r.verification_id);
    check(fetched.verification_id === r.verification_id, `receipt ${r.verdict} retrieves by id`);
    const integrity = checkReceiptIntegrity(fetched);
    check(integrity.ok, `receipt ${r.verdict} integrity revalidates`);
    const top = fetched as unknown as Record<string, unknown>;
    check(top["task_complete"] === undefined && top["authorized"] === undefined, `receipt ${r.verdict} carries no task/authority fields`);
  }

  const explanation = engine.explain(pass.receipt.verification_id) as {
    trace: string[];
    does_not_establish: string[];
  };
  check(explanation.trace.length > 0, "explanation renders a deterministic trace");
  check(explanation.does_not_establish.length > 0, "explanation states non-claims");

  // Optional real interop: validate the smoke record with upstream code if present.
  const candidates = [
    process.env["OPENCODE_EVIDENCE_REPO"],
    resolve(join(process.cwd(), "..", "opencode-evidence")),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  let interop: string = "skipped (no upstream checkout)";
  for (const repo of candidates) {
    try {
      const upstream = (await import(join(repo, "src", "schema.ts"))) as {
        validateRecord: (r: unknown) => { ok: boolean; code?: string; message?: string };
      };
      const v = upstream.validateRecord(evidence);
      check(v.ok, `upstream opencode-evidence accepts the smoke record (${repo})`);
      interop = `checked against ${repo}`;
      break;
    } catch (error) {
      if (String(error).startsWith("FAIL:")) throw error;
    }
  }
  console.log(`evidence interop: ${interop}`);
  console.log("SMOKE PASS");
}

const [, , cmd] = process.argv;
const projectDir = process.cwd();
if (cmd === "health") await cmdHealth(projectDir);
else if (cmd === "load") await cmdLoad(projectDir);
else if (cmd === "smoke") await cmdSmoke();
else {
  console.error("usage: dev-cli.ts <health|load|smoke>");
  process.exit(2);
}
