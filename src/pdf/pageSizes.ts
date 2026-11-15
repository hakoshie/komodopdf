import type { PDFDocumentProxy } from "pdfjs-dist";

export const preparedPageSizes = new WeakMap<PDFDocumentProxy, { width: number; height: number }[]>();

// Validate every page before replacing a working document during a TeX rebuild.
export async function preparePageSizes(doc: PDFDocumentProxy) {
  const sizes = new Array<{ width: number; height: number }>(doc.numPages);
  let next = 1;
  await Promise.all(Array.from({ length: Math.min(4, doc.numPages) }, async () => {
    while (next <= doc.numPages) {
      const number = next++;
      const page = await doc.getPage(number);
      const { width, height } = page.getViewport({ scale: 1 });
      sizes[number - 1] = { width, height };
    }
  }));
  preparedPageSizes.set(doc, sizes);
}
