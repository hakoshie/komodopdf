import { useEffect, useRef } from "react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import { invoke } from "@tauri-apps/api/core";
import { Channel } from "@tauri-apps/api/core";
import Toolbar from "./components/Toolbar";
import OutlineSidebar from "./components/OutlineSidebar";
import ReaderPane from "./components/ReaderPane";
import AiPanel from "./components/AiPanel";
import SetupModal from "./components/SetupModal";
import IndexConfirmModal from "./components/IndexConfirmModal";
import IndexingModal from "./components/IndexingModal";
import { useReaderStore } from "./state/useReaderStore";
import { extractAllPages } from "./pdf/extract";
import "./styles/theme.css";

function App() {
  const { activeModal, fileHash, pdfDoc, aiOpen, setAiOpen, setIndexState, setIndexProgress } = useReaderStore();
  const aiPanelRef = useRef<ImperativePanelHandle>(null);

  useEffect(() => {
    const panel = aiPanelRef.current;
    if (aiOpen) panel?.expand();
    else panel?.collapse();
  }, [aiOpen]);

  // Handle indexing when modal is "indexing"
  useEffect(() => {
    if (activeModal !== "indexing" || !fileHash || !pdfDoc) return;
    let cancelled = false;

    async function run() {
      setIndexState("extracting");
      const pages = await extractAllPages(pdfDoc!);
      if (cancelled) return;

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

      if (cancelled) return;

      setIndexState("indexing");
      const progressChannel = new Channel<{ done: number; total: number }>();
      progressChannel.onmessage = (msg) => {
        if (!cancelled) setIndexProgress(msg);
      };

      try {
        await invoke("index_document_cmd", {
          fileHash,
          pages: textPages,
          progress: progressChannel,
        });
        if (!cancelled) {
          setIndexProgress(null);
          setIndexState("ready");
          useReaderStore.getState().setActiveModal("none");
          // pendingQuestion stays in store; AiPanel will pick it up via its own effect
        }
      } catch (e) {
        if (!cancelled) {
          useReaderStore.getState().setPendingQuestion(null);
          useReaderStore.getState().addMessage({ role: "assistant", content: `Indexing failed: ${String(e)}` });
          setIndexState("idle");
          setIndexProgress(null);
          useReaderStore.getState().setActiveModal("none");
        }
      }
    }

    run().catch((e) => {
      if (cancelled) return;
      setIndexState("idle");
      setIndexProgress(null);
      useReaderStore.getState().setActiveModal("none");
      useReaderStore.getState().setPendingQuestion(null);
      useReaderStore.getState().addMessage({ role: "assistant", content: `Indexing failed: ${String(e)}` });
    });
    return () => {
      cancelled = true;
    };
  }, [activeModal, fileHash, pdfDoc]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <Toolbar />
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
