import { describe, expect, test } from "bun:test";
import plugin from "../src/plugin";
import {
  VerifyCheckTool,
  VerifyExplainTool,
  VerifyGetTool,
  VerifyHealthTool,
  VERIFY_TOOL_NAMES,
} from "../src/tools";
import { commandRecord, tempEngine } from "./helpers";

describe("plugin load", () => {
  test("setup registers exactly the four expected tools", async () => {
    const added: string[] = [];
    const fakeCtx = {
      location: { directory: tempEngine().projectDir },
      tool: {
        transform: async (fn: (editor: { add: (t: { name: string }) => void }) => void) => {
          fn({ add: (t) => void added.push(t.name) });
        },
      },
      session: { hook: async () => {} },
    };
    await (plugin as { setup: (ctx: unknown) => Promise<void> }).setup(fakeCtx);
    expect(added).toEqual([...VERIFY_TOOL_NAMES]);
  });
});

describe("agent-facing tools", () => {
  test("verify_health reports readiness without inference or network", async () => {
    const out = JSON.parse(
      (await VerifyHealthTool(tempEngine()).execute({}, {} as never))!.content as unknown as string,
    ) as Record<string, unknown>;
    expect(out["ok"]).toBe(true);
    expect(out["model_inference"]).toBe("none");
    expect(out["network"]).toBe("none");
    expect(out["schema"]).toBe("opencode.verification.v1");
  });

  test("verify_check produces PASS then verify_get/explain round-trip", async () => {
    const engine = tempEngine();
    const evidence = commandRecord(0);
    const created = JSON.parse(
      (await VerifyCheckTool(engine).execute(
        {
          claim: { statement: "tests pass" },
          criterion: {
            kind: "evidence_field",
            evidence_kind: "command_result",
            path: "observation.exit_code",
            operator: "EQUALS",
            expected: 0,
          },
          evidence: [evidence],
        },
        {} as never,
      ))!.content as unknown as string,
    ) as { ok: boolean; receipt: { verification_id: string; verdict: string } };
    expect(created.ok).toBe(true);
    expect(created.receipt.verdict).toBe("PASS");

    const fetched = JSON.parse(
      (await VerifyGetTool(engine).execute(
        { verification_id: created.receipt.verification_id },
        {} as never,
      ))!.content as unknown as string,
    ) as { ok: boolean; receipt: { verification_id: string } };
    expect(fetched.ok).toBe(true);
    expect(fetched.receipt.verification_id).toBe(created.receipt.verification_id);

    const explained = JSON.parse(
      (await VerifyExplainTool(engine).execute(
        { verification_id: created.receipt.verification_id },
        {} as never,
      ))!.content as unknown as string,
    ) as { ok: boolean; explanation: { verdict: string; trace: string[] } };
    expect(explained.ok).toBe(true);
    expect(explained.explanation.verdict).toBe("PASS");
    expect(explained.explanation.trace.length).toBeGreaterThan(0);
  });

  test("verify_check surfaces request errors as ok:false payloads", async () => {
    const engine = tempEngine();
    const out = JSON.parse(
      (await VerifyCheckTool(engine).execute(
        {
          claim: { statement: "x" },
          criterion: { kind: "evidence_field", path: "a", operator: "VIBES", expected: 1 },
          evidence: [],
        },
        {} as never,
      ))!.content as unknown as string,
    ) as { ok: boolean; error_code: string };
    expect(out.ok).toBe(false);
    expect(out.error_code).toBe("UNSUPPORTED_OPERATOR");
  });

  test("verify_get on unknown id returns ok:false, not a throw", async () => {
    const out = JSON.parse(
      (await VerifyGetTool(tempEngine()).execute(
        { verification_id: `vr_${"e".repeat(32)}` },
        {} as never,
      ))!.content as unknown as string,
    ) as { ok: boolean; error_code: string };
    expect(out.ok).toBe(false);
    expect(out.error_code).toBe("VERIFY_INTERNAL");
  });
});
