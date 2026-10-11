use crate::{
    chatgpt_auth,
    llm::{ChatRequest, LlmError, LlmProvider, Role},
};
use futures_util::{stream::BoxStream, StreamExt};
use serde_json::{json, Value};
use std::collections::{HashSet, VecDeque};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub display_name: String,
    pub supported_reasoning_efforts: Vec<String>,
}

pub async fn models() -> Result<Vec<ModelOption>, String> {
    let token = chatgpt_auth::access_token().await?;
    let response = reqwest::Client::new()
        .get("https://api.openai.com/v1/models")
        .bearer_auth(token)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| "Cannot load ChatGPT models")?;
    if !response.status().is_success() {
        return Err(format!(
            "Cannot load ChatGPT models (HTTP {}). Check your connection and sign-in.",
            response.status()
        ));
    }
    let value: Value = response
        .json()
        .await
        .map_err(|_| "Invalid ChatGPT model list")?;
    let list = value["models"]
        .as_array()
        .ok_or("ChatGPT did not return a model catalog")?;
    let options: Vec<_> = list
        .iter()
        .filter(|m| m["visibility"] == "list")
        .filter_map(|m| {
            Some(ModelOption {
                id: m["slug"].as_str()?.into(),
                display_name: m["display_name"]
                    .as_str()
                    .unwrap_or(m["slug"].as_str()?)
                    .into(),
                supported_reasoning_efforts: m["supported_reasoning_levels"]
                    .as_array()
                    .map(|levels| {
                        levels
                            .iter()
                            .filter_map(|l| l["effort"].as_str())
                            .filter(|s| crate::llm::chat::codex::valid_reasoning_effort(s))
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default(),
            })
        })
        .collect();
    if options.is_empty() {
        return Err("No ChatGPT models are available for this account".into());
    }
    Ok(options)
}

pub struct ChatGptProvider {
    model: String,
    effort: String,
    web_search: bool,
}
impl ChatGptProvider {
    pub fn new(model: String, effort: String, web_search: bool) -> Self {
        Self {
            model,
            effort,
            web_search,
        }
    }
    fn body(&self, req: ChatRequest) -> Value {
        let mut instructions = req.system_prompt;
        let mut input = Vec::new();
        for m in req.messages {
            match m.role {
                Role::System => {
                    instructions.push('\n');
                    instructions.push_str(&m.content);
                }
                Role::User => input.push(json!({"role":"user", "content":m.content})),
                Role::Assistant => input.push(json!({"role":"assistant", "content":m.content})),
            }
        }
        let mut body = json!({"model":self.model, "instructions":instructions, "input":input, "store":false, "stream":true});
        if !self.effort.is_empty() {
            body["reasoning"] = json!({"effort":self.effort});
        }
        if self.web_search {
            body["tools"] = json!([{"type":"web_search"}]);
        }
        body
    }
}

fn response_error(event: &Value) -> LlmError {
    let code = event["response"]["error"]["code"]
        .as_str()
        .or(event["error"]["code"].as_str())
        .or(event["code"].as_str())
        .unwrap_or("");
    let message = match code {
        "subscription_sharing_usage_limit_exceeded" | "subscription_sharing_usage_unavailable" => "ChatGPT plan usage is unavailable or its limit was reached. Open Manage usage in Settings.",
        _ => "ChatGPT could not complete this answer. Check your sign-in, selected model and plan usage in Settings.",
    };
    LlmError::Provider(message.into())
}

#[async_trait::async_trait]
impl LlmProvider for ChatGptProvider {
    fn id(&self) -> &'static str {
        "chatgpt-plan"
    }
    async fn chat_stream(
        &self,
        req: ChatRequest,
    ) -> Result<BoxStream<'static, Result<String, LlmError>>, LlmError> {
        if self.model.is_empty() {
            return Err(LlmError::Provider(
                "Select a ChatGPT model in Settings first".into(),
            ));
        }
        let token = chatgpt_auth::access_token()
            .await
            .map_err(LlmError::Provider)?;
        let response = reqwest::Client::new()
            .post("https://api.openai.com/v1/responses")
            .bearer_auth(token)
            .json(&self.body(req))
            .timeout(std::time::Duration::from_secs(300))
            .send()
            .await
            .map_err(|_| LlmError::Network("Cannot reach ChatGPT".into()))?;
        if !response.status().is_success() {
            return Err(match response.status().as_u16() {
                401 | 403 => LlmError::Provider(
                    "ChatGPT access was rejected. Sign in again in Settings and allow plan usage."
                        .into(),
                ),
                429 => LlmError::Provider(
                    "ChatGPT usage limit reached. Open Manage usage in Settings.".into(),
                ),
                _ => response_error(&response.json::<Value>().await.unwrap_or_default()),
            });
        }
        let bytes = response.bytes_stream().map(|chunk| {
            chunk
                .map(|b| b.to_vec())
                .map_err(|_| LlmError::Network("ChatGPT response was interrupted".into()))
        });
        Ok(decode_stream(Box::pin(bytes)))
    }
}

fn decode_stream(
    bytes: BoxStream<'static, Result<Vec<u8>, LlmError>>,
) -> BoxStream<'static, Result<String, LlmError>> {
    let stream = futures_util::stream::unfold(
        (
            bytes,
            Vec::<u8>::new(),
            VecDeque::<Result<String, LlmError>>::new(),
            false,
            false,
            HashSet::<String>::new(),
        ),
        |(mut bytes, mut buffer, mut pending, mut completed, mut ended, mut links)| async move {
            loop {
                if let Some(item) = pending.pop_front() {
                    return Some((item, (bytes, buffer, pending, completed, ended, links)));
                }
                if ended {
                    return None;
                }
                if let Some(pos) = buffer.iter().position(|b| *b == b'\n') {
                    let line: Vec<_> = buffer.drain(..=pos).collect();
                    let line = String::from_utf8_lossy(&line);
                    let Some(data) = line.trim().strip_prefix("data:") else {
                        continue;
                    };
                    if data.trim().is_empty() || data.trim() == "[DONE]" {
                        continue;
                    }
                    let event: Value = match serde_json::from_str(data.trim()) {
                        Ok(value) => value,
                        Err(_) => {
                            ended = true;
                            pending.push_back(Err(LlmError::Provider(
                                "Invalid ChatGPT response stream".into(),
                            )));
                            continue;
                        }
                    };
                    match event["type"].as_str().unwrap_or("") {
                        "response.output_text.delta" => {
                            if let Some(text) = event["delta"].as_str() {
                                pending.push_back(Ok(text.into()));
                            }
                        }
                        "response.completed" => {
                            completed = true;
                            ended = true;
                        }
                        "response.failed" | "response.incomplete" | "error" => {
                            ended = true;
                            pending.push_back(Err(response_error(&event)));
                        }
                        "response.output_item.done" => {
                            if let Some(contents) = event["item"]["content"].as_array() {
                                for content in contents {
                                    if let Some(annotations) = content["annotations"].as_array() {
                                        for a in annotations {
                                            if a["type"] == "url_citation" {
                                                if let Some(url) = a["url"].as_str() {
                                                    if reqwest::Url::parse(url).is_ok_and(|u| {
                                                        matches!(u.scheme(), "https" | "http")
                                                    }) && links.insert(url.into())
                                                    {
                                                        // Use only supplied source URLs; escape Markdown delimiters.
                                                        pending.push_back(Ok(format!(
                                                            "\n\n[Web source]({})",
                                                            url.replace('(', "%28")
                                                                .replace(')', "%29")
                                                        )));
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                    continue;
                }
                match bytes.next().await {
                    Some(Ok(chunk)) => {
                        buffer.extend_from_slice(&chunk);
                        if buffer.len() > 2_000_000 {
                            ended = true;
                            pending.push_back(Err(LlmError::Provider(
                                "ChatGPT response event is too large".into(),
                            )));
                        }
                    }
                    Some(Err(_)) => {
                        ended = true;
                        pending.push_back(Err(LlmError::Network(
                            "ChatGPT response was interrupted".into(),
                        )));
                    }
                    None => {
                        ended = true;
                        if !completed {
                            pending.push_back(Err(LlmError::Provider(
                                "ChatGPT response ended before completion. Try again.".into(),
                            )));
                        }
                    }
                }
            }
        },
    );
    Box::pin(stream)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn plan_request_uses_responses_contract() {
        let provider = ChatGptProvider::new("account-model".into(), "high".into(), true);
        let body = provider.body(ChatRequest {
            model: "unused".into(),
            system_prompt: "PDF context".into(),
            temperature: Some(0.2),
            messages: vec![crate::llm::ChatMessage {
                role: Role::User,
                content: "question".into(),
            }],
        });
        assert_eq!(body["store"], false);
        assert_eq!(body["stream"], true);
        assert_eq!(body["instructions"], "PDF context");
        assert!(body.get("temperature").is_none());
        assert!(body.get("previous_response_id").is_none());
        assert_eq!(body["input"][0]["role"], "user");
        assert_eq!(body["reasoning"]["effort"], "high");
    }
}

#[cfg(test)]
mod stream_tests {
    use super::*;
    async fn run(data: &str) -> Vec<Result<String, LlmError>> {
        // Split every byte, including inside Unicode characters and SSE lines.
        let chunks: Vec<_> = data.as_bytes().iter().map(|b| Ok(vec![*b])).collect();
        decode_stream(Box::pin(futures_util::stream::iter(chunks)))
            .collect()
            .await
    }
    #[tokio::test]
    async fn fragmented_unicode_completes() {
        let out = run("data: {\"type\":\"response.output_text.delta\",\"delta\":\"日本語\"}\n\ndata: {\"type\":\"response.completed\"}\n\n").await;
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].as_ref().unwrap(), "日本語");
    }
    #[tokio::test]
    async fn partial_text_does_not_hide_failure_or_disconnect() {
        let prefix = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n";
        for ending in [
            "",
            "data: {\"type\":\"response.failed\"}\n\n",
            "data: {\"type\":\"response.incomplete\"}\n\n",
        ] {
            let out = run(&format!("{prefix}{ending}")).await;
            assert_eq!(out.len(), 2);
            assert!(out[0].is_ok());
            assert!(out[1].is_err());
        }
    }
}
