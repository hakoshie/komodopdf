import { expect, test } from "@playwright/test";

// Headless Chromium otherwise hides native scrollbar controls entirely.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/fixtures/index.html");
  await page.getByRole("button", { name: "Open PDF", exact: true }).click();
  await expect(page.locator('[data-page="1"] .textLayer')).toContainText("Page 1:");
});

test("PDF scrollbar is 12px wide while other scrollbar and divider widths stay unchanged", async ({ page }) => {
  const reader = page.getByLabel("PDF pages");
  expect(await reader.evaluate((el) => (el as HTMLElement).offsetWidth - el.clientWidth)).toBe(12);
  expect(await page.getByLabel("Ask Komodo conversation").evaluate((el) =>
    getComputedStyle(el, "::-webkit-scrollbar").width)).toBe("8px");
  expect((await page.getByRole("separator", { name: "Resize PDF and Ask Komodo" }).boundingBox())!.width).toBe(10);
});

for (const inset of [2, 10]) {
  test(`PDF scrollbar remains scrollable ${inset}px from the Ask resize handle`, async ({ page }) => {
    const reader = page.getByLabel("PDF pages");
    const handle = page.getByRole("separator", { name: "Resize PDF and Ask Komodo" });
    const bounds = (await reader.boundingBox())!;
    const width = bounds.width;
    // The scrollbar is directly beside the separator. Its outer pixels must
    // stay available for scrolling instead of extending the separator's hit area.
    await page.mouse.move(bounds.x + bounds.width - inset, bounds.y + 100);
    await expect(handle).toHaveAttribute("data-resize-handle-state", "inactive");
    await page.mouse.click(bounds.x + bounds.width - inset, bounds.y + 100);
    await expect.poll(() => reader.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect((await reader.boundingBox())!.width).toBeCloseTo(width, 0);
    await expect(handle).toHaveAttribute("data-resize-handle-state", "inactive");
  });
}

test("dragging beside the Ask resize handle does not resize the panes", async ({ page }) => {
  const input = page.getByPlaceholder("Ask anything...");
  await input.fill("An answer to select");
  await input.press("Enter");
  await expect(page.locator(".ai-markdown")).toBeVisible();
  const handle = page.getByRole("separator", { name: "Resize PDF and Ask Komodo" });
  const bounds = (await handle.boundingBox())!;
  const reader = page.getByLabel("PDF pages");
  const width = (await reader.boundingBox())!.width;
  await page.mouse.move(bounds.x + bounds.width + 2, bounds.y + 150);
  await expect(handle).toHaveAttribute("data-resize-handle-state", "inactive");
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width + 60, bounds.y + 150);
  await page.mouse.up();
  expect((await reader.boundingBox())!.width).toBeCloseTo(width, 0);
});

test("the visible resize handle still resizes with pointer and keyboard", async ({ page }) => {
  const reader = page.getByLabel("PDF pages");
  const handle = page.getByRole("separator", { name: "Resize PDF and Ask Komodo" });
  const bounds = (await handle.boundingBox())!;
  const width = (await reader.boundingBox())!.width;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x - 100, bounds.y + bounds.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await reader.boundingBox())!.width).toBeLessThan(width - 80);
  const draggedWidth = (await reader.boundingBox())!.width;
  await handle.focus();
  await handle.press("ArrowRight");
  await expect.poll(async () => (await reader.boundingBox())!.width).toBeGreaterThan(draggedWidth);
});
