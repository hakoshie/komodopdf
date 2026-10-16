import { expect, test, type Page } from "@playwright/test";

test.setTimeout(60000);

async function openPdf(page: Page, name: string, variant = name) {
  await page.evaluate(({ name, variant }) => { (window as any).__pdfName = name; (window as any).__pdfVariant = variant; }, { name, variant });
  await page.getByRole("button", { name: "Open PDF", exact: true }).click();
  await expect(page.getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true", { timeout: 20000 });
  await expect(page.getByPlaceholder("Ask anything...")).toBeEnabled();
  await expect(page.locator('[data-page="1"] .textLayer')).toContainText("Page 1:");
}

test.beforeEach(async ({ page }) => { await page.goto("/tests/fixtures/index.html"); });

test("tabs retain reading position, zoom, drafts and the selected conversation", async ({ page }) => {
  await openPdf(page, "first.pdf");
  const input = page.getByPlaceholder("Ask anything...");
  await input.fill("First conversation"); await input.press("Enter");
  await expect(page.locator(".katex-display")).toHaveCount(1);
  const history = page.getByLabel("Chat history / 履歴", { exact: true });
  const firstConversation = await history.inputValue();
  await page.getByRole("button", { name: "New chat / 新しい会話", exact: true }).click();
  await input.fill("Second conversation"); await input.press("Enter");
  await expect(history.locator("option")).toHaveCount(3);
  await history.selectOption(firstConversation);
  await input.fill("Unsent draft for first PDF");
  await page.getByTitle("Zoom in", { exact: true }).click();
  await page.getByLabel("PDF pages", { exact: true }).evaluate((element) => { element.scrollTop = 2600; });
  await expect.poll(() => page.evaluate(() => (window as any).__readerStore.getState().scrollAnchor?.page ?? 0)).toBeGreaterThan(1);
  const before = await page.evaluate(() => ({ top: document.querySelector('[aria-label="PDF pages"]')!.scrollTop, scale: (window as any).__readerStore.getState().scale }));
  await openPdf(page, "second.pdf");
  await expect(input).toHaveValue("");
  await expect(page.getByText("First conversation", { exact: true })).toHaveCount(0);
  await input.fill("Second PDF draft");
  await page.getByRole("tab", { name: "first.pdf", exact: true }).click();
  await expect(input).toHaveValue("Unsent draft for first PDF");
  await expect(history).toHaveValue(firstConversation);
  await expect(page.getByText("First conversation", { exact: true })).toBeVisible();
  await expect(page.getByText("Second conversation", { exact: true })).toHaveCount(0);
  await expect.poll(() => page.getByLabel("PDF pages", { exact: true }).evaluate((element) => element.scrollTop)).toBeCloseTo(before.top, -1);
  expect(await page.evaluate(() => (window as any).__readerStore.getState().scale)).toBe(before.scale);
  await page.getByRole("tab", { name: "second.pdf", exact: true }).click();
  await expect(input).toHaveValue("Second PDF draft");
  await page.screenshot({ path: "test-results/document-tabs.png" });
});

test("duplicate opens focus a tab; shortcuts and closing the final tab work", async ({ page }) => {
  await openPdf(page, "first.pdf");
  await openPdf(page, "second.pdf");
  await openPdf(page, "first.pdf");
  await expect(page.getByRole("tab")).toHaveCount(2);
  expect(await page.evaluate(() => (window as any).__readPdfPaths)).toEqual(["first.pdf", "second.pdf"]);
  await page.keyboard.press("Control+Tab");
  await expect(page.getByRole("tab", { name: "second.pdf", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Control+Shift+Tab");
  await expect(page.getByRole("tab", { name: "first.pdf", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Close second.pdf", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(1);
  await page.keyboard.press("Control+W");
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.getByText("Open a PDF to get started", { exact: true })).toBeVisible();
  await openPdf(page, "third.pdf");
});

test("a streaming answer stays with its tab while another PDF is active", async ({ page }) => {
  await openPdf(page, "first.pdf");
  await page.evaluate(() => { (window as any).__pauseReply = true; });
  await page.getByPlaceholder("Ask anything...").fill("Question for first PDF");
  await page.getByPlaceholder("Ask anything...").press("Enter");
  await expect.poll(() => page.evaluate(() => typeof (window as any).__finishReply)).toBe("function");
  await openPdf(page, "second.pdf");
  await page.evaluate(() => (window as any).__finishReply());
  await expect.poll(() => page.evaluate(() => (window as any).__readerStore.getState().tabs[0].state.streaming)).toBe(false);
  await expect(page.locator(".katex-display")).toHaveCount(0);
  await page.getByRole("tab", { name: "first.pdf", exact: true }).click();
  await expect(page.getByText("Question for first PDF", { exact: true })).toBeVisible();
  await expect(page.locator(".katex-display")).toHaveCount(1);
  await expect(page.getByPlaceholder("Ask anything...")).toBeEnabled();
});

test("closing a streaming tab cannot write its answer into the remaining tab", async ({ page }) => {
  await openPdf(page, "first.pdf");
  await page.evaluate(() => { (window as any).__pauseReply = true; });
  await page.getByPlaceholder("Ask anything...").fill("Close me during reply");
  await page.getByPlaceholder("Ask anything...").press("Enter");
  await expect.poll(() => page.evaluate(() => typeof (window as any).__finishReply)).toBe("function");
  await openPdf(page, "second.pdf");
  await page.getByRole("button", { name: "Close first.pdf", exact: true }).click();
  await page.evaluate(() => (window as any).__finishReply());
  await expect.poll(() => page.evaluate(() => Object.values(JSON.parse(localStorage.getItem("test-conversations")!)).some((chat: any) => chat.messages.length === 2))).toBe(true);
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(page.locator(".katex-display")).toHaveCount(0);
  await expect(page.getByPlaceholder("Ask anything...")).toBeEnabled();
});

test("indexing stays with its PDF and its pending question resumes on returning", async ({ page }) => {
  await openPdf(page, "first.pdf");
  await page.evaluate(() => {
    (window as any).__pauseIndex = true;
    (window as any).__readerStore.getState().setIndexState("idle");
  });
  await page.getByPlaceholder("Ask anything...").fill("Question after indexing");
  await page.getByPlaceholder("Ask anything...").press("Enter");
  await page.getByRole("button", { name: "Index now", exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__finishIndex)).toBe("function");
  await page.evaluate(() => {
    (window as any).__pdfVariant = "second document";
    return (window as any).__openNativePdfs(["second.pdf"]);
  });
  await expect(page.getByRole("tab", { name: "second.pdf", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.evaluate(() => (window as any).__finishIndex());
  await expect.poll(() => page.evaluate(() => (window as any).__readerStore.getState().tabs[0].state.indexState)).toBe("ready");
  await expect(page.getByText("Question after indexing", { exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "first.pdf", exact: true }).click();
  await expect(page.getByText("Question after indexing", { exact: true })).toBeVisible();
  await expect(page.locator(".katex-display")).toHaveCount(1);
});
