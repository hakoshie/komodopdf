import React from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import App from "../../src/App";
import { fixturePdf } from "./pdf";
import { useReaderStore } from "../../src/state/useReaderStore";
import { extractPageContent } from "../../src/pdf/extract";

const settings = { chatBackend: "openai", codexPath: "codex", codexModel: "", chatBaseUrl: "http://localhost:1234/v1", chatModel: "test",
  codexReasoningEffort: "",
  codexWebSearch: "live",
  embedBackend: "local", embedModel: "bge-small-en-v1.5", topK: 6, persona: "Explain simply", responseLanguage: "auto", configured: true, logLevel: "info" };
let asked = 0;
const conversations: Record<string, any> = JSON.parse(localStorage.getItem("test-conversations") || "{}");
const chatRequests: any[] = [];
(window as any).__chatRequests = chatRequests;
function saveChats() { localStorage.setItem("test-conversations", JSON.stringify(conversations)); }
function savedChat(args: any) {
  const chat = conversations[args.conversationId];
  if (!chat || chat.fileHash !== args.fileHash) throw new Error("Conversation does not belong to this PDF");
  return chat;
}
const openedUrls: string[] = [];
(window as any).__openedUrls = openedUrls;
const authStatus = { accounts: [] as any[], activeAccount: null as string | null, connected: false, pending: false, error: null, showWelcome: false };
(window as any).__completeChatgptSignIn = () => {
  Object.assign(authStatus, { accounts: [{ id: "issued-account", label: "user@example.test", connected: true }], activeAccount: "issued-account", connected: true, pending: false, showWelcome: true });
};
mockIPC(async (cmd, args: any) => {
  switch (cmd) {
    case "chatgpt_status": return structuredClone(authStatus);
    case "start_chatgpt_sign_in": authStatus.pending = true; return;
    case "cancel_chatgpt_sign_in": authStatus.pending = false; return;
    case "chatgpt_welcome_seen": authStatus.showWelcome = false; return;
    case "sign_out_chatgpt": authStatus.connected = false; authStatus.accounts[0].connected = false; return true;
    case "list_chatgpt_models": return [{ id: "plan-model", displayName: "Plan model", supportedReasoningEfforts: ["low", "high"] }];
    case "get_settings": return settings;
    case "set_settings": Object.assign(settings, args.settings); return;
    case "has_api_key": return false;
    case "list_embedding_models": return [];
    case "list_codex_models":
      if (args.executable === "missing-codex") throw new Error("Cannot load Codex models. Check the CLI path and login, then retry.");
      return [
        { id: "test-deep", displayName: "Deep test model", defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "ultra"] },
        { id: "test-fast", displayName: "Fast test model", defaultReasoningEffort: "low", supportedReasoningEfforts: ["low", "medium"] },
      ];
    case "test_connection": return { chatOk: true, embedOk: true };
    case "plugin:opener|open_url": openedUrls.push(args.url); return;
    case "plugin:dialog|open": return (window as any).__pdfName || "fixture.pdf";
    case "plugin:fs|read_file": return Array.from(fixturePdf((window as any).__pdfVariant || ""));
    case "is_indexed": return true;
    case "list_conversations": {
      if ((window as any).__failHistory) throw new Error("History storage unavailable");
      return Object.values(conversations).filter((chat: any) => chat.fileHash === args.fileHash)
        .sort((a: any, b: any) => b.updatedAt - a.updatedAt)
        .map((chat: any) => ({ id: chat.id, title: chat.title, updatedAt: chat.updatedAt, messageCount: chat.messages.length }));
    }
    case "load_conversation": {
      const chat = structuredClone(savedChat(args));
      if ((window as any).__historyDelay) await new Promise((resolve) => setTimeout(resolve, (window as any).__historyDelay));
      return chat;
    }
    case "create_conversation": {
      conversations[args.conversationId] = { id: args.conversationId, fileHash: args.fileHash, title: "New chat", updatedAt: Date.now(), messages: [] };
      saveChats(); return;
    }
    case "ask": {
      const chat = savedChat(args);
      chatRequests.push({ fileHash: args.fileHash, conversationId: args.conversationId, history: structuredClone(chat.messages.slice(-6)) });
      chat.messages.push({ role: "user", content: args.question });
      chat.title = chat.messages[0].content;
      chat.updatedAt = Date.now();
      saveChats();
      asked++;
      const page = asked === 1 ? 2 : 8;
      const extraction = await extractPageContent(await useReaderStore.getState().pdfDoc!.getPage(page), page);
      const source = { idx: 1, chunk_id: `source-${page}`, page, snippet: extraction.spans[0].text, quads: extraction.spans[0].quads };
      if ((window as any).__pauseReply) await new Promise<void>((resolve) => { (window as any).__finishReply = resolve; });
      if ((window as any).__failReply) {
        chat.messages.push({ role: "assistant", content: "\n[Error: Test provider failure]", sources: [], citations: [] });
        saveChats(); throw new Error("Test provider failure");
      }
      args.channel.onmessage({ kind: "sources", data: [source] });
      const answer = String.raw`The result is \(E=mc^2\) [1].

\[\int_0^1 x\,dx = \frac{1}{2}\]` + (args.question === "Explain the formula"
        ? "\n\n| Term | Value |\n| --- | --- |\n| x | 1 |\n\n~~~js\nconst x = 1;\n~~~" : args.question === "Search the web"
        ? "\n\n[Web source](https://example.com/research)" : "");
      chat.messages.push({ role: "assistant", content: answer, sources: [source], citations: [1] });
      chat.updatedAt = Date.now();
      saveChats();
      args.channel.onmessage({ kind: "token", data: answer });
      args.channel.onmessage({ kind: "done" });
      return;
    }
    default: throw new Error(`Unexpected IPC command: ${cmd}`);
  }
});
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
