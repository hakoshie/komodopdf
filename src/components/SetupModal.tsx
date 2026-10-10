import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Channel } from "@tauri-apps/api/core";
import { useReaderStore } from "../state/useReaderStore";
import ModelDownloadModal from "./ModelDownloadModal";
import { responseLanguage, type ResponseLanguage } from "../utils/responseLanguage";

interface ModelInfo {
  id: string;
  displayName: string;
  dimensions: number;
  status: {
    id: string;
    downloaded: boolean;
    files: { name: string; present: boolean; size: number }[];
    presentBytes: number;
    totalBytes: number;
  };
}

interface CodexModelOption {
  id: string;
  displayName: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: string[];
}

const thinkingLabels: Record<string, string> = {
  none: "None / なし", minimal: "Minimal / 最小", low: "Low / 軽め",
  medium: "Medium / 標準", high: "High / 深め", xhigh: "Extra high / より深く",
  max: "Max / 最大", ultra: "Ultra / 最高",
};

export default function SetupModal() {
  const {
    setActiveModal,
    setConfigured,
    setApiKeyPresent,
    baseUrl,
    chatModel,
    embeddingModel,
    setConfig,
  } = useReaderStore();

  const [localBaseUrl, setLocalBaseUrl] = useState(baseUrl);
  const [chatBackend, setChatBackend] = useState<"openai" | "codex">("openai");
  const [codexPath, setCodexPath] = useState("codex");
  const [codexModel, setCodexModel] = useState("");
  const [codexReasoningEffort, setCodexReasoningEffort] = useState("");
  const [codexWebSearch, setCodexWebSearch] = useState("live");
  const [codexModels, setCodexModels] = useState<CodexModelOption[]>([]);
  const [codexModelsLoading, setCodexModelsLoading] = useState(false);
  const [codexModelsError, setCodexModelsError] = useState<string | null>(null);
  const [codexModelsRefresh, setCodexModelsRefresh] = useState(0);
  const [customCodexModel, setCustomCodexModel] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [localChatModel, setLocalChatModel] = useState(chatModel);
  const [apiKey, setApiKey] = useState("");
  const [localEmbedModel, setLocalEmbedModel] = useState(embeddingModel);
  const [embedBackend, setEmbedBackend] = useState<"local" | "remote">("local");
  const [embedBaseUrl, setEmbedBaseUrl] = useState("");
  const [embedApiKey, setEmbedApiKey] = useState("");
  const [embedModelRemote, setEmbedModelRemote] = useState("");
  const [topK, setTopK] = useState(6);
  const [persona, setPersona] = useState("Explain simply");
  const [language, setLanguage] = useState<ResponseLanguage>(useReaderStore.getState().responseLanguage);
  const [logLevel, setLogLevel] = useState("info");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [testing, setTesting] = useState(false);
  const [chatKeySaved, setChatKeySaved] = useState(false);
  const [embedKeySaved, setEmbedKeySaved] = useState(false);
  const [testResult, setTestResult] = useState<{
    chatOk: boolean;
    chatErr?: string;
    embedOk: boolean;
    embedErr?: string;
  } | null>(null);

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedStatus, setSelectedStatus] = useState<ModelInfo["status"] | null>(null);
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{
    doneBytes: number;
    totalBytes: number;
    file: string;
  } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const settings: any = await invoke("get_settings");
        setChatBackend(settings.chatBackend === "codex" ? "codex" : "openai");
        setCodexPath(settings.codexPath || "codex");
        setCodexModel(settings.codexModel || "");
        setCodexReasoningEffort(settings.codexReasoningEffort || "");
        setCodexWebSearch(settings.codexWebSearch || "live");
        setLocalBaseUrl(settings.chatBaseUrl || "https://api.openai.com/v1");
        setLocalChatModel(settings.chatModel || "gpt-4o-mini");
        setLocalEmbedModel(settings.embedModel || "nomic-embed-text-v1.5");
        setEmbedBackend(settings.embedBackend === "remote" ? "remote" : "local");
        if (settings.embedBaseUrl) setEmbedBaseUrl(settings.embedBaseUrl);
        if (settings.embedModelRemote) setEmbedModelRemote(settings.embedModelRemote);
        setTopK(Number(settings.topK) || 6);
        setPersona(settings.persona || "Explain simply");
        setLanguage(responseLanguage(settings.responseLanguage));
        setLogLevel(settings.logLevel || "info");

        setApiKeyPresent(settings.configured === true);

        try {
          const chatHas = await invoke("has_api_key", { slot: "chat" });
          setChatKeySaved(!!chatHas);
        } catch {
          // ignore
        }
        try {
          const embedHas = await invoke("has_api_key", { slot: "embed" });
          setEmbedKeySaved(!!embedHas);
        } catch {
          // ignore
        }

        const list: ModelInfo[] = await invoke("list_embedding_models");
        setModels(list);
        const sel = list.find((m) => m.id === (settings.embedModel || "nomic-embed-text-v1.5"));
        if (sel) setSelectedStatus(sel.status);
      } catch {
        // ignore
      }
    })();
  }, []);

  useEffect(() => {
    if (chatBackend !== "codex") return;
    let cancelled = false;
    setCodexModelsLoading(true);
    setCodexModelsError(null);
    setCodexModels([]);
    const timer = setTimeout(() => {
      invoke<CodexModelOption[]>("list_codex_models", { executable: codexPath })
        .then((options) => { if (!cancelled) setCodexModels(options); })
        .catch((error) => { if (!cancelled) setCodexModelsError(String(error)); })
        .finally(() => { if (!cancelled) setCodexModelsLoading(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [chatBackend, codexPath, codexModelsRefresh]);

  const selectedCodexModel = codexModels.find((model) => model.id === codexModel);
  const thinkingLevels = !codexModel ? [] : selectedCodexModel?.supportedReasoningEfforts ?? Object.keys(thinkingLabels);

  useEffect(() => {
    if (selectedCodexModel && codexReasoningEffort && !selectedCodexModel.supportedReasoningEfforts.includes(codexReasoningEffort)) {
      setCodexReasoningEffort("");
    }
  }, [selectedCodexModel, codexReasoningEffort]);

  useEffect(() => {
    if (embedBackend === "local") {
      const sel = models.find((m) => m.id === localEmbedModel);
      setSelectedStatus(sel ? sel.status : null);
    } else {
      setSelectedStatus(null);
    }
  }, [localEmbedModel, models, embedBackend]);

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      await invoke("set_settings", {
        settings: {
          chatBackend, codexPath, codexModel,
          codexReasoningEffort: codexReasoningEffort || selectedCodexModel?.defaultReasoningEffort || "",
          codexWebSearch,
          chatBaseUrl: localBaseUrl,
          chatModel: localChatModel,
          embedBackend: embedBackend,
          embedModel: localEmbedModel,
          embedBaseUrl: embedBackend === "remote" ? embedBaseUrl || null : null,
          embedModelRemote: embedBackend === "remote" ? embedModelRemote || null : null,
          topK,
          persona,
          responseLanguage: language,
          logLevel,
          configured: true,
        },
      });
      if (chatBackend === "openai" && apiKey) {
        await invoke("set_api_key", { slot: "chat", key: apiKey });
      }
      if (embedBackend === "remote" && embedApiKey) {
        await invoke("set_api_key", { slot: "embed", key: embedApiKey });
      }
      const result: any = await invoke("test_connection", {
        chatKey: apiKey || null,
        embedKey: embedBackend === "remote" ? embedApiKey || null : null,
      });
      setTestResult(result);
    } catch (e: any) {
      setTestResult({
        chatOk: false,
        chatErr: e.toString(),
        embedOk: false,
        embedErr: e.toString(),
      });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    setSaveError(null);
    try {
      await invoke("set_settings", {
        settings: {
          chatBackend, codexPath, codexModel,
          codexReasoningEffort: codexReasoningEffort || selectedCodexModel?.defaultReasoningEffort || "",
          codexWebSearch,
          chatBaseUrl: localBaseUrl,
          chatModel: localChatModel,
          embedBackend: embedBackend,
          embedModel: localEmbedModel,
          embedBaseUrl: embedBackend === "remote" ? embedBaseUrl || null : null,
          embedModelRemote: embedBackend === "remote" ? embedModelRemote || null : null,
          topK,
          persona,
          responseLanguage: language,
          logLevel,
          configured: true,
        },
      });
      if (chatBackend === "openai" && apiKey) {
        await invoke("set_api_key", { slot: "chat", key: apiKey });
      }
      if (embedBackend === "remote" && embedApiKey) {
        await invoke("set_api_key", { slot: "embed", key: embedApiKey });
      }
      setApiKeyPresent(true);
      setConfigured(true);
      setConfig({
        chatBackend,
        embedBackend,
        embedBaseUrl,
        embedModelRemote,
        baseUrl: localBaseUrl,
        chatModel: localChatModel,
        embeddingModel: localEmbedModel,
        topK,
        persona,
        responseLanguage: language,
      });
      setActiveModal("none");
    } catch (e) {
      console.error("Save failed", e);
      setSaveError(String(e));
    }
  }

  async function handleDownload() {
    if (!selectedStatus) return;
    const modelId = selectedStatus.id;
    setDownloadingModel(modelId);
    setDownloadOpen(true);
    setDownloadProgress(null);
    try {
      const channel = new Channel<{
        doneBytes: number;
        totalBytes: number;
        file: string;
      }>();
      channel.onmessage = (msg) => {
        setDownloadProgress(msg);
      };
      await invoke("download_model_cmd", { modelId, progress: channel });
      // Refresh status
      const status: any = await invoke("model_status_cmd", { modelId });
      setSelectedStatus(status);
      // Also refresh the full list
      const list: ModelInfo[] = await invoke("list_embedding_models");
      setModels(list);
    } catch (e: any) {
      alert(`Download failed: ${e}`);
    } finally {
      setDownloadingModel(null);
      setDownloadOpen(false);
      setDownloadProgress(null);
    }
  }

  function openModelsFolder() {
    const modelId = embedBackend === "local" ? localEmbedModel : null;
    invoke("open_models_folder_cmd", { modelId });
  }

  const totalMb = selectedStatus ? Math.round(selectedStatus.totalBytes / 1024 / 1024) : 0;

  return (
    <div style={modalOverlayStyle}>
      <div style={modalContentStyle}>
        <h3 style={{ margin: "0 0 16px", fontSize: 16 }}>Settings</h3>
        {saveError && <p role="alert" style={{ color: "#ef4444", fontSize: 13 }}>Could not save settings: {saveError}</p>}

        <div style={sectionStyle}>
          <div style={sectionTitleStyle}>Chat (required)</div>
          <label style={labelStyle} htmlFor="chat-provider">Provider</label>
          <select id="chat-provider" value={chatBackend} style={inputStyle}
            onChange={(e) => setChatBackend(e.target.value as "openai" | "codex")}>
            <option value="openai">OpenAI-compatible API</option>
            <option value="codex">Codex CLI (existing login)</option>
          </select>
          <label style={labelStyle} htmlFor="response-language">Response language / 回答言語</label>
          <select id="response-language" value={language} style={inputStyle}
            onChange={(e) => setLanguage(responseLanguage(e.target.value))}>
            <option value="auto">Auto / 自動（質問に合わせる）</option>
            <option value="ja">日本語</option>
            <option value="en">English</option>
          </select>
          <p style={hintStyle}>選択箇所の説明と通常の回答に使用します。</p>
          {chatBackend === "codex" ? <>
            <label style={labelStyle} htmlFor="codex-path">Codex executable</label>
            <input id="codex-path" style={inputStyle} value={codexPath} onChange={(e) => setCodexPath(e.target.value)} placeholder="codex" />
            <label style={labelStyle} htmlFor="codex-model">Codex model</label>
            <select id="codex-model" style={inputStyle} value={customCodexModel ? "__custom__" : codexModel}
              onChange={(e) => {
                if (e.target.value === "__custom__") { setCustomCodexModel(true); return; }
                setCustomCodexModel(false);
                setCodexModel(e.target.value);
                const model = codexModels.find((option) => option.id === e.target.value);
                if (!model?.supportedReasoningEfforts.includes(codexReasoningEffort)) setCodexReasoningEffort("");
              }}>
              <option value="">CLI default / CLIの既定</option>
              {codexModels.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
              {codexModel && !selectedCodexModel && <option value={codexModel}>{codexModel} (saved/custom)</option>}
              <option value="__custom__">Custom model / 手動入力</option>
            </select>
            {customCodexModel && <>
              <label style={labelStyle} htmlFor="codex-custom-model">Custom Codex model</label>
              <input id="codex-custom-model" style={inputStyle} value={codexModel}
                onChange={(e) => { setCodexModel(e.target.value); setCodexReasoningEffort(""); }} placeholder="Model ID" />
            </>}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={hintStyle}>{codexModelsLoading ? "Loading models… / 読み込み中" : "Models available in your Codex CLI / 利用できるモデル"}</span>
              <button type="button" onClick={() => setCodexModelsRefresh((value) => value + 1)} disabled={codexModelsLoading}
                style={{ ...hintStyle, color: "var(--accent)", whiteSpace: "nowrap" }}>Refresh / 更新</button>
            </div>
            {codexModelsError && <p role="alert" style={{ ...hintStyle, color: "#f59e0b" }}>{codexModelsError}</p>}
            <label style={labelStyle} htmlFor="codex-thinking">Thinking level / 思考の深さ</label>
            <select id="codex-thinking" style={inputStyle} value={codexReasoningEffort} disabled={!codexModel || thinkingLevels.length === 0}
              onChange={(e) => setCodexReasoningEffort(e.target.value)}>
              <option value="">{selectedCodexModel ? `Model default / モデルの既定 (${selectedCodexModel.defaultReasoningEffort || "auto"})` : "CLI default / CLIの既定"}</option>
              {thinkingLevels.map((level) => <option key={level} value={level}>{thinkingLabels[level] || level}</option>)}
              {codexReasoningEffort && !thinkingLevels.includes(codexReasoningEffort) && <option value={codexReasoningEffort}>{codexReasoningEffort} (saved)</option>}
            </select>
            <p style={hintStyle}>{selectedCodexModel ? "モデルに対応する思考レベルを選択します。深く考えるほど回答に時間がかかる場合があります。" : codexModel ? "手動入力したモデルで利用できる思考レベルを選んでください。" : "モデルを選ぶとThinking levelを変更できます。CLI defaultは普段のCodex設定を使います。"}</p>
            <label style={labelStyle} htmlFor="codex-web-search">Web search / ウェブ検索</label>
            <select id="codex-web-search" style={inputStyle} value={codexWebSearch} onChange={(e) => setCodexWebSearch(e.target.value)}>
              <option value="live">Live / 最新のウェブ（標準）</option>
              <option value="cached">Cached / キャッシュを検索</option>
              <option value="disabled">Off / 検索しない</option>
            </select>
            <p style={hintStyle}>検索を頼んだときや、PDFに情報が足りないときにウェブを参照できます。出典はリンクで表示します。検索語は検索サービスに送られます。</p>
            <p style={hintStyle}>Install Codex CLI and run <code>codex login</code> once. Komodo uses that login, so no chat API key is needed here. Answers arrive when the CLI finishes.</p>
            <p style={hintStyle}>Your question and document excerpts are sent through your configured Codex provider. Embeddings are configured separately below.</p>
            <p style={hintStyle}>Codex sessions are saved automatically. 質問・参照したPDFの抜粋・回答はCodexのセッション履歴に保存されます。</p>
          </> : <>
          <label style={labelStyle}>Base URL</label>
          <input
            style={inputStyle}
            value={localBaseUrl}
            onChange={(e) => setLocalBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
          />
          <label style={labelStyle}>API Key {chatKeySaved && <span style={{ color: "var(--accent)", fontSize: 11 }}>(saved)</span>}</label>
          <input
            style={inputStyle}
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={chatKeySaved ? "Leave blank to keep saved key" : "sk-..."}
          />
          <label style={labelStyle}>Model</label>
          <input
            style={inputStyle}
            value={localChatModel}
            onChange={(e) => setLocalChatModel(e.target.value)}
            placeholder="gpt-4o-mini"
          />
          </>}
        </div>

        <div style={sectionStyle}>
          <div style={sectionTitleStyle}>Embeddings</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <button
              onClick={() => setEmbedBackend("local")}
              style={{
                ...toggleBtnStyle,
                backgroundColor:
                  embedBackend === "local" ? "var(--accent-tint)" : "var(--surface)",
                color:
                  embedBackend === "local" ? "var(--accent-hover)" : "var(--text-muted)",
              }}
            >
              Local (recommended)
            </button>
            <button
              onClick={() => setEmbedBackend("remote")}
              style={{
                ...toggleBtnStyle,
                backgroundColor:
                  embedBackend === "remote" ? "var(--accent-tint)" : "var(--surface)",
                color:
                  embedBackend === "remote" ? "var(--accent-hover)" : "var(--text-muted)",
              }}
            >
              Remote
            </button>
          </div>

          {embedBackend === "local" ? (
            <>
              <label style={labelStyle}>Model</label>
              <select
                style={inputStyle}
                value={localEmbedModel}
                onChange={(e) => setLocalEmbedModel(e.target.value)}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                  </option>
                ))}
              </select>

              {selectedStatus && (
                <div style={{ marginTop: 8, fontSize: 13 }}>
                  {selectedStatus.downloaded ? (
                    <div style={{ color: "var(--accent)" }}>
                      Resources ready
                    </div>
                  ) : (
                    <div style={{ color: "#f59e0b" }}>
                      Not downloaded (~{totalMb} MB)
                      <button
                        onClick={handleDownload}
                        disabled={!!downloadingModel}
                        style={{
                          marginLeft: 8,
                          padding: "2px 8px",
                          borderRadius: 4,
                          backgroundColor: "var(--accent)",
                          color: "#fff",
                          border: "none",
                          fontSize: 12,
                          cursor: "pointer",
                        }}
                      >
                        {downloadingModel ? "Downloading..." : "Download"}
                      </button>
                    </div>
                  )}
                  <button
                    onClick={openModelsFolder}
                    style={{
                      ...textBtnStyle,
                      marginTop: 4,
                      display: "inline-block",
                    }}
                  >
                    Open models folder
                  </button>
                </div>
              )}

              <p style={hintStyle}>
                Runs locally on your device — free, private, offline.
              </p>
              <p style={hintStyle}>
                Changing the embedding model requires re-indexing your documents.
              </p>
            </>
          ) : (
            <>
              <label style={labelStyle}>Base URL</label>
              <input
                style={inputStyle}
                value={embedBaseUrl}
                onChange={(e) => setEmbedBaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
              />
              <label style={labelStyle}>API Key {embedKeySaved && <span style={{ color: "var(--accent)", fontSize: 11 }}>(saved)</span>}</label>
              <input
                style={inputStyle}
                type="password"
                value={embedApiKey}
                onChange={(e) => setEmbedApiKey(e.target.value)}
                placeholder={embedKeySaved ? "Leave blank to keep saved key" : "sk-..."}
              />
              <label style={labelStyle}>Model ID</label>
              <input
                style={inputStyle}
                value={embedModelRemote}
                onChange={(e) => setEmbedModelRemote(e.target.value)}
                placeholder="text-embedding-3-small"
              />
            </>
          )}
        </div>

        <button
          onClick={() => setShowAdvanced((v) => !v)}
          style={{ ...textBtnStyle, marginBottom: 8 }}
        >
          {showAdvanced ? "Hide advanced" : "Advanced"}
        </button>

        {showAdvanced && (
          <div style={sectionStyle}>
            <label style={labelStyle}>Top-K retrieval</label>
            <input
              style={inputStyle}
              type="number"
              value={topK}
              onChange={(e) => setTopK(Number(e.target.value))}
              min={1}
              max={20}
            />
            <label style={labelStyle}>Persona</label>
            <select
              style={inputStyle}
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
            >
              <option>Explain simply</option>
              <option>Cite sources strictly</option>
              <option>Summarize</option>
            </select>
            <label style={labelStyle}>Log level</label>
            <select
              style={inputStyle}
              value={logLevel}
              onChange={(e) => setLogLevel(e.target.value)}
            >
              <option value="error">error</option>
              <option value="warn">warn</option>
              <option value="info">info</option>
              <option value="debug">debug</option>
              <option value="trace">trace</option>
            </select>
          </div>
        )}

        {testResult && (
          <div style={{ marginBottom: 12, fontSize: 13 }}>
            <div
              style={{ color: testResult.chatOk ? "var(--accent)" : "#ef4444" }}
            >
              Chat {testResult.chatOk ? "✓" : "✗"}{" "}
              {testResult.chatErr ? `— ${testResult.chatErr}` : ""}
            </div>
            <div
              style={{ color: testResult.embedOk ? "var(--accent)" : "#ef4444" }}
            >
              Embeddings {testResult.embedOk ? "✓" : "✗"}{" "}
              {testResult.embedErr ? `— ${testResult.embedErr}` : ""}
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={() => setActiveModal("none")} style={secondaryBtnStyle}>
            Cancel
          </button>
          <button onClick={handleTest} disabled={testing} style={secondaryBtnStyle}>
            {testing ? "Testing..." : "Test connection"}
          </button>
          <button onClick={handleSave} style={primaryBtnStyle}>
            Save
          </button>
        </div>
      </div>

      {downloadingModel && downloadOpen && (
        <ModelDownloadModal
          progress={downloadProgress}
          onCancel={() => {
            // Can't truly cancel the Rust download without more plumbing;
            // at minimum close the modal so the user isn't stuck.
            setDownloadOpen(false);
          }}
        />
      )}
    </div>
  );
}

const modalOverlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  backgroundColor: "rgba(0,0,0,0.6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 100,
};

const modalContentStyle: React.CSSProperties = {
  backgroundColor: "var(--surface-raised)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: 24,
  width: 480,
  maxWidth: "90vw",
  maxHeight: "90vh",
  overflow: "auto",
};

const sectionStyle: React.CSSProperties = {
  marginBottom: 16,
  padding: 12,
  backgroundColor: "var(--surface)",
  borderRadius: 8,
  border: "1px solid var(--border)",
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 1,
  color: "var(--text-muted)",
  marginBottom: 8,
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  color: "var(--text-muted)",
  marginBottom: 4,
  marginTop: 8,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  backgroundColor: "var(--surface-raised)",
  color: "var(--text)",
  fontSize: 14,
  outline: "none",
};

const hintStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-muted)",
  marginTop: 6,
};

const toggleBtnStyle: React.CSSProperties = {
  flex: 1,
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  fontSize: 13,
  fontWeight: 500,
};

const textBtnStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-muted)",
  textDecoration: "underline",
  cursor: "pointer",
  background: "none",
  border: "none",
  padding: 0,
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 6,
  backgroundColor: "var(--surface)",
  border: "1px solid var(--border)",
  color: "var(--text)",
  fontSize: 13,
};

const primaryBtnStyle: React.CSSProperties = {
  padding: "8px 16px",
  borderRadius: 6,
  backgroundColor: "var(--accent)",
  color: "#fff",
  fontWeight: 600,
  fontSize: 13,
};
