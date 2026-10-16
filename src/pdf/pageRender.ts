import type { PDFPageProxy } from "pdfjs-dist";

export function canvasOutputScale(width: number, height: number, devicePixelRatio: number) {
  // Match physical screen pixels. Forced supersampling downsizes LCD text and
  // weakens fine strokes on standard-DPI displays. Keep large surfaces bounded.
  return Math.min(Math.max(1, devicePixelRatio || 1),
    Math.sqrt(16_777_216 / (width * height)), 16_384 / width, 16_384 / height);
}

export async function renderPageToCanvas(page: PDFPageProxy, canvas: HTMLCanvasElement, scale: number, signal: AbortSignal) {
  signal.throwIfAborted();
  const viewport = page.getViewport({ scale });
  const dpr = canvasOutputScale(viewport.width, viewport.height, window.devicePixelRatio);
  // Private canvases prevent overlapping render tasks and blank frames during zoom.
  const buffer = document.createElement("canvas");
  buffer.width = Math.ceil(viewport.width * dpr);
  buffer.height = Math.ceil(viewport.height * dpr);
  // As in PDF.js's viewer, declare the white PDF surface opaque. Transparent
  // canvases prevent LCD text antialiasing in Chromium and make CJK strokes faint.
  const ctx = buffer.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Could not get canvas context");
  const task = page.render({ canvasContext: ctx, viewport, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] });
  const cancel = () => task.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    await task.promise;
    signal.throwIfAborted();
    canvas.width = buffer.width;
    canvas.height = buffer.height;
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const output = canvas.getContext("2d", { alpha: false });
    if (!output) throw new Error("Could not get canvas context");
    output.drawImage(buffer, 0, 0);
  } finally {
    signal.removeEventListener("abort", cancel);
    buffer.width = buffer.height = 0;
  }
}
