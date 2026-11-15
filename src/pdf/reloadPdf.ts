import { readFile, stat } from "@tauri-apps/plugin-fs";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { getDocumentState, snapshot, updateDocumentState, useReaderStore } from "../state/useReaderStore";
import { loadPdfFromArrayBuffer } from "./loader";
import { sha256 } from "./openPdf";
import { preparePageSizes } from "./pageSizes";

const jobs = new WeakMap<PDFDocumentProxy, Promise<boolean>>();
export function reloadPdf(doc: PDFDocumentProxy): Promise<boolean> {
  const pending = jobs.get(doc);
  if (pending) return pending;
  const job = reload(doc).finally(() => jobs.delete(doc));
  jobs.set(doc, job);
  return job;
}

async function reload(doc: PDFDocumentProxy): Promise<boolean> {
  const original = getDocumentState(doc);
  if (!original) return false;
  if (original.streaming || original.indexState === "indexing" || original.indexState === "extracting" || original.pendingQuestion) {
    updateDocumentState(doc, { reloadError: "Reload waiting for the current AI task to finish." });
    return false;
  }
  updateDocumentState(doc, { reloading: true, reloadError: null });
  let replacement: PDFDocumentProxy | undefined;
  try {
    const buffer = new Uint8Array(await readFile(original.fileName)).buffer;
    const hash = await sha256(buffer);
    if (hash === original.fileHash) return true;
    // PDF.js is intentionally given a memory snapshot, never a locked file handle.
    replacement = await loadPdfFromArrayBuffer(buffer);
    await preparePageSizes(replacement);
    const outline = await replacement.getOutline().catch(() => []);
    const current = getDocumentState(doc);
    if (!current || current.streaming || current.indexState === "indexing" || current.indexState === "extracting" || current.pendingQuestion) return false;
    const currentPage = Math.min(current.currentPage, replacement.numPages);
    const anchor = current.scrollAnchor;
    const patch = {
      pdfDoc: replacement, fileHash: hash, totalPages: replacement.numPages, currentPage,
      scrollAnchor: anchor ? { ...anchor, page: Math.min(anchor.page, replacement.numPages) } : null,
      outline: outline ?? [], hasTextMap: new Map<number, boolean>(), selection: "", selectionQuads: [],
      activeHighlight: null, indexState: "idle" as const, indexProgress: null, pendingQuestion: null,
      activeModal: "none" as const, messages: [], conversationId: null, chatHistoryReady: false,
      reloading: false, reloadError: null,
    };
    // Update the tab snapshot too: close/activate must never revive the old proxy.
    useReaderStore.setState((state) => ({
      ...(state.pdfDoc === doc ? patch : {}),
      tabs: state.tabs.map((tab) => tab.state.pdfDoc === doc
        ? { ...tab, state: { ...snapshot(current), ...patch } } : tab),
    }));
    replacement = undefined;
    void doc.destroy().catch(console.warn);
    return true;
  } catch (error) {
    updateDocumentState(doc, { reloadError: `PDF update not ready; keeping the previous version. ${String(error)}` });
    return false;
  } finally {
    if (replacement) void replacement.destroy().catch(console.warn);
    updateDocumentState(doc, { reloading: false });
  }
}

// Poll metadata rather than a file watch: this also handles delete/rename/replace
// writes used by TeX on Windows. Two stable samples debounce incomplete writes.
export function createPdfPoller() {
  const versions = new Map<string, { candidate: string; accepted?: string }>();
  let running = false;
  return async () => {
    if (running || !useReaderStore.getState().autoReload) return;
    running = true;
    try {
      const state = useReaderStore.getState();
      const tabs = state.tabs.map((tab) => tab.id === state.activeTabId ? state : tab.state);
      const paths = new Set(tabs.map((tab) => tab.fileName));
      for (const path of versions.keys()) if (!paths.has(path)) versions.delete(path);
      await Promise.all(tabs.map(async (tab) => {
        if (!tab.pdfDoc) return;
        try {
          const info = await stat(tab.fileName);
          const signature = `${info.size}:${info.mtime?.getTime()}`;
          const previous = versions.get(tab.fileName);
          if (!previous || previous.candidate !== signature) {
            versions.set(tab.fileName, { candidate: signature, accepted: previous?.accepted });
            return;
          }
          if (previous.accepted !== signature && await reloadPdf(tab.pdfDoc)) previous.accepted = signature;
        } catch (error) {
          // Retry after transient missing files, permission errors or partial writes.
          versions.delete(tab.fileName);
          updateDocumentState(tab.pdfDoc, { reloadError: `Cannot check PDF updates; keeping the previous version. ${String(error)}` });
        }
      }));
    } finally { running = false; }
  };
}
