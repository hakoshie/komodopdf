import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useReaderStore, type Message } from "../state/useReaderStore";

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}
interface SavedConversation { id: string; messages: Message[] }

export function useChatHistory() {
  const { pdfDoc, fileHash } = useReaderStore();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const request = useRef(0);

  useEffect(() => {
    const version = ++request.current;
    setConversations([]);
    setError("");
    if (!fileHash || !pdfDoc) { setLoading(false); return; }
    setLoading(true);
    useReaderStore.setState({ chatHistoryReady: false });
    const current = () => version === request.current && useReaderStore.getState().pdfDoc === pdfDoc;
    void (async () => {
      try {
        const list = await invoke<ConversationSummary[]>("list_conversations", { fileHash });
        const latest = list[0];
        const saved = latest ? await invoke<SavedConversation>("load_conversation", { fileHash, conversationId: latest.id }) : null;
        if (!current()) return;
        setConversations(list);
        useReaderStore.setState({ conversationId: saved?.id ?? null, messages: saved?.messages ?? [], chatHistoryReady: true });
      } catch (e) {
        if (current()) setError(`Could not load chat history / 履歴を読み込めませんでした: ${String(e)}`);
      } finally {
        if (current()) setLoading(false);
      }
    })();
    return () => { ++request.current; };
  }, [fileHash, pdfDoc, retry]);

  const refresh = useCallback(async () => {
    const store = useReaderStore.getState();
    if (!store.fileHash) return;
    try {
      const list = await invoke<ConversationSummary[]>("list_conversations", { fileHash: store.fileHash });
      if (useReaderStore.getState().pdfDoc === store.pdfDoc) setConversations(list);
    } catch (e) {
      if (useReaderStore.getState().pdfDoc === store.pdfDoc) setError(`Could not refresh chat history: ${String(e)}`);
    }
  }, []);

  async function select(conversationId: string) {
    const store = useReaderStore.getState();
    if (!store.fileHash || store.streaming || loading) return;
    const version = ++request.current;
    setLoading(true);
    setError("");
    useReaderStore.setState({ chatHistoryReady: false });
    try {
      const saved = await invoke<SavedConversation>("load_conversation", { fileHash: store.fileHash, conversationId });
      if (version !== request.current || useReaderStore.getState().pdfDoc !== store.pdfDoc) return;
      useReaderStore.setState({ conversationId: saved.id, messages: saved.messages, activeHighlight: null, pendingQuestion: null });
    } catch (e) {
      if (version === request.current) setError(`Could not open chat history / 履歴を開けませんでした: ${String(e)}`);
    } finally {
      if (version === request.current && useReaderStore.getState().pdfDoc === store.pdfDoc) {
        useReaderStore.setState({ chatHistoryReady: true });
        setLoading(false);
      }
    }
  }

  function newChat() {
    const store = useReaderStore.getState();
    if (!store.chatHistoryReady || store.streaming || loading) return;
    useReaderStore.setState({ conversationId: null, messages: [], activeHighlight: null, pendingQuestion: null });
    setError("");
  }

  return { conversations, loading, error, select, newChat, refresh, retry: () => setRetry((value) => value + 1) };
}
