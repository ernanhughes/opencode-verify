import { describe, expect, test } from "bun:test";
import { evaluate } from "../src/evaluate";
import type { EvidenceFieldCriterion } from "../src/criterion";
import { commandRecord, makeRecord } from "./helpers";

function run(
  leaf: Omit<EvidenceFieldCriterion, "kind"> & { kind?: "evidence_field" },
  records: ReturnType<typeof commandRecord>[],
) {
  return evaluate({ kind: "evidence_field", ...leaf }, records);
}

const exit0 = () => commandRecord(0, "43 passed");
const exit1 = () => commandRecord(1, "1 failed");
const noExit = () => commandRecord(undefined);

describe("leaf operators", () => {
  test("EQUALS / NOT_EQUALS with deep equality", () => {
    expect(run({ path: "observation.exit_code", operator: "EQUALS", expected: 0 }, [exit0()]).result).toBe("TRUE");
    expect(run({ path: "observation.exit_code", operator: "EQUALS", expected: 0 }, [exit1()]).result).toBe("FALSE");
    expect(run({ path: "observation.exit_code", operator: "NOT_EQUALS", expected: 0 }, [exit1()]).result).toBe("TRUE");
    const rec = makeRecord({ observation: { tags: ["a", "b"] } });
    expect(run({ path: "observation.tags", operator: "EQUALS", expected: ["a", "b"] }, [rec]).result).toBe("TRUE");
    expect(run({ path: "observation.tags", operator: "EQUALS", expected: ["b", "a"] }, [rec]).result).toBe("FALSE");
  });

  test("missing field -> UNKNOWN (except EXISTS -> FALSE)", () => {
    const leaf = { path: "observation.exit_code", operator: "EQUALS", expected: 0 } as const;
    const r = run({ ...leaf }, [noExit()]);
    expect(r.result).toBe("UNKNOWN");
    expect(r.reason_code).toBe("EVIDENCE_FIELD_MISSING");
    expect(run({ path: "observation.exit_code", operator: "EXISTS" }, [noExit()]).result).toBe("FALSE");
    expect(run({ path: "observation.exit_code", operator: "EXISTS" }, [exit0()]).result).toBe("TRUE");
  });

  test("CONTAINS over strings and arrays; wrong types -> FALSE", () => {
    expect(run({ path: "observation.stdout", operator: "CONTAINS", expected: "passed" }, [exit0()]).result).toBe("TRUE");
    expect(run({ path: "observation.stdout", operator: "CONTAINS", expected: "zzz" }, [exit0()]).result).toBe("FALSE");
    const rec = makeRecord({ observation: { items: [1, 2] } });
    expect(run({ path: "observation.items", operator: "CONTAINS", expected: 2 }, [rec]).result).toBe("TRUE");
    expect(run({ path: "observation.exit_code", operator: "CONTAINS", expected: "0" }, [exit0()]).result).toBe("FALSE");
    const r = run({ path: "observation.exit_code", operator: "CONTAINS", expected: "0" }, [exit0()]);
    expect(r.details.reason_code).toBe("TYPE_MISMATCH");
  });

  test("MATCHES partial regex; non-strings -> FALSE", () => {
    expect(run({ path: "observation.stdout", operator: "MATCHES", expected: "\\d+ passed" }, [exit0()]).result).toBe("TRUE");
    expect(run({ path: "observation.stdout", operator: "MATCHES", expected: "^failed" }, [exit0()]).result).toBe("FALSE");
    expect(run({ path: "observation.exit_code", operator: "MATCHES", expected: "0" }, [exit0()]).result).toBe("FALSE");
  });

  test("GT/GTE/LT/LTE numeric; non-numbers -> FALSE; missing -> UNKNOWN", () => {
    const rec = exit0();
    expect(run({ path: "observation.exit_code", operator: "GT", expected: -1 }, [rec]).result).toBe("TRUE");
    expect(run({ path: "observation.exit_code", operator: "GTE", expected: 0 }, [rec]).result).toBe("TRUE");
    expect(run({ path: "observation.exit_code", operator: "LT", expected: 0 }, [rec]).result).toBe("FALSE");
    expect(run({ path: "observation.exit_code", operator: "LTE", expected: 0 }, [rec]).result).toBe("TRUE");
    expect(run({ path: "observation.stdout", operator: "GT", expected: 0 }, [rec]).result).toBe("FALSE");
    expect(run({ path: "observation.missing", operator: "GT", expected: 0 }, [rec]).result).toBe("UNKNOWN");
  });

  test("record-level paths and array indices resolve", () => {
    const rec = exit0();
    expect(run({ path: "kind", operator: "EQUALS", expected: "command_result" }, [rec]).result).toBe("TRUE");
    expect(run({ path: "source.kind", operator: "EQUALS", expected: "process" }, [rec]).result).toBe("TRUE");
    expect(run({ path: "subject", operator: "EQUALS", expected: "test-suite" }, [rec]).result).toBe("TRUE");
    expect(run({ path: "observation.nope.deeper", operator: "EQUALS", expected: 1 }, [rec]).result).toBe("UNKNOWN");
    const arr = makeRecord({ observation: { vals: [10, 20] } });
    expect(run({ path: "observation.vals.1", operator: "EQUALS", expected: 20 }, [arr]).result).toBe("TRUE");
    expect(run({ path: "observation.vals.9", operator: "EQUALS", expected: 20 }, [arr]).result).toBe("UNKNOWN");
  });
});
