import { readFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { useReaderStore, updateDocumentState } from "../state/useReaderStore";
import { loadPdfFromArrayBuffer } from "./loader";

async function sha256(arrayBuffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Manual opens and OS requests share one serial queue. A failed file must not
// block later requests; each successfully opened PDF gets its own tab.
let pending: Promise<void> = Promise.resolve();
export function openPdfPath(path: string): Promise<void> {
  const job = pending.then(() => loadPdfPath(path));
  pending = job.catch(() => {});
  return job;
}

async function loadPdfPath(path: string): Promise<void> {
  const pathKey = (value: string) => /^[a-z]:[\\/]|^\\\\/i.test(value) ? value.replace(/\//g, "\\").toLowerCase() : value;
  const state = useReaderStore.getState();
  const existing = state.tabs.find((tab) => pathKey(tab.state.fileName) === pathKey(path));
  if (existing) { state.activateTab(existing.id); return; }
  const bytes = await readFile(path);
  const arrayBuffer = new Uint8Array(bytes).buffer;
  // PDF.js transfers this buffer to its worker; hash it before that transfer.
  const fileHash = await sha256(arrayBuffer);
  const doc = await loadPdfFromArrayBuffer(arrayBuffer);
  useReaderStore.getState().setPdfDoc(doc, path, fileHash);

  const outline = await doc.getOutline().catch(() => []);
  updateDocumentState(doc, { outline: outline ?? [] });

  // Check if already indexed
  try {
    const config = useReaderStore.getState();
    const embedId = config.embedBackend === "remote"
      ? `remote:${config.embedBaseUrl.replace(/\/+$/, "")}/${config.embedModelRemote}`
      : `local:${config.embeddingModel}`;
    const indexed = (await invoke("is_indexed", { fileHash, embedId })) as boolean;
    updateDocumentState(doc, { indexState: indexed ? "ready" : "idle" });
  } catch {
    updateDocumentState(doc, { indexState: "idle" });
  }
}
