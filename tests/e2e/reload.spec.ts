import { expect, test } from "@playwright/test";

test("TeX replacement preserves scroll and zoom; partial output is retained; F5 works with auto off", async ({ page }) => {
  await page.goto("/tests/fixtures/index.html");
  await page.getByRole("button", { name: "Open PDF", exact: true }).click();
  await expect(page.locator("[data-page]")).toHaveCount(12);
  await page.getByTitle("Zoom in", { exact: true }).click();
  await page.evaluate(() => (window as any).__readerStore.getState().setCurrentPage(4));
  const reader = page.getByLabel("PDF pages");
  await expect(page.locator('[data-page="4"] .textLayer')).toContainText("Page 4:");
  await reader.evaluate(el => { el.scrollTop += 100; });
  await page.waitForTimeout(100);
  const before = await page.evaluate(() => {
    const s = (window as any).__readerStore.getState();
    return { scale: s.scale, anchor: s.scrollAnchor, tab: s.activeTabId };
  });
  const scroll = await reader.evaluate(el => el.scrollTop);
  await page.evaluate(() => (window as any).__replacePdf("fixture.pdf", " REBUILT"));
  await expect(page.locator('[data-page="4"] .textLayer')).toContainText("REBUILT", { timeout: 12000 });
  expect(await reader.evaluate(el => el.scrollTop)).toBeCloseTo(scroll, 0);
  expect(await page.evaluate(() => {
    const s = (window as any).__readerStore.getState();
    return { scale: s.scale, anchor: s.scrollAnchor, tab: s.activeTabId };
  })).toEqual(before);
  await page.evaluate(() => (window as any).__replacePdf("fixture.pdf", null));
  await expect(page.getByText("Update pending", { exact: true })).toBeVisible({ timeout: 12000 });
  await expect(page.locator('[data-page="4"] .textLayer')).toContainText("REBUILT");
  await page.getByLabel("Auto reload", { exact: true }).uncheck();
  await page.evaluate(() => (window as any).__replacePdf("fixture.pdf", " MANUAL"));
  await page.keyboard.press("F5");
  await expect(page.locator('[data-page="4"] .textLayer')).toContainText("MANUAL");
  expect(await reader.evaluate(el => el.scrollTop)).toBeCloseTo(scroll, 0);
  await expect(page.getByText("Update pending", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: "test-results/pdf-reload.png" });
});
