import { beforeEach, expect, it, vi } from "vitest";
import { readFile, stat } from "@tauri-apps/plugin-fs";
import { loadPdfFromArrayBuffer } from "../../src/pdf/loader";
import { createPdfPoller, reloadPdf } from "../../src/pdf/reloadPdf";
import { useReaderStore } from "../../src/state/useReaderStore";

vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn(), stat: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../src/pdf/loader", () => ({ loadPdfFromArrayBuffer: vi.fn() }));
function pdf(numPages = 4) {
  return { numPages, getOutline: vi.fn(async () => []), destroy: vi.fn(async () => {}),
    getPage: vi.fn(async () => ({ getViewport: () => ({ width: 600, height: 800 }) })) };
}
function open(doc = pdf()) {
  useReaderStore.getState().setPdfDoc(doc as never, "C:\\tex\\paper.pdf", "old-hash");
  return doc;
}
beforeEach(() => {
  vi.resetAllMocks();
  useReaderStore.getState().setPdfDoc(null);
  useReaderStore.setState({ autoReload: true });
  vi.mocked(readFile).mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
  vi.mocked(stat).mockResolvedValue({ size: 4, mtime: new Date(1000), ctime: new Date(500) } as never);
});

it("replaces in the same tab, preserves view and draft, invalidates stale PDF-dependent state", async () => {
  const old = open(), replacement = pdf(2);
  const id = useReaderStore.getState().activeTabId;
  useReaderStore.setState({ currentPage: 4, scale: 1.6, fitMode: null,
    scrollAnchor: { page: 4, fraction: 0.42, left: 50 }, chatDraft: "keep draft", indexState: "ready" });
  vi.mocked(loadPdfFromArrayBuffer).mockResolvedValue(replacement as never);
  expect(await reloadPdf(old as never)).toBe(true);
  const state = useReaderStore.getState();
  expect(state).toMatchObject({ activeTabId: id, currentPage: 2, scale: 1.6, fitMode: null,
    scrollAnchor: { page: 2, fraction: 0.42, left: 50 }, chatDraft: "keep draft", indexState: "idle", reloading: false });
  expect(state.tabs).toHaveLength(1);
  expect(state.tabs[0].state.pdfDoc).toBe(replacement);
  expect(old.destroy).toHaveBeenCalledOnce();
  state.closeTab(id!);
  expect(replacement.destroy).toHaveBeenCalledOnce();
});

it("keeps the old PDF on truncation or parse error, retries successfully", async () => {
  const old = open();
  vi.mocked(loadPdfFromArrayBuffer).mockRejectedValueOnce(new Error("incomplete PDF")).mockResolvedValueOnce(pdf() as never);
  expect(await reloadPdf(old as never)).toBe(false);
  expect(useReaderStore.getState().pdfDoc).toBe(old);
  expect(old.destroy).not.toHaveBeenCalled();
  expect(useReaderStore.getState().reloadError).toContain("previous version");
  expect(await reloadPdf(old as never)).toBe(true);
  expect(useReaderStore.getState().reloadError).toBeNull();
});

it("does not replace the old document when a page is incomplete", async () => {
  const old = open(), broken = pdf();
  broken.getPage.mockRejectedValue(new Error("bad page"));
  vi.mocked(loadPdfFromArrayBuffer).mockResolvedValue(broken as never);
  expect(await reloadPdf(old as never)).toBe(false);
  expect(useReaderStore.getState().pdfDoc).toBe(old);
  expect(broken.destroy).toHaveBeenCalledOnce();
});

it("does not revive a tab closed while loading, coalesces repeated requests", async () => {
  const old = open(), replacement = pdf();
  let finish!: (value: never) => void;
  vi.mocked(loadPdfFromArrayBuffer).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const a = reloadPdf(old as never), b = reloadPdf(old as never);
  expect(a).toBe(b);
  await vi.waitFor(() => expect(loadPdfFromArrayBuffer).toHaveBeenCalledOnce());
  useReaderStore.getState().closeTab(useReaderStore.getState().activeTabId!);
  finish(replacement as never);
  expect(await a).toBe(false);
  expect(useReaderStore.getState().tabs).toHaveLength(0);
  expect(replacement.destroy).toHaveBeenCalledOnce();
});

it("reloads inactive tabs without switching the user's active tab", async () => {
  const old = open(), other = pdf(), replacement = pdf();
  useReaderStore.getState().setPdfDoc(other as never, "other.pdf", "other-hash");
  vi.mocked(loadPdfFromArrayBuffer).mockResolvedValue(replacement as never);
  await reloadPdf(old as never);
  expect(useReaderStore.getState().pdfDoc).toBe(other);
  useReaderStore.getState().activateTab(useReaderStore.getState().tabs[0].id);
  expect(useReaderStore.getState().pdfDoc).toBe(replacement);
});

it("debounces changed metadata, retries missing files, and avoids rereading unchanged versions", async () => {
  open();
  vi.mocked(loadPdfFromArrayBuffer).mockResolvedValue(pdf() as never);
  const poll = createPdfPoller();
  await poll();
  expect(readFile).not.toHaveBeenCalled();
  await poll();
  expect(readFile).toHaveBeenCalledTimes(1);
  await poll();
  expect(readFile).toHaveBeenCalledTimes(1);
  vi.mocked(stat).mockRejectedValueOnce(new Error("renaming"));
  await poll(); await poll(); await poll();
  expect(readFile).toHaveBeenCalledTimes(2);
  // Same bytes: no new PDF parsing, no stale warning.
  expect(loadPdfFromArrayBuffer).toHaveBeenCalledTimes(1);
  expect(useReaderStore.getState().reloadError).toBeNull();
});

it("defers AI work and supports disabling automatic reload without disabling manual reload", async () => {
  const old = open();
  useReaderStore.setState({ streaming: true });
  expect(await reloadPdf(old as never)).toBe(false);
  expect(readFile).not.toHaveBeenCalled();
  useReaderStore.setState({ streaming: false, autoReload: false });
  await createPdfPoller()();
  expect(stat).not.toHaveBeenCalled();
  vi.mocked(loadPdfFromArrayBuffer).mockResolvedValue(pdf() as never);
  expect(await reloadPdf(old as never)).toBe(true);
});
