import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VerificationEngine, VerifyError } from "../src/engine";
import { FileStoreResolver, MapResolver } from "../src/resolver";
import { commandRecord, makeRecord, tempEngine } from "./helpers";

const CLAIM = { statement: "test command exited successfully", subject: "test-suite" };
const EXIT_CRITERION = {
  kind: "evidence_field",
  evidence_kind: "command_result",
  path: "observation.exit_code",
  operator: "EQUALS",
  expected: 0,
} as const;

describe("first useful cases (A–E)", () => {
  test("A: exit 0 vs EQUALS 0 -> PASS", () => {
    const r = tempEngine().check({ claim: CLAIM, criterion: EXIT_CRITERION, evidence: [commandRecord(0)] });
    expect(r.receipt.verdict).toBe("PASS");
    expect(r.receipt.evaluation.reason_code).toBe("CRITERION_SATISFIED");
    expect(r.receipt.evidence_hashes[r.receipt.evidence_ids[0] as string]).toMatch(/^[0-9a-f]{64}$/);
  });

  test("B: exit 1 vs EQUALS 0 -> FAIL", () => {
    const r = tempEngine().check({ claim: CLAIM, criterion: EXIT_CRITERION, evidence: [commandRecord(1)] });
    expect(r.receipt.verdict).toBe("FAIL");
    expect(r.receipt.evaluation.reason_code).toBe("CRITERION_VIOLATED");
  });

  test("C: no applicable evidence -> INCONCLUSIVE (not FAIL)", () => {
    const engine = tempEngine();
    const empty = engine.check({ claim: CLAIM, criterion: EXIT_CRITERION, evidence: [] });
    expect(empty.receipt.verdict).toBe("INCONCLUSIVE");
    expect(empty.receipt.evaluation.reason_code).toBe("NO_APPLICABLE_EVIDENCE");
    const wrongKind = engine.check({
      claim: CLAIM,
      criterion: EXIT_CRITERION,
      evidence: [makeRecord({ kind: "file_observation", observation: { path: "x", exists: true } })],
    });
    expect(wrongKind.receipt.verdict).toBe("INCONCLUSIVE");
  });

  test("D: file exists true vs EQUALS true -> PASS", () => {
    const file = makeRecord({
      kind: "file_observation",
      subject: "manifest",
      observation: { path: "package.json", exists: true },
      sourceKind: "filesystem",
    });
    const r = tempEngine().check({
      claim: { statement: "package.json exists" },
      criterion: {
        kind: "evidence_field",
        evidence_kind: "file_observation",
        path: "observation.exists",
        operator: "EQUALS",
        expected: true,
      },
      evidence: [file],
    });
    expect(r.receipt.verdict).toBe("PASS");
  });

  test("E: composite build gate ALL/ANY/NOT", () => {
    const engine = tempEngine();
    const gate = {
      kind: "all",
      criteria: [
        { ...EXIT_CRITERION, subject: "tests" },
        { ...EXIT_CRITERION, subject: "typecheck" },
      ],
    };
    const tests = makeRecord({ subject: "tests", observation: { command: "bun test", exit_code: 0 } });
    const typecheck = makeRecord({ subject: "typecheck", observation: { command: "tsc", exit_code: 0 } });
    expect(engine.check({ claim: CLAIM, criterion: gate, evidence: [tests, typecheck] }).receipt.verdict).toBe("PASS");
    const broken = makeRecord({ subject: "typecheck", observation: { command: "tsc", exit_code: 2 } });
    expect(engine.check({ claim: CLAIM, criterion: gate, evidence: [tests, broken] }).receipt.verdict).toBe("FAIL");
    expect(engine.check({ claim: CLAIM, criterion: gate, evidence: [tests] }).receipt.verdict).toBe("INCONCLUSIVE");
  });
});

describe("request errors vs verdicts", () => {
  test("tampered evidence is an error, never a verdict", () => {
    const good = commandRecord(0);
    const tampered = { ...good, observation: { command: "bun test", exit_code: 999 } };
    try {
      tempEngine().check({ claim: CLAIM, criterion: EXIT_CRITERION, evidence: [tampered] });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(VerifyError);
      expect((error as VerifyError).code).toBe("EVIDENCE_INTEGRITY_FAILURE");
    }
  });

  test("unsupported evidence schema is an error", () => {
    const rec = { ...commandRecord(0), schema: "opencode.evidence.v2", content_hash: "x" };
    try {
      tempEngine().check({ claim: CLAIM, criterion: EXIT_CRITERION, evidence: [rec] });
      expect.unreachable();
    } catch (error) {
      expect((error as VerifyError).code).toBe("UNSUPPORTED_EVIDENCE_SCHEMA");
    }
  });

  test("unresolvable evidence_id ref is an error", () => {
    try {
      tempEngine().check({
        claim: CLAIM,
        criterion: EXIT_CRITERION,
        evidence: [{ evidence_id: `ev_${"a".repeat(32)}` }],
      });
      expect.unreachable();
    } catch (error) {
      expect((error as VerifyError).code).toBe("EVIDENCE_UNRESOLVABLE");
    }
  });

  test("invalid claim/criterion are errors", () => {
    const engine = tempEngine();
    for (const bad of [
      () => engine.check({ claim: {}, criterion: EXIT_CRITERION, evidence: [] }),
      () => engine.check({ claim: CLAIM, criterion: { kind: "maybe" }, evidence: [] }),
      () => engine.check({ claim: CLAIM, criterion: { ...EXIT_CRITERION, operator: "VIBES" }, evidence: [] }),
    ]) {
      try {
        bad();
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(VerifyError);
      }
    }
  });

  test("refs resolve against inline records and MapResolver", () => {
    const engine = tempEngine();
    const rec = commandRecord(0);
    const byRef = engine.check({
      claim: CLAIM,
      criterion: EXIT_CRITERION,
      evidence: [{ evidence_id: rec.evidence_id }, rec],
    });
    expect(byRef.receipt.verdict).toBe("PASS");
    const resolverEngine = new VerificationEngine(
      engine.projectDir,
      { store_dir: engine.storeDir },
      [new MapResolver([rec])],
    );
    const viaResolver = resolverEngine.check({
      claim: CLAIM,
      criterion: EXIT_CRITERION,
      evidence: [{ evidence_id: rec.evidence_id }],
    });
    expect(viaResolver.receipt.verdict).toBe("PASS");
  });

  test("evidence_store_dir resolves ids from an evidence-layout directory", () => {
    const engine = tempEngine();
    const rec = commandRecord(0);
    // Lay out a minimal evidence store (records/<id>.json) from a valid record.
    const evDir = mkdtempSync(join(tmpdir(), "vr-evdir-"));
    mkdirSync(join(evDir, "records"), { recursive: true });
    writeFileSync(join(evDir, "records", `${rec.evidence_id}.json`), JSON.stringify(rec), "utf8");
    const fileResolver = new FileStoreResolver(evDir);
    expect(fileResolver.resolve(rec.evidence_id)?.evidence_id).toBe(rec.evidence_id);
    const r = engine.check({
      claim: CLAIM,
      criterion: EXIT_CRITERION,
      evidence: [{ evidence_id: rec.evidence_id }],
      evidence_store_dir: evDir,
    });
    expect(r.receipt.verdict).toBe("PASS");
  });
});

describe("semantic boundaries", () => {
  test("model assertion is not external verification", () => {
    const assertion = makeRecord({
      kind: "structured_observation",
      observation: { statement: "all tests passed", confidence: 1 },
    });
    const r = tempEngine().check({ claim: { statement: "all tests passed" }, criterion: EXIT_CRITERION, evidence: [assertion] });
    expect(r.receipt.verdict).toBe("INCONCLUSIVE");
  });

  test("criterion on literally-observed words still only checks data", () => {
    const assertion = makeRecord({
      kind: "structured_observation",
      observation: { statement: "all tests passed", confidence: 1 },
    });
    const r = tempEngine().check({
      claim: { statement: "the record says X" },
      criterion: {
        kind: "evidence_field",
        path: "observation.statement",
        operator: "EQUALS",
        expected: "all tests passed",
      },
      evidence: [assertion],
    });
    expect(r.receipt.verdict).toBe("PASS");
    const top = r.receipt as unknown as Record<string, unknown>;
    expect(top["verified"]).toBeUndefined();
  });

  test("PASS introduces no task completion, authority, or proof", () => {
    const r = tempEngine().check({ claim: CLAIM, criterion: EXIT_CRITERION, evidence: [commandRecord(0)] });
    expect(r.receipt.verdict).toBe("PASS");
    const top = r.receipt as unknown as Record<string, unknown>;
    for (const f of ["task_complete", "task_completed", "authorized", "allowed", "proof", "confidence"]) {
      expect(top[f]).toBeUndefined();
    }
  });

  test("unknown field and NaN-adjacent behavior are deterministic UNKNOWN/FALSE, not throws", () => {
    const engine = tempEngine();
    const unknown = engine.check({
      claim: CLAIM,
      criterion: { ...EXIT_CRITERION, path: "observation.nope" },
      evidence: [commandRecord(0)],
    });
    expect(unknown.receipt.verdict).toBe("INCONCLUSIVE");
    const typeMismatch = engine.check({
      claim: CLAIM,
      criterion: { ...EXIT_CRITERION, operator: "GT", expected: 5 },
      evidence: [makeRecord({ observation: { exit_code: "zero" } })],
    });
    expect(typeMismatch.receipt.verdict).toBe("FAIL");
    expect(typeMismatch.receipt.evaluation.details).toBeDefined();
  });

  test("explanation trace is deterministic data, not a new judgment", () => {
    const engine = tempEngine();
    const r = engine.check({ claim: CLAIM, criterion: EXIT_CRITERION, evidence: [commandRecord(0)] });
    const ex = engine.explain(r.receipt.verification_id) as { trace: string[]; verdict: string; does_not_establish: string[] };
    expect(ex.verdict).toBe("PASS");
    expect(ex.trace.join("\n")).toContain("EQUALS => TRUE");
    expect(ex.does_not_establish.length).toBeGreaterThan(0);
  });

  test("no model inference, no network anywhere in src", () => {
    const srcFiles = readdirSync(join(import.meta.dir, "..", "src")).filter((f) => f.endsWith(".ts"));
    const banned = [
      /from\s+["']node:https?["']/,
      /from\s+["']node:net["']/,
      /(^|[^A-Za-z_.])fetch\s*\(/,
      /openai|anthropic|llm|inference\s*\(|embeddings?/i,
    ];
    for (const file of srcFiles) {
      const content = readFileSync(join(import.meta.dir, "..", "src", file), "utf8");
      for (const pattern of banned) {
        expect(
          pattern.test(content),
          `${file} matches banned pattern ${String(pattern)}`,
        ).toBe(false);
      }
    }
    const health = tempEngine().doctor() as Record<string, unknown>;
    expect(health["model_inference"]).toBe("none");
    expect(health["network"]).toBe("none");
  });
});
