import { describe, expect, it } from "vitest";
import { __testOnly } from "@/app/api/detect/route";

describe("detect route abuse safeguards", () => {
  it("reduces detail on repeated near-identical rescans", () => {
    const key = `user-test-${Date.now()}`;
    const hash = "same-hash";

    const first = __testOnly.applyAbuseGuards(key, hash);
    const second = __testOnly.applyAbuseGuards(key, hash);
    const third = __testOnly.applyAbuseGuards(key, hash);

    expect(first.blocked).toBe(false);
    expect(second.blocked).toBe(false);
    expect(third.reducedDetail).toBe(true);
  });
});

