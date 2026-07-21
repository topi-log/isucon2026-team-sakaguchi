import { describe, expect, it } from "vite-plus/test";
import { parseLimit } from "./request.ts";

describe("parseLimit", () => {
  it("uses the default for missing or invalid values", () => {
    expect(parseLimit(undefined)).toBe(20);
    expect(parseLimit("invalid")).toBe(20);
  });

  it("clamps the value to the supported range", () => {
    expect(parseLimit("0")).toBe(1);
    expect(parseLimit("50")).toBe(50);
    expect(parseLimit("101")).toBe(100);
  });
});
