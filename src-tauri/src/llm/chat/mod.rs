pub mod codex;
pub mod openai_compat;

pub fn provider(
    settings: &crate::db::Settings,
    api_key: String,
) -> Result<Box<dyn crate::llm::LlmProvider>, crate::llm::LlmError> {
    match settings.chat_backend.as_str() {
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
