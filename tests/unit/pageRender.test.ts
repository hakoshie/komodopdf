import { expect, it } from "vitest";
import { canvasOutputScale } from "../../src/pdf/pageRender";

it("keeps native pixel density so low-DPI text is not softened by downsampling", () => {
  expect(canvasOutputScale(600, 800, 1)).toBe(1);
  expect(canvasOutputScale(600, 800, 1.25)).toBe(1.25);
  expect(canvasOutputScale(600, 800, 3)).toBe(3);
});

it("bounds backing-store memory and dimensions for very large pages", () => {
  for (const [width, height] of [[4000, 6000], [50000, 100], [100, 50000]]) {
    const scale = canvasOutputScale(width, height, 3);
    expect(width * height * scale ** 2).toBeLessThanOrEqual(16_777_216 + 1);
    expect(Math.max(width, height) * scale).toBeLessThanOrEqual(16_384);
  }
});
