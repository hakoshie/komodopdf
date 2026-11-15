import { useEffect } from "react";
import { createPdfPoller } from "../pdf/reloadPdf";

export function usePdfReload() {
  useEffect(() => {
    const poll = createPdfPoller();
    const timer = window.setInterval(() => { void poll(); }, 1000);
    return () => window.clearInterval(timer);
  }, []);
}
