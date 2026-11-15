import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useReaderStore } from "../state/useReaderStore";
import { openPdfPath } from "./openPdf";

interface ForwardRequest { pdf: string; source: string; line: number }
interface Position { page: number; x: number; y: number }

// Installed before draining, so cold-start and second-instance requests survive.
export function subscribeToSyncTeX(onError: (error: unknown) => void): () => void {
  let stopped = false;
  let draining = false;
  let requested = false;
  let unlisten: UnlistenFn | undefined;
  async function drain() {
    requested = true;
    if (draining || stopped) return;
    draining = true;
    try {
      while (requested && !stopped) {
        requested = false;
        const requests = await invoke<ForwardRequest[]>("take_synctex_requests");
        for (const request of requests) {
          try {
            const position = await invoke<Position>("synctex_forward", { request });
            await openPdfPath(request.pdf);
            const state = useReaderStore.getState();
            const doc = state.pdfDoc;
            if (!doc || position.page > doc.numPages) throw new Error("SyncTeX data is out of date. Rebuild the PDF.");
            const page = await doc.getPage(position.page);
            if (useReaderStore.getState().pdfDoc !== doc) continue;
            // SyncTeX uses unrotated MediaBox top-left coordinates in bp.
            const [left, , , top] = page.view;
            const [x, y] = page.getViewport({ scale: 1 }).convertToViewportPoint(left + position.x, top - position.y);
            useReaderStore.setState({ currentPage: position.page, scrollAnchor: null,
              navigationRequest: { page: position.page, id: useReaderStore.getState().navigationRequest.id + 1, y },
              activeHighlight: { page: position.page, quads: [{ x0: Math.max(0, x - 8), y0: Math.max(0, y - 8), x1: x + 160, y1: y + 12 }] } });
          } catch (error) { onError(error); }
        }
        if (requests.length) requested = true;
      }
    } catch (error) { onError(error); }
    finally { draining = false; }
  }
  void listen("synctex-requested", () => { void drain(); }).then(off => {
    if (stopped) { off(); return; }
    unlisten = off;
    void drain();
  }).catch(error => { if (!stopped) onError(error); });
  return () => { stopped = true; unlisten?.(); };
}

export async function inverseSearch(pageNumber: number, displayX: number, displayY: number, scale: number) {
  const { pdfDoc, fileName } = useReaderStore.getState();
  if (!pdfDoc || !fileName) return;
  const page = await pdfDoc.getPage(pageNumber);
  const [x, y] = page.getViewport({ scale }).convertToPdfPoint(displayX, displayY);
  if (useReaderStore.getState().pdfDoc !== pdfDoc) return;
  await invoke("synctex_inverse", { pdf: fileName, page: pageNumber, x: x - page.view[0], y: page.view[3] - y });
}
