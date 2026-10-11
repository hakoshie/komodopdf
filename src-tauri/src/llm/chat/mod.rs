pub mod chatgpt;
pub mod codex;
pub mod openai_compat;

pub fn provider_for_chat(
    settings: &crate::db::Settings,
    api_key: String,
    workspace: Option<std::path::PathBuf>,
    session_id: Option<String>,
) -> Result<Box<dyn crate::llm::LlmProvider>, crate::llm::LlmError> {
    if settings.chat_backend == "codex" {
        let provider = codex::CodexProvider::new(
            settings.codex_path.clone(),
            settings.codex_model.clone(),
            settings.codex_reasoning_effort.clone(),
            settings.codex_web_search.clone(),
        );
        return Ok(Box::new(if let Some(directory) = workspace {
            provider.in_workspace(directory, session_id)
        } else {
            provider
        }));
    }
    provider(settings, api_key)
}

pub fn provider(
    settings: &crate::db::Settings,
    api_key: String,
) -> Result<Box<dyn crate::llm::LlmProvider>, crate::llm::LlmError> {
    match settings.chat_backend.as_str() {
        "chatgpt" => Ok(Box::new(chatgpt::ChatGptProvider::new(
            settings.chatgpt_model.clone(),
            settings.chatgpt_reasoning_effort.clone(),
            settings.chatgpt_web_search,
        ))),
        "codex" => Ok(Box::new(codex::CodexProvider::new(
            settings.codex_path.clone(),
            settings.codex_model.clone(),
            settings.codex_reasoning_effort.clone(),
            settings.codex_web_search.clone(),
        ))),
        "openai" => Ok(Box::new(openai_compat::OpenAiCompatibleProvider::new(
            settings.chat_base_url.clone(),
            api_key,
            settings.chat_model.clone(),
        ))),
        other => Err(crate::llm::LlmError::Provider(format!(
            "Unknown chat backend: {other}"
        ))),
    }
}
