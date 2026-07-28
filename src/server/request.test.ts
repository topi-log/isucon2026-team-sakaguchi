import { describe, expect, it } from "vite-plus/test";
import { parseCreatePostInput, parseLimit } from "./request.ts";

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

describe("parseCreatePostInput", () => {
  it("accepts and trims a valid input", () => {
    expect(parseCreatePostInput({ userId: 1, title: " title ", body: " body " })).toEqual({
      userId: 1,
      title: "title",
      body: "body",
    });
  });

  it.each([
    null,
    {},
    { userId: 0, title: "title", body: "body" },
    { userId: 1.5, title: "title", body: "body" },
    { userId: Number.MAX_SAFE_INTEGER + 1, title: "title", body: "body" },
    { userId: 1, title: {}, body: "body" },
    { userId: 1, title: "title", body: [] },
    { userId: 1, title: " ", body: "body" },
  ])("rejects invalid input: %j", (input) => {
    expect(parseCreatePostInput(input)).toBeNull();
  });
});
