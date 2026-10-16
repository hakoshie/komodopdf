import { useEffect, useRef } from "react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import { invoke } from "@tauri-apps/api/core";
import { Channel } from "@tauri-apps/api/core";
import Toolbar from "./components/Toolbar";
import DocumentTabs from "./components/DocumentTabs";
import OutlineSidebar from "./components/OutlineSidebar";
import ReaderPane from "./components/ReaderPane";
import AiPanel from "./components/AiPanel";
import SetupModal from "./components/SetupModal";
import IndexConfirmModal from "./components/IndexConfirmModal";
import IndexingModal from "./components/IndexingModal";
import { useReaderStore, getDocumentState, updateDocumentState } from "./state/useReaderStore";
import { extractAllPages } from "./pdf/extract";
import "./styles/theme.css";

const indexingJobs = new WeakMap<object, { cancelled: boolean }>();

function App() {
  const { activeModal, fileHash, pdfDoc, aiOpen, setAiOpen } = useReaderStore();
  const aiPanelRef = useRef<ImperativePanelHandle>(null);

  useEffect(() => {
    const panel = aiPanelRef.current;
    if (aiOpen) panel?.expand();
    else panel?.collapse();
  }, [aiOpen]);

  // Handle indexing when modal is "indexing"
  useEffect(() => {
    if (activeModal !== "indexing" || !fileHash || !pdfDoc) return;
    if (indexingJobs.get(pdfDoc)?.cancelled === false) return;
    const doc = pdfDoc;
    const job = { cancelled: false };
    indexingJobs.set(doc, job);
    const update = (patch: Parameters<typeof updateDocumentState>[1]) => {
      if (!job.cancelled) updateDocumentState(doc, patch);
    };
    const unsubscribe = useReaderStore.subscribe((state, previous) => {
      if (state.pdfDoc === doc && previous.pdfDoc === doc && previous.activeModal === "indexing"
        && state.activeModal === "none" && state.indexState !== "ready") {
        job.cancelled = true;
        updateDocumentState(doc, { indexState: "idle", indexProgress: null, pendingQuestion: null });
      }
    });

    async function run() {
      update({ indexState: "extracting" });
      const pages = await extractAllPages(pdfDoc!);
      if (job.cancelled || !getDocumentState(doc)) return;

      const auditEnabled = await invoke("is_audit_enabled").catch(() => false) as boolean;
      if (auditEnabled) {
        try {
          const auditText = pages
            .map((p) => `--- Page ${p.page} ---\n${p.spans.map((s) => s.text).join("")}`)
            .join("\n");
          await invoke("write_audit_file", { fileHash, content: auditText });
        } catch (e) {
          console.warn("Failed to write PDF audit file:", e);
        }
      }

      const textPages = pages.filter((p) => p.hasText);

      if (job.cancelled || !getDocumentState(doc)) return;

      update({ indexState: "indexing" });
      const progressChannel = new Channel<{ done: number; total: number }>();
      progressChannel.onmessage = (msg) => {
        update({ indexProgress: msg });
      };

      try {
        await invoke("index_document_cmd", {
          fileHash,
          pages: textPages,
          progress: progressChannel,
        });
        update({ indexProgress: null, indexState: "ready", activeModal: "none" });
      } catch (e) {
        fail(e);
      }
    }
    function fail(error: unknown) {
      const state = getDocumentState(doc);
      if (job.cancelled || !state) return;
      update({ pendingQuestion: null, indexState: "idle", indexProgress: null, activeModal: "none",
        messages: [...state.messages, { role: "assistant", content: `Indexing failed: ${String(error)}` }] });
    }
    void run().catch(fail).finally(() => {
      unsubscribe();
      if (indexingJobs.get(doc) === job) indexingJobs.delete(doc);
    });
  }, [activeModal, fileHash, pdfDoc]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <Toolbar />
      <DocumentTabs />
      <div style={{ display: "flex", flex: 1, overflow: "hidden", position: "relative", minHeight: 0 }}>
        <OutlineSidebar />
        <PanelGroup direction="horizontal" style={{ flex: 1, minWidth: 0 }}>
          <Panel defaultSize={70} minSize={30}>
            <ReaderPane />
          </Panel>
          <PanelResizeHandle
            className="resize-handle"
            disabled={!aiOpen}
            style={aiOpen ? undefined : { display: "none" }}
            aria-label="Resize PDF and Ask Komodo"
            title="Drag to resize PDF and Ask Komodo"
          >
            <span aria-hidden="true" />
          </PanelResizeHandle>
          <Panel ref={aiPanelRef} defaultSize={30} minSize={20} collapsible collapsedSize={0}
            onCollapse={() => setAiOpen(false)} onExpand={() => setAiOpen(true)}
            aria-hidden={!aiOpen} style={aiOpen ? undefined : { visibility: "hidden" }}>
            <AiPanel />
          </Panel>
        </PanelGroup>
      </div>

      {activeModal === "setup" && <SetupModal />}
      {activeModal === "indexConfirm" && <IndexConfirmModal />}
      {activeModal === "indexing" && <IndexingModal />}
    </div>
  );
}

export default App;
