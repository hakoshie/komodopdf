import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/fixtures/index.html");
  await page.getByRole("button", { name: "Open PDF", exact: true }).click();
  // The first PDF.js worker load can be slow on a cold development server.
  await expect(page.locator("[data-page]")).toHaveCount(12, { timeout: 15000 });
  await expect(page.locator('[data-page="1"] .textLayer')).toContainText("Page 1:");
});

test("wheel scrolling stays put; page jumps, zoom and resizing render correctly", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const reader = page.getByLabel("PDF pages");
  const height = await reader.evaluate((el) => el.scrollHeight);
  const thirdPageTop = await page.locator('[data-page="3"]').evaluate((el) => (el as HTMLElement).offsetTop);
  await reader.hover();
  await page.mouse.wheel(0, thirdPageTop + 80);
  await expect(page.getByText("3 / 12", { exact: true })).toBeVisible();
  const top = await reader.evaluate((el) => el.scrollTop);
  await page.waitForTimeout(1000);
  expect(await reader.evaluate((el) => el.scrollTop)).toBeCloseTo(top, 0);
  expect(await reader.evaluate((el) => el.scrollHeight)).toBe(height);
  await page.getByRole("button", { name: "›", exact: true }).click();
  await expect(page.getByText("4 / 12", { exact: true })).toBeVisible();
  await expect(page.getByTitle("Fit width", { exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-page="4"] .textLayer')).toContainText("Page 4:");
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.getByTitle("Zoom in", { exact: true }).click({ clickCount: 4 });
  await page.getByTitle("Fit page", { exact: true }).click();
  await expect.poll(() => page.locator('[data-page="4"] canvas').evaluate((el) => (el as HTMLCanvasElement).width)).toBeGreaterThan(0);
  await expect(page.locator('[data-page="4"] .textLayer')).toContainText("Page 4:");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("math renders and earlier citations retain their own page", async ({ page }) => {
  const input = page.getByPlaceholder("Ask anything...");
  await input.fill("First question");
  await input.press("Enter");
  await expect(page.locator(".katex-display")).toHaveCount(1);
  await input.fill("Follow up");
  await input.press("Enter");
  await expect(page.locator(".katex-display")).toHaveCount(2);
  await page.getByRole("button", { name: "p.2", exact: true }).click();
  await expect(page.getByText("2 / 12", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "p.8", exact: true }).click();
  await expect(page.getByText("8 / 12", { exact: true })).toBeVisible();
  await expect(page.locator('[data-page="8"] .textLayer')).toContainText("Page 8:");
  const highlightTop = await page.locator('[data-page="8"] [style*="flash-amber"]').evaluate((el) => (el as HTMLElement).offsetTop);
  expect(highlightTop).toBeLessThan(130);
  await page.screenshot({ path: "test-results/reader-math.png" });
});

test("Ctrl+wheel zooms the hovered pane without resizing the toolbar or the other pane", async ({ page }) => {
  const input = page.getByPlaceholder("Ask anything...");
  await input.fill("Explain the formula");
  await input.press("Enter");
  const answer = page.locator(".ai-markdown").first();
  const math = answer.locator(".katex").first();
  await expect(math).toBeVisible();
  const fontSize = () => answer.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const originalFont = await fontSize();
  const originalMathFont = await math.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const originalTableFont = await answer.locator("table").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const originalCodeFont = await answer.locator("pre").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const pdf = page.locator('[data-page="1"] canvas');
  const pdfWidth = () => pdf.evaluate((el) => el.getBoundingClientRect().width);
  const originalPdfWidth = await pdfWidth();
  const openButton = page.getByRole("button", { name: "Open PDF", exact: true });
  const originalButton = await openButton.boundingBox();

  await answer.hover();
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -120);
  await page.keyboard.up("Control");
  await expect.poll(fontSize).toBeGreaterThan(originalFont);
  await expect.poll(() => math.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThan(originalMathFont);
  expect(await answer.locator("table").evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThan(originalTableFont);
  expect(await answer.locator("pre").evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThan(originalCodeFont);
  expect(await pdfWidth()).toBeCloseTo(originalPdfWidth, 0);
  expect((await openButton.boundingBox())!.width).toBeCloseTo(originalButton!.width, 0);
  const enlargedFont = await fontSize();
  await page.getByRole("button", { name: "Close Ask Komodo", exact: true }).click();
  await page.getByTitle("Show Ask Komodo", { exact: true }).click();
  expect(await fontSize()).toBeCloseTo(enlargedFont, 2);

  await answer.hover();
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 120);
  await page.keyboard.up("Control");
  await expect.poll(fontSize).toBeCloseTo(originalFont, 2);
  const reader = page.getByLabel("PDF pages");
  await expect(page.getByTitle("Fit width", { exact: true })).toHaveAttribute("aria-pressed", "true");
  const fittedWidth = await pdfWidth();
  await reader.hover();
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -120);
  await page.keyboard.up("Control");
  await expect.poll(pdfWidth).toBeGreaterThan(fittedWidth);
  await expect(page.getByTitle("Fit width", { exact: true })).toHaveAttribute("aria-pressed", "false");
  expect(await fontSize()).toBeCloseTo(originalFont, 2);
  const enlargedPdfWidth = await pdfWidth();
  await reader.hover();
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 120);
  await page.keyboard.up("Control");
  await expect.poll(pdfWidth).toBeLessThan(enlargedPdfWidth);
  const zoomedWidth = await pdfWidth();
  await page.mouse.wheel(0, 240);
  await expect.poll(() => reader.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await pdfWidth()).toBeCloseTo(zoomedWidth, 0);
  expect((await openButton.boundingBox())!.width).toBeCloseTo(originalButton!.width, 0);
});

test("outline toggling keeps the reading position and panels within the window", async ({ page }) => {
  await page.setViewportSize({ width: 1224, height: 800 });
  const reader = page.getByLabel("PDF pages");
  const position = () => reader.evaluate((el) => {
    const first = el.querySelector<HTMLElement>('[data-page="1"]')!;
    return { fraction: (el.scrollTop + 16 - first.offsetTop) / first.offsetHeight,
      left: el.scrollLeft, width: el.clientWidth };
  });
  for (const fit of [false, true]) {
    if (!fit) await page.getByTitle("Zoom in", { exact: true }).click();
    await expect.poll(async () => (await position()).width).toBeGreaterThan(0);
    await page.waitForTimeout(200);
    await reader.evaluate((el) => { el.scrollTop = 220; el.scrollLeft = 120; });
    await page.waitForTimeout(100);
    const before = await position();
    await page.getByTitle("Toggle outline", { exact: true }).click();
    await expect.poll(async () => (await position()).width).toBeGreaterThan(before.width);
    await expect.poll(async () => Math.abs((await position()).fraction - before.fraction)).toBeLessThan(0.003);
    const collapsed = await page.getByTitle("Show outline", { exact: true }).boundingBox();
    const readerBox = await reader.boundingBox();
    expect(collapsed!.y).toBe(readerBox!.y);
    expect(collapsed!.height).toBe(readerBox!.height);
    expect(collapsed!.x + collapsed!.width).toBeLessThanOrEqual(readerBox!.x);
    await page.screenshot({ path: "test-results/reader-outline-collapsed.png" });
    await page.getByTitle("Toggle outline", { exact: true }).click();
    await expect.poll(async () => (await position()).width).toBe(before.width);
    await expect.poll(async () => Math.abs((await position()).fraction - before.fraction)).toBeLessThan(0.003);
    await expect(page.getByTitle("Fit width", { exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => reader.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    const group = await page.locator('[data-panel-group]').boundingBox();
    expect(group!.x + group!.width).toBeLessThanOrEqual(1224);
    const send = await page.getByRole("button", { name: "Send", exact: true }).boundingBox();
    expect(send!.x + send!.width).toBeLessThanOrEqual(1224);
  }
  await page.screenshot({ path: "test-results/reader-outline.png" });
});

test("dragging the split resizes both panes and automatically fits the full PDF width", async ({ page }) => {
  const reader = page.getByLabel("PDF pages");
  const handle = page.getByRole("separator", { name: "Resize PDF and Ask Komodo" });
  const canvas = page.locator('[data-page="1"] canvas');
  const fraction = () => reader.evaluate((el) => {
    const first = el.querySelector<HTMLElement>('[data-page="1"]')!;
    return (el.scrollTop + 16 - first.offsetTop) / first.offsetHeight;
  });
  await expect(page.getByTitle("Fit width", { exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(await reader.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await reader.evaluate((el) => { el.scrollTop = 180; });
  await page.waitForTimeout(100);
  const before = await fraction();
  const fittedWidth = (await canvas.boundingBox())!.width;
  await page.getByTitle("Zoom in", { exact: true }).click();
  await expect.poll(async () => (await canvas.boundingBox())!.width / fittedWidth).toBeCloseTo(1.2, 2);
  for (const delta of [-150, 240]) {
    const start = (await handle.boundingBox())!;
    const oldWidth = await reader.evaluate((el) => el.clientWidth);
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(start.x + start.width / 2 + delta, start.y + start.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect.poll(() => reader.evaluate((el) => el.clientWidth)).not.toBe(oldWidth);
    await expect(page.getByTitle("Fit width", { exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => reader.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    await expect.poll(async () => Math.abs(await fraction() - before)).toBeLessThan(0.003);
    const chat = await page.getByPlaceholder("Ask anything...").boundingBox();
    const readerBox = await reader.boundingBox();
    expect(chat!.x).toBeGreaterThan(readerBox!.x + readerBox!.width);
  }
  await page.screenshot({ path: "test-results/reader-split-fit.png" });
});

test("IME confirmation does not send a question", async ({ page }) => {
  const input = page.getByPlaceholder("Ask anything...");
  await input.fill("日本語の入力");
  await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  await expect(page.locator(".ai-markdown")).toHaveCount(0);
  await expect(input).toHaveValue("日本語の入力");
});

test("Ask Komodo closes and restores its width, conversation, draft and PDF reading position", async ({ page }) => {
  const reader = page.getByLabel("PDF pages");
  const input = page.getByPlaceholder("Ask anything...");
  const handle = page.getByRole("separator", { name: "Resize PDF and Ask Komodo" });
  await input.fill("Explain this page");
  await input.press("Enter");
  await expect(page.locator(".katex-display")).toHaveCount(1);
  await input.fill("まだ送信していない質問");
  await handle.focus();
  await handle.press("ArrowLeft");
  await reader.evaluate((el) => { el.scrollTop = 180; });
  await page.waitForTimeout(100);
  const oldWidth = await reader.evaluate((el) => el.clientWidth);
  const fraction = () => reader.evaluate((el) => {
    const first = el.querySelector<HTMLElement>('[data-page="1"]')!;
    return (el.scrollTop + 16 - first.offsetTop) / first.offsetHeight;
  });
  const before = await fraction();
  await page.getByRole("button", { name: "Close Ask Komodo", exact: true }).click();
  await expect(input).not.toBeVisible();
  await expect(handle).not.toBeVisible();
  await expect.poll(() => reader.evaluate((el) => el.clientWidth)).toBeGreaterThan(oldWidth);
  await expect.poll(() => reader.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await expect.poll(async () => Math.abs(await fraction() - before)).toBeLessThan(0.003);
  const groupBox = await page.locator('[data-panel-group]').boundingBox();
  const readerBox = await reader.boundingBox();
  expect(readerBox!.width).toBeCloseTo(groupBox!.width, 0);
  await page.screenshot({ path: "test-results/reader-ai-closed.png" });
  await page.getByTitle("Show Ask Komodo", { exact: true }).click();
  await expect(input).toHaveValue("まだ送信していない質問");
  await expect(page.locator(".katex-display")).toBeVisible();
  await expect(handle).toBeVisible();
  await expect.poll(() => reader.evaluate((el) => el.clientWidth)).toBe(oldWidth);
  await expect.poll(async () => Math.abs(await fraction() - before)).toBeLessThan(0.003);
  await page.getByTitle("Hide Ask Komodo", { exact: true }).click();
  await expect(input).not.toBeVisible();
  await page.getByTitle("Show Ask Komodo", { exact: true }).click();
  await expect(input).toHaveValue("まだ送信していない質問");
});

test("Codex settings hide the chat key and survive reopening", async ({ page }) => {
  await page.getByTitle("Settings", { exact: true }).click();
  await page.getByLabel("Provider", { exact: true }).selectOption("codex");
  await page.getByLabel("Codex model", { exact: true }).selectOption("__custom__");
  await page.getByLabel("Custom Codex model", { exact: true }).fill("my-codex-model");
  await page.getByLabel("Thinking level / 思考の深さ", { exact: true }).selectOption("high");
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByTitle("Settings", { exact: true }).click();
  await expect(page.getByLabel("Provider", { exact: true })).toHaveValue("codex");
  await expect(page.getByLabel("Codex model", { exact: true })).toHaveValue("my-codex-model");
  await expect(page.getByLabel("Thinking level / 思考の深さ", { exact: true })).toHaveValue("high");
});

test("Codex web search modes persist and source links open outside the reader", async ({ page }) => {
  await page.getByTitle("Settings", { exact: true }).click();
  await page.getByLabel("Provider", { exact: true }).selectOption("codex");
  const search = page.getByLabel("Web search / ウェブ検索", { exact: true });
  await expect(search).toHaveValue("live");
  for (const mode of ["cached", "disabled", "live"]) {
    await search.selectOption(mode);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByTitle("Settings", { exact: true }).click();
    await expect(search).toHaveValue(mode);
  }
  await page.screenshot({ path: "test-results/codex-web-search-settings.png" });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByPlaceholder("Ask anything...").fill("Search the web");
  await page.getByPlaceholder("Ask anything...").press("Enter");
  await page.getByRole("link", { name: "Web source", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__openedUrls)).toEqual(["https://example.com/research"]);
  await expect(page.locator("[data-page]")).toHaveCount(12);
  await expect(page.getByRole("button", { name: "p.2", exact: true })).toBeVisible();
});

test("Codex model dropdown restricts thinking levels and saves the chosen model and effort", async ({ page }) => {
  await page.getByTitle("Settings", { exact: true }).click();
  await page.getByLabel("Provider", { exact: true }).selectOption("codex");
  const model = page.getByLabel("Codex model", { exact: true });
  const thinking = page.getByLabel("Thinking level / 思考の深さ", { exact: true });
  await expect(thinking).toBeDisabled();
  await expect(model.locator('option[value="test-deep"]')).toHaveCount(1);
  await model.selectOption("test-deep");
  await thinking.selectOption("high");
  await expect(thinking.locator('option[value="ultra"]')).toHaveCount(1);
  await model.selectOption("test-fast");
  await expect(thinking).toHaveValue("");
  await expect(thinking.locator('option[value="high"]')).toHaveCount(0);
  await expect(thinking.locator('option[value="ultra"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByTitle("Settings", { exact: true }).click();
  await expect(model).toHaveValue("test-fast");
  await expect(thinking).toHaveValue("low");
  await model.selectOption("test-deep");
  await thinking.selectOption("xhigh");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByTitle("Settings", { exact: true }).click();
  await expect(model).toHaveValue("test-deep");
  await expect(model.locator('option[value="test-deep"]')).toHaveText("Deep test model");
  await expect(thinking).toHaveValue("xhigh");
  await page.screenshot({ path: "test-results/codex-model-settings.png" });
});

test("Codex model list failure preserves a custom model and recovers after correcting the CLI path", async ({ page }) => {
  await page.getByTitle("Settings", { exact: true }).click();
  await page.getByLabel("Provider", { exact: true }).selectOption("codex");
  await page.getByLabel("Codex executable", { exact: true }).fill("missing-codex");
  await expect(page.getByRole("alert")).toContainText("Cannot load Codex models");
  await page.getByLabel("Codex model", { exact: true }).selectOption("__custom__");
  await page.getByLabel("Custom Codex model", { exact: true }).fill("private-model");
  await page.getByLabel("Codex executable", { exact: true }).fill("codex");
  await expect(page.getByLabel("Codex model", { exact: true }).locator('option[value="test-deep"]')).toHaveCount(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByTitle("Settings", { exact: true }).click();
  await expect(page.getByLabel("Codex model", { exact: true })).toHaveValue("private-model");
});

test("Japanese selection questions use the saved response language", async ({ page }) => {
  await page.getByTitle("Settings", { exact: true }).click();
  await page.getByLabel("Response language / 回答言語", { exact: true }).selectOption("ja");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByTitle("Settings", { exact: true }).click();
  await expect(page.getByLabel("Response language / 回答言語", { exact: true })).toHaveValue("ja");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  const text = page.locator('[data-page="1"] .textLayer span').first();
  const selectText = async () => {
    await text.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await text.dispatchEvent("mouseup");
  };
  await selectText();
  await page.getByRole("button", { name: "選択箇所について質問", exact: true }).click();
  await expect(page.getByLabel("Ask Komodo conversation", { exact: true }).getByText('次の選択箇所を日本語でわかりやすく説明してください：', { exact: false })).toBeVisible();
  await expect(page.locator(".katex-display")).toHaveCount(1);
  await page.getByTitle("Settings", { exact: true }).click();
  await page.getByLabel("Response language / 回答言語", { exact: true }).selectOption("en");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await selectText();
  await page.getByRole("button", { name: "Ask about this selection", exact: true }).click();
  await expect(page.getByLabel("Ask Komodo conversation", { exact: true }).getByText("Explain this selected passage in English:", { exact: false })).toBeVisible();
  await expect(page.locator(".katex-display")).toHaveCount(2);
});

test("PDF chat histories survive restart, keep citations, and continue the selected conversation", async ({ page }) => {
  const input = page.getByPlaceholder("Ask anything...");
  const history = page.getByLabel("Chat history / 履歴", { exact: true });
  await input.fill("First saved conversation");
  await input.press("Enter");
  await expect(history.locator("option")).toHaveCount(2);
  const first = await history.inputValue();
  await page.getByRole("button", { name: "New chat / 新しい会話", exact: true }).click();
  await expect(page.locator(".katex-display")).toHaveCount(0);
  await input.fill("Second saved conversation");
  await input.press("Enter");
  await expect(history.locator("option")).toHaveCount(3);
  const second = await history.inputValue();
  expect(second).not.toBe(first);
  await history.selectOption(first);
  await expect(page.getByText("First saved conversation", { exact: true })).toBeVisible();
  await expect(page.getByText("Second saved conversation", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "p.2", exact: true }).click();
  await expect(page.getByText("2 / 12", { exact: true })).toBeVisible();
  await input.fill("Continue the first conversation");
  await input.press("Enter");
  await expect(page.locator(".katex-display")).toHaveCount(2);
  const requests = await page.evaluate(() => (window as any).__chatRequests);
  expect(requests[2].conversationId).toBe(first);
  expect(requests[2].history.map((message: any) => message.content).join(" ")).toContain("First saved conversation");
  expect(requests[2].history.map((message: any) => message.content).join(" ")).not.toContain("Second saved conversation");
  await page.reload();
  await page.evaluate(() => { (window as any).__pdfName = "renamed-copy.pdf"; });
  await page.getByRole("button", { name: "Open PDF", exact: true }).click();
  await expect(history).toHaveValue(first);
  await expect(page.locator(".katex-display")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "p.2", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/pdf-chat-history.png" });
  await page.evaluate(() => { (window as any).__pdfVariant = " other document"; });
  await page.getByRole("button", { name: "Open PDF", exact: true }).click();
  await expect(history).toHaveValue("");
  await expect(history.locator("option")).toHaveCount(1);
  await expect(page.locator(".katex-display")).toHaveCount(0);
  await page.evaluate(() => { (window as any).__pdfVariant = ""; });
  await page.getByRole("button", { name: "Open PDF", exact: true }).click();
  await expect(history).toHaveValue(first);
  await expect(history.locator("option")).toHaveCount(3);
});

test("an answer keeps saving to its original PDF when another file is opened", async ({ page }) => {
  await page.evaluate(() => { (window as any).__pauseReply = true; });
  await page.getByPlaceholder("Ask anything...").fill("Answer in the original PDF");
  await page.getByPlaceholder("Ask anything...").press("Enter");
  await expect(page.getByText("Thinking...", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Chat history / 履歴", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "New chat / 新しい会話", exact: true })).toBeDisabled();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__finishReply)).toBe("function");
  await page.evaluate(() => { (window as any).__pdfVariant = " other document"; });
  await page.getByRole("button", { name: "Open PDF", exact: true }).click();
  await expect(page.getByLabel("Chat history / 履歴", { exact: true })).toBeEnabled();
  await page.evaluate(() => { (window as any).__finishReply(); });
  await page.waitForTimeout(100);
  await expect(page.locator(".katex-display")).toHaveCount(0);
  await page.evaluate(() => { (window as any).__pdfVariant = ""; });
  await page.getByRole("button", { name: "Open PDF", exact: true }).click();
  await expect(page.getByText("Answer in the original PDF", { exact: true })).toBeVisible();
  await expect(page.locator(".katex-display")).toHaveCount(1);
});

test("failed answers remain in history and failed history loads can be retried", async ({ page }) => {
  await page.evaluate(() => { (window as any).__failReply = true; });
  await page.getByPlaceholder("Ask anything...").fill("Keep this failed question");
  await page.getByPlaceholder("Ask anything...").press("Enter");
  await expect(page.getByText("Test provider failure", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Chat history / 履歴", { exact: true }).locator("option")).toHaveCount(2);
  await page.evaluate(() => { (window as any).__failHistory = true; });
  await page.getByRole("button", { name: "Open PDF", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("History storage unavailable");
  await expect(page.getByPlaceholder("Ask anything...")).toBeDisabled();
  await page.evaluate(() => { (window as any).__failHistory = false; });
  await page.getByRole("button", { name: "Retry / 再試行", exact: true }).click();
  await expect(page.getByText("Keep this failed question", { exact: true })).toBeVisible();
  await expect(page.getByText("Test provider failure", { exact: false })).toBeVisible();
  await expect(page.getByPlaceholder("Ask anything...")).toBeEnabled();
});

test("a delayed history load cannot replace the conversation of a newly opened PDF", async ({ page }) => {
  const input = page.getByPlaceholder("Ask anything...");
  const history = page.getByLabel("Chat history / 履歴", { exact: true });
  await input.fill("Old thread A");
  await input.press("Enter");
  await expect(history.locator("option")).toHaveCount(2);
  const first = await history.inputValue();
  await page.getByRole("button", { name: "New chat / 新しい会話", exact: true }).click();
  await input.fill("Old thread B");
  await input.press("Enter");
  await expect(history.locator("option")).toHaveCount(3);
  await page.evaluate(() => { (window as any).__historyDelay = 500; });
  await history.selectOption(first);
  await page.evaluate(() => { (window as any).__pdfVariant = " other document"; });
  await page.getByRole("button", { name: "Open PDF", exact: true }).click();
  await expect(history).toBeEnabled();
  await page.waitForTimeout(600);
  await expect(history).toHaveValue("");
  await expect(history.locator("option")).toHaveCount(1);
  await expect(page.getByText("Old thread A", { exact: true })).toHaveCount(0);
  await expect(page.locator(".katex-display")).toHaveCount(0);
});


test("ChatGPT sign-in can be cancelled, completed, saved and signed out", async ({ page }) => {
  await page.getByTitle("Settings", { exact: true }).click();
  await page.getByLabel("Provider", { exact: true }).selectOption("chatgpt");
  await page.getByRole("button", { name: "Continue with ChatGPT", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cancel sign-in" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel sign-in" }).click();
  await page.getByRole("button", { name: "Continue with ChatGPT", exact: true }).click();
  await page.evaluate(() => (window as any).__completeChatgptSignIn());
  await page.getByRole("button", { name: "Got it", exact: true }).click();
  await expect(page.getByLabel("ChatGPT model", { exact: true })).toHaveValue("plan-model");
  await page.getByLabel("Thinking level / 思考の深さ", { exact: true }).selectOption("high");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByTitle("Settings", { exact: true }).click();
  await expect(page.getByLabel("Provider", { exact: true })).toHaveValue("chatgpt");
  await expect(page.getByLabel("ChatGPT model", { exact: true })).toHaveValue("plan-model");
  await expect(page.getByLabel("Thinking level / 思考の深さ", { exact: true })).toHaveValue("high");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByLabel("ChatGPT model", { exact: true })).toBeDisabled();
});
