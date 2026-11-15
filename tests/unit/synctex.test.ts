import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openPdfPath } from "../../src/pdf/openPdf";
import { useReaderStore } from "../../src/state/useReaderStore";
import { inverseSearch, subscribeToSyncTeX } from "../../src/pdf/synctex";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../../src/pdf/openPdf", () => ({ openPdfPath: vi.fn(async () => {}) }));
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const page = { view: [0, 0, 600, 800], getViewport: ({scale}: {scale: number}) => ({
  convertToViewportPoint: (x: number, y: number) => [x * scale, (800 - y) * scale],
  convertToPdfPoint: (x: number, y: number) => [x / scale, 800 - y / scale],
}) };
beforeEach(() => {
  vi.resetAllMocks();
  useReaderStore.setState({ pdfDoc: { numPages: 2, getPage: async () => page } as never,
    fileName: "C:/TeX/a b.pdf", totalPages: 2, navigationRequest: { page: 1, id: 0 } });
  vi.mocked(listen).mockResolvedValue(vi.fn());
});
it("drains startup request and navigates to the source line coordinate", async () => {
  vi.mocked(invoke).mockResolvedValueOnce([{ pdf: "C:/TeX/a b.pdf", source: "a b.tex", line: 5 }])
    .mockResolvedValueOnce({ page: 2, x: 134, y: 135 }).mockResolvedValue([]);
  const stop = subscribeToSyncTeX(vi.fn());
  await flush();
  expect(openPdfPath).toHaveBeenCalledWith("C:/TeX/a b.pdf");
  expect(useReaderStore.getState().navigationRequest).toMatchObject({ page: 2, y: 135 });
  stop();
});
it("converts inverse display coordinates to unscaled top-left PDF points", async () => {
  await inverseSearch(2, 268, 270, 2);
  expect(invoke).toHaveBeenCalledWith("synctex_inverse", { pdf: "C:/TeX/a b.pdf", page: 2, x: 134, y: 135 });
});
it("reports no match then continues with the following request", async () => {
  vi.mocked(invoke).mockResolvedValueOnce([
    { pdf: "missing.pdf", source: "x.tex", line: 1 }, { pdf: "good.pdf", source: "x.tex", line: 2 },
  ]).mockRejectedValueOnce(new Error("No match")).mockResolvedValueOnce({ page: 1, x: 10, y: 20 }).mockResolvedValue([]);
  const error = vi.fn();
  const stop = subscribeToSyncTeX(error);
  await flush();
  expect(error).toHaveBeenCalledOnce();
  expect(openPdfPath).toHaveBeenCalledWith("good.pdf");
  stop();
});
