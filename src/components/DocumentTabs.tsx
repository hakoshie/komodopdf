import { useEffect, useRef } from "react";
import { useReaderStore } from "../state/useReaderStore";

export default function DocumentTabs() {
  const { tabs, activeTabId, activateTab, closeTab } = useReaderStore();
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bar.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || useReaderStore.getState().activeModal !== "none") return;
      const state = useReaderStore.getState();
      if (!state.tabs.length) return;
      if (event.key === "Tab") {
        event.preventDefault();
        const index = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
        const next = state.tabs[(index + (event.shiftKey ? -1 : 1) + state.tabs.length) % state.tabs.length];
        state.activateTab(next.id);
      } else if (event.key.toLowerCase() === "w") {
        event.preventDefault();
        if (state.activeTabId) state.closeTab(state.activeTabId);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);
  if (!tabs.length) return null;
  return <div className="document-tabs" role="tablist" aria-label="Open PDFs" ref={bar}>
    {tabs.map((tab, index) => {
      const name = tab.state.fileName.split(/[\\/]/).pop() || "PDF";
      const active = tab.id === activeTabId;
      return <div className={`document-tab${active ? " active" : ""}`} key={tab.id}>
        <button role="tab" aria-selected={active} tabIndex={active ? 0 : -1} title={tab.state.fileName}
          onClick={() => activateTab(tab.id)}
          onKeyDown={(event) => {
            let target: number;
            if (event.key === "ArrowRight") target = (index + 1) % tabs.length;
            else if (event.key === "ArrowLeft") target = (index - 1 + tabs.length) % tabs.length;
            else if (event.key === "Home") target = 0;
            else if (event.key === "End") target = tabs.length - 1;
            else if (event.key === "Delete") { event.preventDefault(); closeTab(tab.id); return; }
            else return;
            event.preventDefault(); activateTab(tabs[target].id);
            (bar.current?.querySelectorAll('[role="tab"]')[target] as HTMLButtonElement)?.focus();
          }}>{name}</button>
        <button className="close-tab" aria-label={`Close ${name}`} title="Close tab (Ctrl+W)"
          onClick={() => {
            closeTab(tab.id);
            (bar.current?.querySelector('[aria-selected="true"]') as HTMLButtonElement)?.focus();
          }}>×</button>
      </div>;
    })}
  </div>;
}
