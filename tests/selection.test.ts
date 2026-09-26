import { describe, expect, test } from "bun:test";
import { evaluate } from "../src/evaluate";
import { commandRecord, makeRecord } from "./helpers";

const BASE = {
  kind: "evidence_field",
  path: "observation.exit_code",
  operator: "EQUALS",
  expected: 0,
} as const;

describe("evidence selection", () => {
  test("kind/subject/source/id selectors filter deterministically", () => {
    const cmd = commandRecord(0);
    const file = makeRecord({
      kind: "file_observation",
      subject: "manifest",
      observation: { path: "x", exists: true },
      sourceKind: "filesystem",
    });
    expect(evaluate({ ...BASE, evidence_kind: "command_result" }, [cmd, file]).result).toBe("TRUE");
    expect(evaluate({ ...BASE, evidence_kind: "file_observation" }, [cmd, file]).result).toBe("UNKNOWN");
    expect(evaluate({ ...BASE, subject: "test-suite" }, [cmd, file]).result).toBe("TRUE");
    expect(evaluate({ ...BASE, subject: "other" }, [cmd, file]).result).toBe("UNKNOWN");
    expect(evaluate({ ...BASE, source_kind: "process" }, [cmd, file]).result).toBe("TRUE");
    expect(evaluate({ ...BASE, evidence_id: cmd.evidence_id }, [cmd, file]).result).toBe("TRUE");
    expect(evaluate({ ...BASE, evidence_id: `ev_${"0".repeat(32)}` }, [cmd, file]).result).toBe("UNKNOWN");
  });

  test("selector mismatch yields NO_APPLICABLE_EVIDENCE", () => {
    const r = evaluate({ ...BASE, evidence_kind: "http_observation" }, [commandRecord(0)]);
    expect(r.result).toBe("UNKNOWN");
    expect(r.reason_code).toBe("NO_APPLICABLE_EVIDENCE");
  });

  test("min_observed_at excludes stale records and reports them", () => {
    const old = makeRecord({
      observation: { command: "bun test", exit_code: 0 },
      observed_at: "2026-01-01T00:00:00.000Z",
    });
    const fresh = makeRecord({
      observation: { command: "bun test", exit_code: 1 },
      observed_at: "2026-09-26T00:00:00.000Z",
    });
    const leaf = { ...BASE, min_observed_at: "2026-06-01T00:00:00.000Z" };
    const r = evaluate(leaf, [old, fresh]);
    expect(r.result).toBe("FALSE"); // only the fresh exit_code=1 record applies
    expect(r.details.stale_excluded).toEqual([old.evidence_id]);
    const allStale = evaluate(leaf, [old]);
    expect(allStale.result).toBe("UNKNOWN");
    expect(allStale.reason_code).toBe("NO_APPLICABLE_EVIDENCE");
    expect(allStale.details.stale_excluded).toEqual([old.evidence_id]);
  });
});
