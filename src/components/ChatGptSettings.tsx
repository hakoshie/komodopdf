import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

interface Status {
  accounts: { id: string; label: string; connected: boolean }[];
  activeAccount: string | null;
  connected: boolean;
  pending: boolean;
  error: string | null;
  showWelcome: boolean;
}
interface Model { id: string; displayName: string; supportedReasoningEfforts: string[] }
interface Props {
  model: string; setModel: (value: string) => void;
  effort: string; setEffort: (value: string) => void;
  webSearch: boolean; setWebSearch: (value: boolean) => void;
  onConnectedChange: (value: boolean) => void;
}

export default function ChatGptSettings({ model, setModel, effort, setEffort, webSearch, setWebSearch, onConnectedChange }: Props) {
  const [status, setStatus] = useState<Status | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null);
  const style = { width: "100%", padding: "8px", margin: "6px 0 12px", background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 6 };

  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      try {
        const value = await invoke<Status>("chatgpt_status");
        if (!cancelled) {
          setStatus(value);
          setSelectedAccount((current) => current ?? value.activeAccount);
        }
      } catch (e) { if (!cancelled) { setError(String(e)); onConnectedChange(false); } }
    };
    void read();
    const timer = setInterval(() => { void read(); }, 1500);
    return () => { cancelled = true; clearInterval(timer); onConnectedChange(false); };
  }, [onConnectedChange]);

  useEffect(() => { setSelectedAccount(status?.activeAccount ?? null); }, [status?.activeAccount]);
  useEffect(() => {
    onConnectedChange(Boolean(status?.connected && selectedAccount === status.activeAccount));
  }, [status?.connected, status?.activeAccount, selectedAccount, onConnectedChange]);

  useEffect(() => {
    setModels([]);
    if (!status?.connected) return;
    let cancelled = false;
    setLoading(true); setError(null);
    invoke<Model[]>("list_chatgpt_models").then((list) => {
      if (!cancelled) setModels(list);
    }).catch((e) => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [status?.activeAccount, status?.connected, refresh]);

  useEffect(() => {
    if (models.length && !models.some((m) => m.id === model)) { setModel(models[0].id); setEffort(""); }
  }, [models, model, setModel, setEffort]);
  const levels = models.find((m) => m.id === model)?.supportedReasoningEfforts ?? [];
  useEffect(() => { if (effort && models.length && !levels.includes(effort)) setEffort(""); }, [effort, models, levels.join(","), setEffort]);

  async function action(command: string, args?: Record<string, unknown>) {
    setBusy(true); setError(null);
    try {
      const result = await invoke(command, args);
      if (command === "sign_out_chatgpt" && result === false) setError("Signed out locally. Remote disconnection could not be confirmed; disconnect Komodo in ChatGPT settings.");
      const value = await invoke<Status>("chatgpt_status");
      setStatus(value);
      setSelectedAccount(value.activeAccount);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }

  return <div>
    <p style={{ fontSize: 12, color: "var(--text-muted)" }}>Connect your ChatGPT account to use your eligible plan or credits for PDF questions. No API key or Codex CLI is required.</p>
    {status?.accounts.length ? <>
      <label htmlFor="chatgpt-account">ChatGPT account / アカウント</label>
      <select id="chatgpt-account" style={style} value={selectedAccount ?? ""} disabled={busy || status.pending}
        onChange={(e) => {
          const id = e.target.value; setSelectedAccount(id);
          if (status.accounts.find((a) => a.id === id)?.connected) void action("select_chatgpt_account", { accountId: id });
        }}>
        {status.accounts.map((a) => <option key={a.id} value={a.id}>{a.label}{a.connected ? "" : " (signed out)"}</option>)}
      </select>
    </> : null}
    <p role="status" style={{ fontSize: 12 }}>{status?.pending ? "Complete sign-in in your browser… / ブラウザでログインしてください" : status?.connected ? "Connected to ChatGPT / 接続済み" : "Not connected / 未接続"}</p>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {status?.pending ? <button type="button" onClick={() => { void action("cancel_chatgpt_sign_in"); }} disabled={busy}>Cancel sign-in</button> : <>
        <button type="button" className="btn-accent" style={{ padding: "10px 16px", borderRadius: 6 }} disabled={busy || !status}
          onClick={() => { void action("start_chatgpt_sign_in", { accountId: selectedAccount }); }}>Continue with ChatGPT</button>
        {status?.accounts.length ? <button type="button" disabled={busy} onClick={() => { void action("start_chatgpt_sign_in", { accountId: null }); }}>Add account / アカウントを追加</button> : null}
        {status?.connected && <button type="button" disabled={busy} onClick={() => { void action("sign_out_chatgpt"); }}>Sign out</button>}
      </>}
      <button type="button" onClick={() => { void openUrl("https://chatgpt.com/settings/usage").catch((e) => setError(String(e))); }}>Manage usage</button>
    </div>
    {(error || status?.error) && <p role="alert" style={{ fontSize: 12, color: "#f59e0b" }}>{error || status?.error}</p>}
    {status?.showWelcome && <div role="dialog" aria-label="You're using your ChatGPT plan" style={{ marginTop: 12, padding: 12, background: "var(--accent-tint)", borderRadius: 6 }}>
      <strong>You're using your ChatGPT plan</strong>
      <p style={{ fontSize: 12 }}>Eligible requests in Komodo use your ChatGPT plan or credits. Manage usage in ChatGPT settings. Conversation history stays in Komodo.</p>
      <button type="button" onClick={() => { void action("chatgpt_welcome_seen"); }}>Got it</button>
    </div>}
    <label htmlFor="chatgpt-model" style={{ display: "block", marginTop: 16 }}>ChatGPT model</label>
    <select id="chatgpt-model" style={style} value={model} disabled={!status?.connected || loading || !models.length}
      onChange={(e) => { setModel(e.target.value); setEffort(""); }}>
      <option value="">{loading ? "Loading models…" : "Select a model"}</option>
      {models.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
      {model && !models.some((m) => m.id === model) && <option value={model}>{model} (saved)</option>}
    </select>
    <button type="button" disabled={!status?.connected || loading} onClick={() => setRefresh((n) => n + 1)}>Refresh ChatGPT models</button>
    <label htmlFor="chatgpt-thinking" style={{ display: "block", marginTop: 12 }}>Thinking level / 思考の深さ</label>
    <select id="chatgpt-thinking" style={style} value={effort} disabled={!levels.length} onChange={(e) => setEffort(e.target.value)}>
      <option value="">Model default / モデルの既定</option>
      {levels.map((level) => <option key={level} value={level}>{level}</option>)}
    </select>
    <label><input type="checkbox" checked={webSearch} onChange={(e) => setWebSearch(e.target.checked)} /> Web search / ウェブ検索</label>
    <p style={{ fontSize: 12, color: "var(--text-muted)" }}>Your questions and selected document excerpts are sent to OpenAI. Web search availability depends on your model and account. Embeddings are configured separately below.</p>
  </div>;
}
