import { describe, expect, it } from "vitest";
import { resolutionProfile, recommendedBitrate } from "./stream-options";

describe("QHD streaming profile", () => {
  it("sends actual 2560x1440 dimensions to both stream kinds", () => {
    expect(resolutionProfile("2560x1440")).toEqual({ width: 2560, height: 1440 });
  });
  it("suggests 30 Mbps on QHD without overwriting a user's 28 Mbps choice", () => {
    expect(recommendedBitrate("2560x1440", 15000)).toBe(30000);
    expect(recommendedBitrate("2560x1440", 28000)).toBe(28000);
  });
});
