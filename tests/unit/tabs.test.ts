import { beforeEach, expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { getDocumentState, updateDocumentState, useReaderStore } from "../../src/state/useReaderStore";

const doc = () => ({ numPages: 12, destroy: vi.fn(async () => {}) }) as unknown as PDFDocumentProxy;
beforeEach(() => useReaderStore.getState().setPdfDoc(null));

it("restores each tab's draft, zoom and chosen conversation", () => {
  const first = doc();
  useReaderStore.getState().setPdfDoc(first, "first.pdf", "hash-a");
  const firstId = useReaderStore.getState().activeTabId!;
  useReaderStore.setState({ chatDraft: "draft A", scale: 2, conversationId: "chosen-chat", chatHistoryReady: true });
  useReaderStore.getState().setPdfDoc(doc(), "second.pdf", "hash-b");
  expect(useReaderStore.getState().chatDraft).toBe("");
  useReaderStore.getState().activateTab(firstId);
  expect(useReaderStore.getState()).toMatchObject({ pdfDoc: first, chatDraft: "draft A", scale: 2, conversationId: "chosen-chat", chatHistoryReady: true });
});

it("routes background work to its original document and ignores closed tabs", () => {
  const first = doc(), second = doc();
  useReaderStore.getState().setPdfDoc(first, "first.pdf");
  const firstId = useReaderStore.getState().activeTabId!;
  useReaderStore.getState().setPdfDoc(second, "second.pdf");
  updateDocumentState(first, { messages: [{ role: "assistant", content: "Only A" }], streaming: false });
  expect(useReaderStore.getState().messages).toEqual([]);
  expect(getDocumentState(first)?.messages[0].content).toBe("Only A");
  useReaderStore.getState().closeTab(firstId);
  expect(first.destroy).toHaveBeenCalledOnce();
  updateDocumentState(first, { streaming: true });
  expect(getDocumentState(first)).toBeUndefined();
  expect(useReaderStore.getState().pdfDoc).toBe(second);
  expect(useReaderStore.getState().streaming).toBe(false);
});

it("invalidates indexes in inactive tabs after changing embedding settings", () => {
  useReaderStore.getState().setPdfDoc(doc(), "first.pdf");
  const firstId = useReaderStore.getState().activeTabId!;
  useReaderStore.setState({ indexState: "ready", embedBackend: "local", embeddingModel: "old-model" });
  useReaderStore.getState().setPdfDoc(doc(), "second.pdf");
  useReaderStore.getState().setConfig({ embeddingModel: "new-model" });
  useReaderStore.getState().activateTab(firstId);
  expect(useReaderStore.getState().indexState).toBe("idle");
});
