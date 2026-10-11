//! Direct Sign in with ChatGPT for local OSS clients. Tokens never cross Tauri IPC.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use jsonwebtoken::{decode, decode_header, jwk::JwkSet, Algorithm, DecodingKey, Validation};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    io::Write,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri_plugin_opener::OpenerExt;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

const ISSUER: &str = "https://auth.openai.com";
const RESOURCE: &str = "https://api.openai.com/v1";
const SCOPE: &str = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
static AUTH: OnceLock<Auth> = OnceLock::new();

pub struct Auth {
    path: PathBuf,
    gate: tokio::sync::Mutex<()>,
    task: tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    progress: Mutex<Progress>,
}

#[derive(Default)]
struct Progress {
    pending: bool,
    error: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct Store {
    host_id: String,
    active: Option<String>,
    accounts: Vec<Account>,
    #[serde(default)]
    welcomed: bool,
}

#[derive(Clone, Serialize, Deserialize)]
struct Account {
    client_id: String,
    subject: String,
    email: String,
    tokens: Option<Tokens>,
    expires_at: u64,
}

#[derive(Clone, Serialize, Deserialize)]
struct Tokens {
    access_token: String,
    #[serde(default)]
    refresh_token: String,
    #[serde(default)]
    id_token: String,
    #[serde(default)]
    scope: String,
    expires_in: u64,
    token_type: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    id: String,
    label: String,
    connected: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    accounts: Vec<AccountInfo>,
    active_account: Option<String>,
    connected: bool,
    pending: bool,
    error: Option<String>,
    show_welcome: bool,
}

#[derive(Deserialize)]
struct Discovery {
    issuer: String,
    jwks_uri: String,
    revocation_endpoint: Option<String>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn random() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "Cannot generate secure login state")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("HTTP client")
}
fn auth_endpoint(path: &str) -> String {
    format!("{ISSUER}{path}")
}
fn trusted_endpoint(url: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(url).map_err(|_| "Invalid OpenAI authentication endpoint")?;
    if url.scheme() != "https"
        || url.host_str() != Some("auth.openai.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
    {
        return Err("Untrusted OpenAI authentication endpoint".into());
    }
    Ok(())
}
async fn discovery() -> Result<Discovery, String> {
    let response = client()
        .get(auth_endpoint("/.well-known/openid-configuration"))
        .send()
        .await
        .map_err(|_| "Cannot reach OpenAI sign-in. Check your connection.")?;
    let doc: Discovery = response
        .error_for_status()
        .map_err(|_| "OpenAI sign-in discovery failed")?
        .json()
        .await
        .map_err(|_| "Invalid OpenAI sign-in discovery")?;
    if doc.issuer != ISSUER {
        return Err("Unexpected OpenAI issuer".into());
    }
    trusted_endpoint(&doc.jwks_uri)?;
    Ok(doc)
}

pub fn init(path: PathBuf) {
    let _ = AUTH.set(Auth {
        path,
        gate: tokio::sync::Mutex::new(()),
        task: tokio::sync::Mutex::new(None),
        progress: Mutex::new(Progress::default()),
    });
}
fn auth() -> Result<&'static Auth, String> {
    AUTH.get()
        .ok_or_else(|| "ChatGPT sign-in is not initialized".into())
}

// Windows DPAPI binds credentials to the current OS user. Unix files are owner-only.
#[cfg(windows)]
fn protect(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::{Foundation::LocalFree, Security::Cryptography::*};
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes
            .len()
            .try_into()
            .map_err(|_| "Credential record too large")?,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    unsafe {
        let ok = if encrypt {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err("Cannot protect or unlock ChatGPT credentials for this OS user".into());
        }
        let result = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as *mut _);
        Ok(result)
    }
}
#[cfg(not(windows))]
fn protect(bytes: &[u8], _encrypt: bool) -> Result<Vec<u8>, String> {
    Ok(bytes.to_vec())
}

impl Auth {
    async fn storage_lock(&self) -> Result<std::fs::File, String> {
        let path = self.path.with_extension("lock");
        tokio::task::spawn_blocking(move || {
            std::fs::create_dir_all(path.parent().ok_or("Invalid account storage path")?)
                .map_err(|_| "Cannot create account storage")?;
            let file = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(path)
                .map_err(|_| "Cannot lock account storage")?;
            fs2::FileExt::lock_exclusive(&file).map_err(|_| "Cannot lock account storage")?;
            Ok(file)
        })
        .await
        .map_err(|_| "Cannot lock account storage")?
    }
    fn load(&self) -> Result<Store, String> {
        match std::fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&protect(&bytes, false)?)
                .map_err(|_| "Cannot read ChatGPT account storage".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Store::default()),
            Err(_) => Err("Cannot read ChatGPT account storage".into()),
        }
    }
    fn save(&self, store: &Store) -> Result<(), String> {
        let parent = self.path.parent().ok_or("Invalid account storage path")?;
        std::fs::create_dir_all(parent).map_err(|_| "Cannot create account storage")?;
        let bytes = protect(
            &serde_json::to_vec(store).map_err(|_| "Cannot serialize account storage")?,
            true,
        )?;
        let mut file = tempfile::NamedTempFile::new_in(parent)
            .map_err(|_| "Cannot save ChatGPT credentials")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.as_file()
                .set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|_| "Cannot secure account storage")?;
        }
        file.write_all(&bytes)
            .and_then(|_| file.as_file().sync_all())
            .map_err(|_| "Cannot save ChatGPT credentials")?;
        file.persist(&self.path)
            .map_err(|_| "Cannot replace ChatGPT account storage")?;
        Ok(())
    }
}

pub async fn status() -> Result<Status, String> {
    let auth = auth()?;
    let _guard = auth.gate.lock().await;
    let _file_lock = auth.storage_lock().await?;
    let store = auth.load()?;
    let progress = auth.progress.lock().unwrap();
    let accounts: Vec<_> = store
        .accounts
        .iter()
        .map(|a| AccountInfo {
            id: a.client_id.clone(),
            label: format!("{} · {}", a.email, a.client_id),
            connected: a.tokens.is_some(),
        })
        .collect();
    let connected = store
        .accounts
        .iter()
        .any(|a| Some(&a.client_id) == store.active.as_ref() && a.tokens.is_some());
    Ok(Status {
        accounts,
        active_account: store.active,
        connected,
        pending: progress.pending,
        error: progress.error.clone(),
        show_welcome: connected && !store.welcomed,
    })
}

pub async fn welcome_seen() -> Result<(), String> {
    let auth = auth()?;
    let _guard = auth.gate.lock().await;
    let _file_lock = auth.storage_lock().await?;
    let mut store = auth.load()?;
    store.welcomed = true;
    auth.save(&store)
}

fn authorize_url(
    host: &str,
    account: Option<&Account>,
    redirect: &str,
    state: &str,
    nonce: &str,
    verifier: &str,
) -> String {
    let mut url = reqwest::Url::parse(&auth_endpoint("/api/accounts/authorize")).unwrap();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    {
        let mut q = url.query_pairs_mut();
        q.append_pair(
            "client_id",
            account
                .map(|a| a.client_id.as_str())
                .unwrap_or("dynamic_agent_client"),
        )
        .append_pair("ext_agent_host_id", host)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", redirect)
        .append_pair("scope", SCOPE)
        .append_pair("resource", RESOURCE)
        .append_pair("state", state)
        .append_pair("nonce", nonce)
        .append_pair("code_challenge_method", "S256")
        .append_pair("code_challenge", &challenge);
        if let Some(a) = account {
            if let Some(t) = &a.tokens {
                q.append_pair("id_token_hint", &t.id_token);
            }
            q.append_pair("login_hint", &a.email);
        } else {
            q.append_pair("agent_name_hint", "Komodo PDF");
        }
    }
    url.into()
}

fn callback(
    url: &reqwest::Url,
    expected_state: &str,
    account: Option<&Account>,
) -> Result<(String, String), String> {
    let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    if url.path() != "/auth/callback" || q.get("state").map(String::as_str) != Some(expected_state)
    {
        return Err("Sign-in callback did not match this attempt".into());
    }
    if q.contains_key("error") {
        return Err("ChatGPT sign-in was declined. You can try again.".into());
    }
    let id = match (account, q.get("client_id")) {
        (Some(a), Some(id)) if id != &a.client_id => {
            return Err("Sign-in changed the registered account".into())
        }
        (Some(a), _) => a.client_id.clone(),
        (None, Some(id)) if !id.is_empty() && id != "dynamic_agent_client" => id.clone(),
        _ => return Err("ChatGPT did not return a registered client ID".into()),
    };
    let code = q
        .get("code")
        .filter(|c| !c.is_empty())
        .ok_or("ChatGPT did not return a sign-in code")?;
    Ok((code.clone(), id))
}

async fn exchange(params: &[(&str, &str)], prior_scope: Option<&str>) -> Result<Tokens, String> {
    let response = client()
        .post(auth_endpoint("/api/accounts/oauth/token"))
        .form(params)
        .send()
        .await
        .map_err(|_| "Cannot reach OpenAI to complete sign-in")?;
    if !response.status().is_success() {
        return Err("ChatGPT authorization expired or was rejected. Sign in again.".into());
    }
    let mut t: Tokens = response
        .json()
        .await
        .map_err(|_| "Invalid ChatGPT token response")?;
    if t.scope.is_empty() {
        t.scope = prior_scope.unwrap_or("").into();
    }
    if t.token_type.to_lowercase() != "bearer" || t.access_token.is_empty() || t.expires_in == 0 {
        return Err("Invalid ChatGPT credentials".into());
    }
    if !t
        .scope
        .split_whitespace()
        .any(|s| s == "chatgpt.tokens.use.direct")
        || !t.scope.split_whitespace().any(|s| s == "resource.invoke")
    {
        return Err("ChatGPT plan use was not enabled. Sign in again and allow plan usage.".into());
    }
    Ok(t)
}

fn validate_claims(
    claims: &Value,
    nonce: Option<&str>,
    account: Option<&Account>,
) -> Result<(), String> {
    if nonce.is_some_and(|n| claims["nonce"].as_str() != Some(n))
        || claims["sub"].as_str().unwrap_or("").is_empty()
        || claims["iat"].as_u64().map_or(true, |iat| iat > now() + 5)
    {
        return Err("ChatGPT identity did not match the sign-in attempt".into());
    }
    if let Some(a) = account {
        if claims["sub"].as_str() != Some(&a.subject) {
            return Err("ChatGPT signed in a different account".into());
        }
    }
    Ok(())
}

async fn verify_identity(
    token: &str,
    id: &str,
    nonce: Option<&str>,
    account: Option<&Account>,
) -> Result<Value, String> {
    let doc = discovery().await?;
    let jwks: JwkSet = client()
        .get(&doc.jwks_uri)
        .send()
        .await
        .map_err(|_| "Cannot verify ChatGPT identity")?
        .error_for_status()
        .map_err(|_| "Cannot fetch ChatGPT signing keys")?
        .json()
        .await
        .map_err(|_| "Invalid ChatGPT signing keys")?;
    verify_with_keys(token, id, nonce, account, &jwks)
}
fn verify_with_keys(
    token: &str,
    id: &str,
    nonce: Option<&str>,
    account: Option<&Account>,
    jwks: &JwkSet,
) -> Result<Value, String> {
    let header = decode_header(token).map_err(|_| "Invalid ChatGPT identity token")?;
    if !matches!(
        header.alg,
        Algorithm::RS256 | Algorithm::ES256 | Algorithm::EdDSA
    ) {
        return Err("Unsupported identity signature".into());
    }
    let jwk = jwks
        .find(
            header
                .kid
                .as_deref()
                .ok_or("Missing identity signing key")?,
        )
        .ok_or("Unknown ChatGPT signing key")?;
    let key = DecodingKey::from_jwk(jwk).map_err(|_| "Invalid ChatGPT signing key")?;
    let mut validation = Validation::new(header.alg);
    validation.set_issuer(&[ISSUER]);
    validation.set_audience(&[id]);
    validation.leeway = 5;
    validation.set_required_spec_claims(&["sub", "exp", "iat", "iss", "aud"]);
    let claims = decode::<Value>(token, &key, &validation)
        .map_err(|_| "ChatGPT identity signature or claims are invalid")?
        .claims;
    validate_claims(&claims, nonce, account)?;
    Ok(claims)
}

pub async fn start(app: tauri::AppHandle, account_id: Option<String>) -> Result<(), String> {
    let auth = auth()?;
    let mut task = auth.task.lock().await;
    if task.as_ref().is_some_and(|t| !t.is_finished()) {
        return Err("A ChatGPT sign-in is already in progress".into());
    }
    let account;
    let host;
    {
        let _guard = auth.gate.lock().await;
        let _file_lock = auth.storage_lock().await?;
        let mut store = auth.load()?;
        if store.host_id.is_empty() {
            let mut bytes = [0u8; 16];
            SystemRandom::new()
                .fill(&mut bytes)
                .map_err(|_| "Cannot generate host ID")?;
            bytes[6] = (bytes[6] & 0x0f) | 0x40;
            bytes[8] = (bytes[8] & 0x3f) | 0x80;
            let h = hex::encode(bytes);
            store.host_id = format!(
                "urn:uuid:{}-{}-{}-{}-{}",
                &h[..8],
                &h[8..12],
                &h[12..16],
                &h[16..20],
                &h[20..]
            );
            auth.save(&store)?;
        }
        account = if let Some(id) = account_id {
            Some(
                store
                    .accounts
                    .into_iter()
                    .find(|a| a.client_id == id)
                    .ok_or("Unknown saved ChatGPT account")?,
            )
        } else {
            None
        };
        host = store.host_id;
    }
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| "Cannot start the local sign-in callback")?;
    let redirect = format!(
        "http://127.0.0.1:{}/auth/callback",
        listener
            .local_addr()
            .map_err(|_| "Cannot read callback port")?
            .port()
    );
    let state = random()?;
    let nonce = random()?;
    let verifier = random()?;
    let url = authorize_url(
        &host,
        account.as_ref(),
        &redirect,
        &state,
        &nonce,
        &verifier,
    );
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| "Cannot open the sign-in browser")?;
    *auth.progress.lock().unwrap() = Progress {
        pending: true,
        error: None,
    };
    *task = Some(tokio::spawn(async move {
        let result = tokio::time::timeout(Duration::from_secs(600), async {
            loop {
                let (mut socket, _) = listener.accept().await.map_err(|_| "Sign-in callback failed")?;
                let mut request = Vec::new();
                let read = tokio::time::timeout(Duration::from_secs(5), async {
                    let mut buf = [0u8; 1024];
                    while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                        let n = socket.read(&mut buf).await?; if n == 0 || request.len() + n > 16384 { break; }
                        request.extend_from_slice(&buf[..n]);
                    }
                    Ok::<_, std::io::Error>(())
                }).await;
                if !matches!(read, Ok(Ok(()))) { continue; }
                let line = std::str::from_utf8(&request).unwrap_or("").lines().next().unwrap_or("");
                let mut parts = line.split_whitespace();
                if parts.next() != Some("GET") { continue; }
                let target = parts.next().unwrap_or("");
                if !target.starts_with("/auth/callback?") { continue; }
                let url = reqwest::Url::parse(&format!("http://127.0.0.1{target}")).map_err(|_| "Invalid sign-in callback")?;
                if !url.query_pairs().any(|(k, v)| k == "state" && v == state) {
                    let _ = socket.write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n").await;
                    continue;
                }
                let callback_result = callback(&url, &state, account.as_ref());
                let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n<!doctype html><title>Komodo PDF</title><p>Return to Komodo PDF to check your sign-in result. You can close this tab.</p>").await;
                let (code, id) = callback_result?;
                let tokens = exchange(&[("grant_type", "authorization_code"), ("client_id", &id), ("code", &code), ("code_verifier", &verifier), ("redirect_uri", &redirect), ("resource", RESOURCE)], None).await?;
                let claims = verify_identity(&tokens.id_token, &id, Some(&nonce), account.as_ref()).await?;
                let new = Account { client_id: id.clone(), subject: claims["sub"].as_str().unwrap().into(), email: claims["email"].as_str().unwrap_or("ChatGPT account").into(), expires_at: now() + tokens.expires_in, tokens: Some(tokens) };
                let _guard = auth.gate.lock().await; let _file_lock = auth.storage_lock().await?;
                let mut store = auth.load()?;
                if let Some(old) = store.accounts.iter_mut().find(|a| a.client_id == id) { *old = new; } else { store.accounts.push(new); }
                store.active = Some(id); auth.save(&store)?;
                return Ok::<(), String>(());
            }
        }).await.unwrap_or_else(|_| Err("ChatGPT sign-in timed out. Try again.".into()));
        *auth.progress.lock().unwrap() = Progress {
            pending: false,
            error: result.err(),
        };
    }));
    Ok(())
}

pub async fn cancel() -> Result<(), String> {
    let auth = auth()?;
    if let Some(task) = auth.task.lock().await.take() {
        task.abort();
        let _ = task.await;
    }
    *auth.progress.lock().unwrap() = Progress::default();
    Ok(())
}
pub async fn select(id: String) -> Result<(), String> {
    let auth = auth()?;
    let _guard = auth.gate.lock().await;
    let _file_lock = auth.storage_lock().await?;
    let mut store = auth.load()?;
    if !store
        .accounts
        .iter()
        .any(|a| a.client_id == id && a.tokens.is_some())
    {
        return Err("Sign in to this account first".into());
    }
    store.active = Some(id);
    auth.save(&store)
}
pub async fn logout() -> Result<bool, String> {
    cancel().await?;
    let auth = auth()?;
    let _guard = auth.gate.lock().await;
    let _file_lock = auth.storage_lock().await?;
    let mut store = auth.load()?;
    let mut revoked = true;
    if let Some(a) = store
        .accounts
        .iter_mut()
        .find(|a| Some(&a.client_id) == store.active.as_ref())
    {
        if let Some(t) = &a.tokens {
            revoked = false;
            if !t.refresh_token.is_empty() {
                if let Ok(doc) = discovery().await {
                    if let Some(endpoint) = doc.revocation_endpoint {
                        if trusted_endpoint(&endpoint).is_ok() {
                            for _ in 0..2 {
                                match client()
                                    .post(&endpoint)
                                    .form(&[
                                        ("token", t.refresh_token.as_str()),
                                        ("token_type_hint", "refresh_token"),
                                        ("client_id", a.client_id.as_str()),
                                    ])
                                    .send()
                                    .await
                                {
                                    Ok(r) if r.status().is_success() => {
                                        revoked = true;
                                        break;
                                    }
                                    _ => tokio::time::sleep(Duration::from_millis(400)).await,
                                }
                            }
                        }
                    }
                }
            }
        }
        a.tokens = None;
    }
    auth.save(&store)?;
    Ok(revoked)
}
pub async fn access_token() -> Result<String, String> {
    let auth = auth()?;
    let _guard = auth.gate.lock().await;
    let _file_lock = auth.storage_lock().await?;
    let mut store = auth.load()?;
    let a = store
        .accounts
        .iter_mut()
        .find(|a| Some(&a.client_id) == store.active.as_ref())
        .ok_or("Continue with ChatGPT in Settings first")?;
    let t = a
        .tokens
        .as_ref()
        .ok_or("Continue with ChatGPT in Settings first")?;
    if a.expires_at <= now() + 60 {
        if t.refresh_token.is_empty() {
            return Err("ChatGPT session expired. Sign in again in Settings.".into());
        }
        let mut new = exchange(
            &[
                ("grant_type", "refresh_token"),
                ("client_id", &a.client_id),
                ("refresh_token", &t.refresh_token),
                ("resource", RESOURCE),
            ],
            Some(&t.scope),
        )
        .await?;
        if !new.id_token.is_empty() {
            verify_identity(&new.id_token, &a.client_id, None, Some(a)).await?;
        }
        if new.refresh_token.is_empty() {
            new.refresh_token = t.refresh_token.clone();
        }
        if new.id_token.is_empty() {
            new.id_token = t.id_token.clone();
        }
        a.expires_at = now() + new.expires_in;
        a.tokens = Some(new);
        let token = a.tokens.as_ref().unwrap().access_token.clone();
        auth.save(&store)?;
        return Ok(token);
    }
    Ok(t.access_token.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn login_uses_pkce_and_dynamic_registration() {
        let url = reqwest::Url::parse(&authorize_url(
            "urn:uuid:test",
            None,
            "http://127.0.0.1:123/auth/callback",
            "state",
            "nonce",
            "verifier",
        ))
        .unwrap();
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q["client_id"], "dynamic_agent_client");
        assert_eq!(
            q["code_challenge"],
            URL_SAFE_NO_PAD.encode(Sha256::digest(b"verifier"))
        );
        assert_eq!(q["agent_name_hint"], "Komodo PDF");
        assert_eq!(q["nonce"], "nonce");
    }
    #[test]
    fn callback_rejects_wrong_state_missing_client_and_denial() {
        for query in [
            "state=wrong&code=x&client_id=issued",
            "state=ok&code=x",
            "state=ok&error=access_denied",
        ] {
            assert!(callback(
                &reqwest::Url::parse(&format!("http://127.0.0.1/auth/callback?{query}")).unwrap(),
                "ok",
                None
            )
            .is_err());
        }
    }
    #[test]
    fn claims_reject_wrong_nonce_or_account() {
        let a = Account {
            client_id: "id".into(),
            subject: "owner".into(),
            email: "".into(),
            tokens: None,
            expires_at: 0,
        };
        assert!(validate_claims(
            &serde_json::json!({"nonce":"bad","sub":"owner","iat":now()}),
            Some("ok"),
            Some(&a)
        )
        .is_err());
        assert!(validate_claims(
            &serde_json::json!({"nonce":"ok","sub":"other","iat":now()}),
            Some("ok"),
            Some(&a)
        )
        .is_err());
    }
    #[test]
    fn storage_round_trip_is_protected_on_windows() {
        let plain = b"secret credential";
        let encrypted = protect(plain, true).unwrap();
        #[cfg(windows)]
        assert_ne!(plain.as_slice(), encrypted.as_slice());
        assert_eq!(protect(&encrypted, false).unwrap(), plain);
    }
}

#[cfg(test)]
mod signature_tests {
    use super::*;
    use ring::signature::{Ed25519KeyPair, KeyPair};
    #[test]
    fn identity_requires_valid_signature_audience_issuer_and_expiry() {
        let pair = Ed25519KeyPair::from_seed_unchecked(&[7u8; 32]).unwrap();
        let jwks: JwkSet = serde_json::from_value(serde_json::json!({"keys":[{"kty":"OKP","crv":"Ed25519","x":URL_SAFE_NO_PAD.encode(pair.public_key().as_ref()),"kid":"test","alg":"EdDSA"}]})).unwrap();
        let claims = serde_json::json!({"iss":ISSUER,"aud":"issued","sub":"owner","exp":now()+300,"iat":now(),"nonce":"nonce"});
        let sign = |claims: &Value| {
            let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"EdDSA","kid":"test"}"#);
            let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap());
            let data = format!("{header}.{body}");
            format!(
                "{data}.{}",
                URL_SAFE_NO_PAD.encode(pair.sign(data.as_bytes()).as_ref())
            )
        };
        assert!(verify_with_keys(&sign(&claims), "issued", Some("nonce"), None, &jwks).is_ok());
        for (field, value) in [
            ("aud", serde_json::json!("other")),
            ("iss", serde_json::json!("https://other.test")),
            ("exp", serde_json::json!(now() - 30)),
        ] {
            let mut bad = claims.clone();
            bad[field] = value;
            assert!(verify_with_keys(&sign(&bad), "issued", Some("nonce"), None, &jwks).is_err());
        }
        let mut bad = sign(&claims).into_bytes();
        let last = bad.len() - 10;
        bad[last] = if bad[last] == b'A' { b'B' } else { b'A' };
        assert!(verify_with_keys(
            &String::from_utf8(bad).unwrap(),
            "issued",
            Some("nonce"),
            None,
            &jwks
        )
        .is_err());
    }
}
