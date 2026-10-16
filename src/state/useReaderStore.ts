import { create } from "zustand";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { ResponseLanguage } from "../utils/responseLanguage";

export interface Quad {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface OutlineItem {
  title: string;
  dest: string | any[] | null;
  items: OutlineItem[];
}

export interface Source {
  idx: number;
  chunkId: string;
  page: number;
  snippet: string;
  quads: Quad[];
}

export interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  citations?: number[];
}

interface ReaderState {
  tabs: { id: string; state: DocumentState }[];
  activeTabId: string | null;
  activateTab: (id: string) => void;
  closeTab: (id: string) => void;
  chatDraft: string;
  chatTextZoom: number;
  scrollAnchor: { page: number; fraction: number; left: number } | null;
  pdfDoc: PDFDocumentProxy | null;
  fileName: string;
  totalPages: number;
  currentPage: number;
  navigationRequest: { page: number; id: number };
  scale: number;
  displayScale: number;
  fitMode: "width" | "page" | null;
  outline: OutlineItem[];
  hasTextMap: Map<number, boolean>;
  selection: string;
  selectionQuads: Quad[];
  outlineOpen: boolean;
  aiOpen: boolean;

  // AI
  fileHash: string | null;
  indexState: "idle" | "extracting" | "indexing" | "ready";
  indexProgress: { done: number; total: number } | null;
  messages: Message[];
  conversationId: string | null;
  chatHistoryReady: boolean;
  streaming: boolean;
  activeHighlight: { page: number; quads: Quad[] } | null;
  pendingQuestion: string | null;
  activeModal: "none" | "setup" | "indexConfirm" | "indexing";

  // Config mirror
  configured: boolean;
  apiKeyPresent: boolean;
  baseUrl: string;
  chatBackend: "openai" | "codex" | "chatgpt";
  embedBackend: "local" | "remote";
  embedBaseUrl: string;
  embedModelRemote: string;
  chatModel: string;
  embeddingModel: string;
  topK: number;
  persona: string;
  responseLanguage: ResponseLanguage;

  setPdfDoc: (doc: PDFDocumentProxy | null, fileName?: string, fileHash?: string | null) => void;
  setCurrentPage: (page: number) => void;
  updateCurrentPage: (page: number) => void;
  setScale: (scale: number) => void;
  setDisplayScale: (scale: number) => void;
  setFitMode: (mode: "width" | "page" | null) => void;
  setOutline: (outline: OutlineItem[]) => void;
  setHasText: (pageNum: number, hasText: boolean) => void;
  setSelection: (text: string, quads?: Quad[]) => void;
  toggleOutline: () => void;
  setAiOpen: (open: boolean) => void;
  nextPage: () => void;
  prevPage: () => void;

  setFileHash: (hash: string | null) => void;
  setIndexState: (state: ReaderState["indexState"]) => void;
  setIndexProgress: (progress: ReaderState["indexProgress"]) => void;
  addMessage: (message: Message) => void;
  appendToken: (token: string) => void;
  setStreaming: (streaming: boolean) => void;
  setActiveHighlight: (highlight: ReaderState["activeHighlight"]) => void;
  clearHighlight: () => void;
  setPendingQuestion: (q: string | null) => void;
  setActiveModal: (modal: ReaderState["activeModal"]) => void;
  setConfigured: (v: boolean) => void;
  setApiKeyPresent: (v: boolean) => void;
  setConfig: (cfg: Partial<Pick<ReaderState, "baseUrl" | "chatModel" | "chatBackend" | "embedBackend" | "embedBaseUrl" | "embedModelRemote" | "embeddingModel" | "topK" | "persona" | "responseLanguage">>) => void;
  clearChat: () => void;
}

const documentKeys = ["pdfDoc", "fileName", "fileHash", "totalPages", "currentPage", "navigationRequest",
  "scale", "displayScale", "fitMode", "outline", "hasTextMap", "selection", "selectionQuads", "outlineOpen",
  "aiOpen", "indexState", "indexProgress", "messages", "conversationId", "chatHistoryReady", "streaming",
  "activeHighlight", "pendingQuestion", "activeModal", "chatDraft", "chatTextZoom", "scrollAnchor"] as const;
type DocumentState = Pick<ReaderState, typeof documentKeys[number]>;
function snapshot(state: ReaderState): DocumentState {
  return Object.fromEntries(documentKeys.map((key) => [key, state[key]])) as DocumentState;
}

// Async work belongs to its original PDF, including while that tab is inactive.
export function getDocumentState(doc: PDFDocumentProxy): DocumentState | undefined {
  const state = useReaderStore.getState();
  return state.pdfDoc === doc ? state : state.tabs.find((tab) => tab.state.pdfDoc === doc)?.state;
}
export function updateDocumentState(doc: PDFDocumentProxy, patch: Partial<DocumentState>) {
  useReaderStore.setState((state) => state.pdfDoc === doc ? patch : {
    tabs: state.tabs.map((tab) => tab.state.pdfDoc === doc ? { ...tab, state: { ...tab.state, ...patch } } : tab),
  });
}

export const useReaderStore = create<ReaderState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  chatDraft: "",
  chatTextZoom: 1,
  scrollAnchor: null,
  activateTab: (id) => {
    const state = get();
    if (id === state.activeTabId) return;
    const target = state.tabs.find((tab) => tab.id === id);
    if (!target) return;
    const tabs = state.tabs.map((tab) => tab.id === state.activeTabId ? { ...tab, state: snapshot(state) } : tab);
    set({ ...target.state, tabs, activeTabId: id });
  },
  closeTab: (id) => {
    const state = get();
    const closing = state.tabs.find((tab) => tab.id === id);
    if (!closing) return;
    const index = state.tabs.indexOf(closing);
    if (state.activeTabId === id) {
      const next = state.tabs[index + 1] ?? state.tabs[index - 1];
      if (next) state.activateTab(next.id);
      else state.setPdfDoc(null);
    }
    set({ tabs: get().tabs.filter((tab) => tab.id !== id) });
    void closing.state.pdfDoc?.destroy().catch(console.warn);
  },
  pdfDoc: null,
  fileName: "",
  totalPages: 0,
  currentPage: 1,
  navigationRequest: { page: 1, id: 0 },
  scale: 1,
  displayScale: 1,
  fitMode: "width",
  outline: [],
  hasTextMap: new Map(),
  selection: "",
  selectionQuads: [],
  outlineOpen: true,
  aiOpen: true,

  fileHash: null,
  indexState: "idle",
  indexProgress: null,
  messages: [],
  conversationId: null,
  chatHistoryReady: false,
  streaming: false,
  activeHighlight: null,
  pendingQuestion: null,
  activeModal: "none",

  configured: false,
  apiKeyPresent: false,
  baseUrl: "https://api.openai.com/v1",
  chatBackend: "openai",
  embedBackend: "local",
  embedBaseUrl: "",
  embedModelRemote: "",
  chatModel: "gpt-4o-mini",
  embeddingModel: "bge-small-en-v1.5",
  topK: 6,
  persona: "Explain simply",
  responseLanguage: "auto",

  setPdfDoc: (doc, fileName = "", fileHash = null) => {
    if (doc) {
      const previous = get();
      const tabs = previous.tabs.map((tab) => tab.id === previous.activeTabId ? { ...tab, state: snapshot(previous) } : tab);
      set({
        pdfDoc: doc,
        fileName,
        fileHash,
        totalPages: doc.numPages,
        currentPage: 1,
        scale: 1,
        displayScale: 1,
        chatDraft: "",
        chatTextZoom: 1,
        scrollAnchor: null,
        fitMode: "width",
        navigationRequest: { page: 1, id: get().navigationRequest.id + 1 },
        outline: [],
        hasTextMap: new Map(),
        selection: "",
        selectionQuads: [],
        indexState: "idle",
        indexProgress: null,
        messages: [],
        conversationId: null,
        chatHistoryReady: false,
        streaming: false,
        activeHighlight: null,
        pendingQuestion: null,
        activeModal: "none",
      });
      const id = crypto.randomUUID();
      set({ tabs: [...tabs, { id, state: snapshot(get()) }], activeTabId: id });
    } else {
      set({
        tabs: [],
        activeTabId: null,
        chatDraft: "",
        chatTextZoom: 1,
        scrollAnchor: null,
        activeModal: "none",
        pdfDoc: null,
        fileName: "",
        fileHash: null,
        totalPages: 0,
        currentPage: 1,
        outline: [],
        hasTextMap: new Map(),
        selection: "",
        selectionQuads: [],
        indexState: "idle",
        indexProgress: null,
        messages: [],
        conversationId: null,
        chatHistoryReady: false,
        streaming: false,
        activeHighlight: null,
        pendingQuestion: null,
      });
    }
  },

  setCurrentPage: (page) => {
    if (!Number.isFinite(page)) return;
    const target = Math.max(1, Math.min(Math.trunc(page), get().totalPages || 1));
    set({ currentPage: target, scrollAnchor: null, navigationRequest: { page: target, id: get().navigationRequest.id + 1 } });
  },
  updateCurrentPage: (page) => set({ currentPage: page }),
  setScale: (scale) => set({ scale: Math.max(0.25, Math.min(5, scale)), fitMode: null }),
  setDisplayScale: (displayScale) => set({ displayScale }),
  setFitMode: (mode) => set({ fitMode: mode }),
  setOutline: (outline) => set({ outline }),
  setHasText: (pageNum, hasText) => {
    const map = new Map(get().hasTextMap);
    map.set(pageNum, hasText);
    set({ hasTextMap: map });
  },
  setSelection: (text, quads = []) => set({ selection: text, selectionQuads: quads }),
  toggleOutline: () => set((s) => ({ outlineOpen: !s.outlineOpen })),
  setAiOpen: (aiOpen) => set({ aiOpen }),
  nextPage: () => {
    const s = get();
    if (s.currentPage < s.totalPages) s.setCurrentPage(s.currentPage + 1);
  },
  prevPage: () => {
    const s = get();
    if (s.currentPage > 1) s.setCurrentPage(s.currentPage - 1);
  },

  setFileHash: (hash) => set({ fileHash: hash }),
  setIndexState: (state) => set({ indexState: state }),
  setIndexProgress: (progress) => set({ indexProgress: progress }),
  addMessage: (message) => set((s) => ({ messages: [...s.messages, message] })),
  appendToken: (token) =>
    set((s) => {
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant") {
        msgs[msgs.length - 1] = { ...last, content: last.content + token };
      } else {
        msgs.push({ role: "assistant", content: token });
      }
      return { messages: msgs };
    }),
  setStreaming: (streaming) => set({ streaming }),
  setActiveHighlight: (highlight) => set({ activeHighlight: highlight }),
  clearHighlight: () => set({ activeHighlight: null }),
  setPendingQuestion: (q) => set({ pendingQuestion: q }),
  setActiveModal: (modal) => set({ activeModal: modal }),
  setConfigured: (v) => set({ configured: v }),
  setApiKeyPresent: (v) => set({ apiKeyPresent: v }),
  setConfig: (cfg) => {
    const previous = get();
    const backend = cfg.embedBackend ?? previous.embedBackend;
    const changed = backend !== previous.embedBackend || (backend === "local"
      ? cfg.embeddingModel !== undefined && cfg.embeddingModel !== previous.embeddingModel
      : (cfg.embedBaseUrl !== undefined && cfg.embedBaseUrl !== previous.embedBaseUrl)
        || (cfg.embedModelRemote !== undefined && cfg.embedModelRemote !== previous.embedModelRemote));
    set({ ...cfg, ...(changed ? { indexState: "idle" as const,
      tabs: previous.tabs.map((tab) => ({ ...tab, state: { ...tab.state, indexState: "idle" as const } })) } : {}) });
  },
  clearChat: () => set({ messages: [] }),
}));
