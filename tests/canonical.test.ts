import { describe, expect, test } from "bun:test";
import { canonicalize } from "../src/canonical";

describe("canonicalization (pinned to evidence@88cc2e6 rules)", () => {
  test("sorts keys recursively, no whitespace", () => {
    expect(canonicalize({ z: 1, a: { d: 4, c: 3 }, m: [3, 2] })).toBe(
      `{"a":{"c":3,"d":4},"m":[3,2],"z":1}`,
    );
  });

  test("drops undefined props, nulls array holes, nulls non-finite numbers", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(`{"a":1}`);
    expect(canonicalize([1, undefined])).toBe(`[1,null]`);
    expect(canonicalize({ a: NaN })).toBe(`{"a":null}`);
  });

  test("serializes Date as ISO, rejects non-JSON leaves", () => {
    expect(canonicalize({ t: new Date("2026-01-02T03:04:05.000Z") })).toBe(
      `{"t":"2026-01-02T03:04:05.000Z"}`,
    );
    expect(() => canonicalize({ v: 1n })).toThrow("VERIFY_NON_JSON_VALUE");
    expect(() => canonicalize({ v: () => {} })).toThrow("VERIFY_NON_JSON_VALUE");
  });

  test("is deterministic and order-sensitive for arrays only", () => {
    const v = { k: "v", n: [1, { x: true }] };
    expect(canonicalize(v)).toBe(canonicalize(JSON.parse(JSON.stringify(v))));
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });
});
