import { describe, expect, it } from "vitest";
import { detectRequestSchema } from "@/lib/detection/schema";

describe("detectRequestSchema", () => {
  it("accepts required payload", () => {
    const parsed = detectRequestSchema.safeParse({
      text: "Sample text",
      privacy_mode: "hash_only",
      context: { mode: "general", language: "en" },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects invalid privacy mode", () => {
    const parsed = detectRequestSchema.safeParse({
      text: "Sample text",
      privacy_mode: "raw",
    });
    expect(parsed.success).toBe(false);
  });
});

