use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

pub struct Db {
    conn: Mutex<Connection>,
    history: Mutex<Connection>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SavedMessage {
    pub role: crate::llm::Role,
    pub content: String,
    #[serde(default)]
    pub sources: Vec<crate::llm::Source>,
    #[serde(default)]
    pub citations: Vec<usize>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    pub updated_at: i64,
    pub message_count: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct SavedConversation {
    pub id: String,
    pub messages: Vec<SavedMessage>,
    pub codex_session_id: Option<String>,
}

fn chat_timestamp() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "default_chat_backend")]
    pub chat_backend: String,
    #[serde(default = "default_codex_path")]
    pub codex_path: String,
    #[serde(default)]
    pub codex_model: String,
    #[serde(default)]
    pub codex_reasoning_effort: String,
    #[serde(default = "default_codex_web_search")]
    pub codex_web_search: String,
    pub chat_base_url: String,
    pub chat_model: String,
    pub embed_backend: String,
    pub embed_model: String,
    pub embed_base_url: Option<String>,
    pub embed_model_remote: Option<String>,
    pub top_k: i64,
    pub persona: String,
    #[serde(default = "default_response_language")]
    pub response_language: String,
    pub configured: bool,
    pub log_level: String,
}

fn default_chat_backend() -> String {
    "openai".to_string()
}
fn default_codex_path() -> String {
    "codex".to_string()
}
fn default_codex_web_search() -> String {
    "live".to_string()
}
fn default_response_language() -> String {
    "auto".to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            chat_backend: default_chat_backend(),
            codex_path: default_codex_path(),
            codex_model: String::new(),
            codex_reasoning_effort: String::new(),
            codex_web_search: default_codex_web_search(),
            chat_base_url: "https://api.openai.com/v1".to_string(),
            chat_model: "gpt-4o-mini".to_string(),
            embed_backend: "local".to_string(),
            embed_model: "nomic-embed-text-v1.5".to_string(),
            embed_base_url: None,
            embed_model_remote: None,
            top_k: 6,
            persona: "Explain simply".to_string(),
            response_language: default_response_language(),
            configured: false,
            log_level: "info".to_string(),
        }
    }
}

fn db_path(app_handle: &tauri::AppHandle) -> PathBuf {
    let mut path = crate::portable::data_dir(app_handle);
    path.push("komodo.sqlite");
    path
}

impl Db {
    pub fn new(app_handle: &tauri::AppHandle) -> anyhow::Result<Self> {
        let path = db_path(app_handle);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(&path)?;
        let history_dir = crate::portable::history_dir(app_handle)?;
        std::fs::create_dir_all(&history_dir)?;
        let history = Connection::open(history_dir.join("conversations.sqlite"))?;
        let db = Db {
            conn: Mutex::new(conn),
            history: Mutex::new(history),
        };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "CREATE TABLE IF NOT EXISTS documents (
                file_hash TEXT PRIMARY KEY,
                embed_id TEXT NOT NULL,
                indexed_at INTEGER NOT NULL,
                last_opened_at INTEGER NOT NULL
            )",
            [],
        )?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS chunks (
                id TEXT PRIMARY KEY,
                file_hash TEXT NOT NULL,
                page INTEGER NOT NULL,
                text TEXT NOT NULL,
                quads_json TEXT NOT NULL,
                vector BLOB NOT NULL
            )",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_chunks_file_hash ON chunks(file_hash)",
            [],
        )?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )",
            [],
        )?;
        drop(conn);
        let conn = self.history.lock().unwrap();
        conn.execute(
            "CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                file_hash TEXT NOT NULL,
                title TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                message_count INTEGER NOT NULL DEFAULT 0,
                messages_json TEXT NOT NULL DEFAULT '[]',
                codex_session_id TEXT
            )",
            [],
        )?;
        let has_session_id = conn
            .prepare("PRAGMA table_info(conversations)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?
            .iter()
            .any(|name| name == "codex_session_id");
        if !has_session_id {
            conn.execute(
                "ALTER TABLE conversations ADD COLUMN codex_session_id TEXT",
                [],
            )?;
        }
        conn.execute("CREATE INDEX IF NOT EXISTS idx_conversations_pdf ON conversations(file_hash, updated_at DESC)", [])?;
        Ok(())
    }

    pub fn create_conversation(&self, file_hash: &str, id: &str) -> anyhow::Result<()> {
        anyhow::ensure!(
            file_hash.len() == 64
                && file_hash.bytes().all(|b| b.is_ascii_hexdigit())
                && crate::portable::valid_conversation_id(id),
            "Invalid PDF or conversation ID"
        );
        self.history.lock().unwrap().execute(
            "INSERT INTO conversations(id, file_hash, title, updated_at) VALUES (?1, ?2, 'New chat', ?3)",
            params![id, file_hash, chat_timestamp()],
        )?;
        Ok(())
    }

    pub fn list_conversations(&self, file_hash: &str) -> anyhow::Result<Vec<ConversationSummary>> {
        let conn = self.history.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id, title, updated_at, message_count FROM conversations WHERE file_hash = ?1 ORDER BY updated_at DESC, rowid DESC")?;
        let rows = stmt.query_map(params![file_hash], |row| {
            Ok(ConversationSummary {
                id: row.get(0)?,
                title: row.get(1)?,
                updated_at: row.get(2)?,
                message_count: row.get(3)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn load_conversation(
        &self,
        file_hash: &str,
        id: &str,
    ) -> anyhow::Result<SavedConversation> {
        let conn = self.history.lock().unwrap();
        let (json, codex_session_id): (String, Option<String>) = conn.query_row(
            "SELECT messages_json, codex_session_id FROM conversations WHERE file_hash = ?1 AND id = ?2",
            params![file_hash, id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok(SavedConversation {
            id: id.to_owned(),
            messages: serde_json::from_str(&json)?,
            codex_session_id,
        })
    }

    pub fn append_chat_message(
        &self,
        file_hash: &str,
        id: &str,
        message: SavedMessage,
    ) -> anyhow::Result<()> {
        let conn = self.history.lock().unwrap();
        let json: String = conn.query_row(
            "SELECT messages_json FROM conversations WHERE file_hash = ?1 AND id = ?2",
            params![file_hash, id],
            |row| row.get(0),
        )?;
        let mut messages: Vec<SavedMessage> = serde_json::from_str(&json)?;
        messages.push(message);
        let title = messages
            .iter()
            .find(|m| matches!(m.role, crate::llm::Role::User))
            .map(|m| {
                m.content
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .chars()
                    .take(72)
                    .collect::<String>()
            })
            .unwrap_or_else(|| "New chat".into());
        conn.execute("UPDATE conversations SET messages_json = ?1, title = ?2, updated_at = MAX(?3, (SELECT COALESCE(MAX(updated_at), 0) + 1 FROM conversations)), message_count = ?4 WHERE file_hash = ?5 AND id = ?6",
            params![serde_json::to_string(&messages)?, title, chat_timestamp(), messages.len(), file_hash, id])?;
        Ok(())
    }

    pub fn save_codex_session(
        &self,
        file_hash: &str,
        id: &str,
        session_id: &str,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(
            crate::portable::valid_conversation_id(session_id),
            "Invalid Codex session ID"
        );
        let changed = self.history.lock().unwrap().execute(
            "UPDATE conversations SET codex_session_id = ?1 WHERE file_hash = ?2 AND id = ?3",
            params![session_id, file_hash, id],
        )?;
        anyhow::ensure!(changed == 1, "Conversation not found for this PDF");
        Ok(())
    }

    pub fn is_indexed(&self, file_hash: &str, embed_id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        let result: Result<Option<i64>, _> = conn
            .query_row(
                "SELECT 1 FROM documents WHERE file_hash = ?1 AND embed_id = ?2",
                params![file_hash, embed_id],
                |row| row.get(0),
            )
            .optional();
        result.ok().flatten().is_some()
    }

    pub fn mark_indexed(&self, file_hash: &str, embed_id: &str) -> anyhow::Result<()> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO documents (file_hash, embed_id, indexed_at, last_opened_at)
             VALUES (?1, ?2, ?3, ?3)",
            params![file_hash, embed_id, now],
        )?;
        Ok(())
    }

    pub fn touch_document(&self, file_hash: &str) -> anyhow::Result<()> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE documents SET last_opened_at = ?1 WHERE file_hash = ?2",
            params![now, file_hash],
        )?;
        Ok(())
    }

    pub fn get_settings(&self) -> anyhow::Result<Settings> {
        let conn = self.conn.lock().unwrap();
        let mut settings = Settings::default();

        let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;

        for row in rows {
            let (key, value) = row?;
            match key.as_str() {
                "chat_backend" => settings.chat_backend = value,
                "codex_path" => settings.codex_path = value,
                "codex_model" => settings.codex_model = value,
                "codex_reasoning_effort" => settings.codex_reasoning_effort = value,
                "codex_web_search" => settings.codex_web_search = value,
                "chat_base_url" => settings.chat_base_url = value,
                "chat_model" => settings.chat_model = value,
                "embed_backend" => settings.embed_backend = value,
                "embed_model" => settings.embed_model = value,
                "embed_base_url" => settings.embed_base_url = Some(value),
                "embed_model_remote" => settings.embed_model_remote = Some(value),
                "top_k" => settings.top_k = value.parse().unwrap_or(6),
                "persona" => settings.persona = value,
                "response_language" => settings.response_language = value,
                "configured" => settings.configured = value == "true",
                "log_level" => settings.log_level = value,
                _ => {}
            }
        }
        Ok(settings)
    }

    pub fn set_settings(&self, settings: &Settings) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        let top_k_str = settings.top_k.to_string();
        let configured_str = if settings.configured { "true" } else { "false" };
        let pairs = [
            ("chat_backend", settings.chat_backend.as_str()),
            ("codex_path", settings.codex_path.as_str()),
            ("codex_model", settings.codex_model.as_str()),
            ("codex_web_search", settings.codex_web_search.as_str()),
            (
                "codex_reasoning_effort",
                settings.codex_reasoning_effort.as_str(),
            ),
            ("chat_base_url", settings.chat_base_url.as_str()),
            ("chat_model", settings.chat_model.as_str()),
            ("embed_backend", settings.embed_backend.as_str()),
            ("embed_model", settings.embed_model.as_str()),
            ("top_k", top_k_str.as_str()),
            ("persona", settings.persona.as_str()),
            ("response_language", settings.response_language.as_str()),
            ("configured", configured_str),
            ("log_level", settings.log_level.as_str()),
        ];
        for (k, v) in &pairs {
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
                params![k, v],
            )?;
        }
        if let Some(v) = &settings.embed_base_url {
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
                params!["embed_base_url", v],
            )?;
        }
        if let Some(v) = &settings.embed_model_remote {
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
                params!["embed_model_remote", v],
            )?;
        }
        Ok(())
    }

    pub fn store_chunks(&self, file_hash: &str, chunks: &[ChunkRow]) -> anyhow::Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM chunks WHERE file_hash = ?1",
            params![file_hash],
        )?;
        tx.execute(
            "DELETE FROM documents WHERE file_hash = ?1",
            params![file_hash],
        )?;
        for c in chunks {
            tx.execute(
                "INSERT OR REPLACE INTO chunks (id, file_hash, page, text, quads_json, vector)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    c.id,
                    file_hash,
                    c.page,
                    c.text,
                    c.quads_json,
                    &c.vector as &[u8],
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn load_chunks(&self, file_hash: &str) -> anyhow::Result<Vec<ChunkRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, file_hash, page, text, quads_json, vector FROM chunks WHERE file_hash = ?1",
        )?;
        let rows = stmt.query_map(params![file_hash], |row| {
            Ok(ChunkRow {
                id: row.get(0)?,
                file_hash: row.get(1)?,
                page: row.get(2)?,
                text: row.get(3)?,
                quads_json: row.get(4)?,
                vector: row.get(5)?,
            })
        })?;
        let mut chunks = Vec::new();
        for row in rows {
            chunks.push(row?);
        }
        Ok(chunks)
    }

    pub fn delete_document(&self, file_hash: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM chunks WHERE file_hash = ?1",
            params![file_hash],
        )?;
        conn.execute(
            "DELETE FROM documents WHERE file_hash = ?1",
            params![file_hash],
        )?;
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct ChunkRow {
    pub id: String,
    pub file_hash: String,
    pub page: u32,
    pub text: String,
    pub quads_json: String,
    pub vector: Vec<u8>,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Db {
        let db = Db {
            conn: Mutex::new(Connection::open_in_memory().unwrap()),
            history: Mutex::new(Connection::open_in_memory().unwrap()),
        };
        db.migrate().unwrap();
        db
    }

    #[test]
    fn old_settings_load_with_api_backend_and_codex_settings_persist() {
        let mut legacy = serde_json::to_value(Settings::default()).unwrap();
        for key in [
            "chatBackend",
            "codexPath",
            "codexModel",
            "codexReasoningEffort",
            "codexWebSearch",
            "responseLanguage",
        ] {
            legacy.as_object_mut().unwrap().remove(key);
        }
        let mut settings: Settings = serde_json::from_value(legacy).unwrap();
        assert_eq!(settings.chat_backend, "openai");
        assert_eq!(settings.response_language, "auto");
        assert_eq!(settings.codex_reasoning_effort, "");
        assert_eq!(settings.codex_web_search, "live");
        settings.chat_backend = "codex".into();
        settings.codex_path = "C:/CLI with spaces/codex.exe".into();
        settings.codex_model = "custom-model".into();
        settings.codex_reasoning_effort = "high".into();
        settings.codex_web_search = "cached".into();
        settings.response_language = "ja".into();
        let db = db();
        db.set_settings(&settings).unwrap();
        let loaded = db.get_settings().unwrap();
        assert_eq!(loaded.chat_backend, "codex");
        assert_eq!(loaded.codex_path, settings.codex_path);
        assert_eq!(loaded.codex_model, settings.codex_model);
        assert_eq!(loaded.codex_reasoning_effort, "high");
        assert_eq!(loaded.codex_web_search, "cached");
        assert_eq!(loaded.response_language, "ja");
    }

    #[test]
    fn conversations_survive_reopening_and_stay_scoped_to_the_pdf() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("history.sqlite");
        let open = || {
            let db = Db {
                conn: Mutex::new(Connection::open_in_memory().unwrap()),
                history: Mutex::new(Connection::open(&path).unwrap()),
            };
            db.migrate().unwrap();
            db
        };
        let pdf = "a".repeat(64);
        let other_pdf = "b".repeat(64);
        let first = "11111111-1111-4111-8111-111111111111";
        let second = "22222222-2222-4222-8222-222222222222";
        let other = "33333333-3333-4333-8333-333333333333";
        let user = |content: &str| SavedMessage {
            role: crate::llm::Role::User,
            content: content.into(),
            sources: vec![],
            citations: vec![],
        };
        {
            let db = open();
            db.create_conversation(&pdf, first).unwrap();
            db.create_conversation(&pdf, second).unwrap();
            db.create_conversation(&other_pdf, other).unwrap();
            db.append_chat_message(&pdf, first, user("日本語の質問\n数式について"))
                .unwrap();
            db.append_chat_message(
                &pdf,
                first,
                SavedMessage {
                    role: crate::llm::Role::Assistant,
                    content: "Formula \\(x^2\\) [1]. [Web](https://example.com)".into(),
                    sources: vec![crate::llm::Source {
                        idx: 1,
                        chunk_id: "chunk".into(),
                        page: 2,
                        snippet: "Reference".into(),
                        quads: vec![crate::llm::Quad {
                            x0: 10.,
                            y0: 20.,
                            x1: 30.,
                            y1: 40.,
                        }],
                    }],
                    citations: vec![1],
                },
            )
            .unwrap();
            db.save_codex_session(&pdf, first, other).unwrap();
            db.append_chat_message(&pdf, second, user("Separate conversation"))
                .unwrap();
            db.append_chat_message(&pdf, first, user("続き")).unwrap();
            assert!(db.load_conversation(&other_pdf, first).is_err());
            assert!(db
                .append_chat_message(&other_pdf, first, user("Wrong PDF"))
                .is_err());
            assert!(db.save_codex_session(&other_pdf, first, other).is_err());
            assert!(db.save_codex_session(&pdf, first, "../../escape").is_err());
            db.delete_document(&pdf).unwrap(); // Reindexing must not erase conversations.
        }
        let db = open();
        let list = db.list_conversations(&pdf).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, first);
        assert_eq!(list[0].title, "日本語の質問 数式について");
        assert_eq!(list[0].message_count, 3);
        assert_eq!(db.list_conversations(&other_pdf).unwrap().len(), 1);
        let saved = db.load_conversation(&pdf, first).unwrap();
        assert_eq!(saved.codex_session_id.as_deref(), Some(other));
        assert_eq!(saved.messages[1].sources[0].page, 2);
        assert_eq!(saved.messages[1].sources[0].quads[0].y0, 20.);
        assert_eq!(saved.messages[1].citations, [1]);
        assert!(saved.messages[1].content.contains("https://example.com"));
    }

    #[test]
    fn rebuilding_replaces_stale_chunks_and_invalidates_old_index() {
        let db = db();
        let chunk = |id: &str| ChunkRow {
            id: id.into(),
            file_hash: "pdf".into(),
            page: 1,
            text: id.into(),
            quads_json: "[]".into(),
            vector: vec![0; 4],
        };
        db.store_chunks("pdf", &[chunk("old")]).unwrap();
        db.mark_indexed("pdf", "old-model").unwrap();
        db.store_chunks("pdf", &[chunk("new")]).unwrap();
        assert!(!db.is_indexed("pdf", "old-model"));
        let chunks = db.load_chunks("pdf").unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].id, "new");
    }
}
