//! OAuth 2.1 / PKCE client for a remotely hosted Lumiverse instance.
//!
//! Tokens never cross the Tauri IPC boundary. The WebView receives only the
//! role-scoped account and status DTOs returned by the remote desktop API.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use keyring::Entry;
use reqwest::{Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::{Mutex as AsyncMutex, OwnedMutexGuard},
    time::timeout,
};

const CLIENT_ID: &str = "lumiverse-desktop";
const RESOURCE: &str = "urn:lumiverse:desktop-api";
const REQUESTED_SCOPES: &str = "openid profile offline_access desktop:instance-status:read";
const KEYRING_SERVICE: &str = "chat.lumiverse.tray.oauth";
const AUTHORIZATION_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_CALLBACK_REQUEST_BYTES: usize = 8 * 1024;

pub struct RemoteInstanceState {
    sessions: Mutex<HashMap<String, RemoteOAuthSession>>,
    operations: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    credentials: Arc<dyn RefreshCredentialStore>,
}

impl Default for RemoteInstanceState {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            operations: Mutex::new(HashMap::new()),
            credentials: Arc::new(KeyringCredentialStore),
        }
    }
}

impl RemoteInstanceState {
    async fn lock_origin(&self, origin: &str) -> OwnedMutexGuard<()> {
        let operation = self
            .operations
            .lock()
            .unwrap()
            .entry(origin.to_owned())
            .or_default()
            .clone();
        // Refresh tokens rotate after one use. Keep restoration, refresh,
        // persistence and deletion in one operation per origin so status,
        // presence and capture cannot reuse or erase each other's credential.
        operation.lock_owned().await
    }

    pub(crate) fn capture_access_token(&self, origin: &str) -> Option<String> {
        self.sessions
            .lock()
            .ok()?
            .get(origin)
            .filter(|session| session.access_expires_at > Instant::now() + Duration::from_secs(20))
            .map(|session| session.access_token.clone())
    }
}

#[derive(Clone)]
struct RemoteOAuthSession {
    access_token: String,
    refresh_token: Option<String>,
    access_expires_at: Instant,
    credential_persisted: bool,
}

#[derive(Deserialize)]
struct OAuthMetadata {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
}

#[derive(Deserialize)]
struct OAuthTokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInstanceIdentity {
    id: String,
    name: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccount {
    id: String,
    name: String,
    username: Option<String>,
    role: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteCapabilities {
    can_read_status: bool,
}

#[derive(Deserialize)]
struct RemoteMeResponse {
    instance: RemoteInstanceIdentity,
    account: RemoteAccount,
    capabilities: RemoteCapabilities,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteConnectionPhase {
    Disconnected,
    Connected,
    Restricted,
    Unreachable,
    ReauthRequired,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInstanceSnapshot {
    state: RemoteConnectionPhase,
    origin: String,
    instance: Option<RemoteInstanceIdentity>,
    account: Option<RemoteAccount>,
    status: Option<serde_json::Value>,
    error: Option<String>,
    credential_persisted: bool,
}

impl RemoteInstanceSnapshot {
    pub(crate) fn capture_account(&self) -> Option<(&str, &str)> {
        self.account
            .as_ref()
            .map(|account| (account.id.as_str(), account.name.as_str()))
    }

    fn empty(origin: &str, state: RemoteConnectionPhase, error: Option<String>) -> Self {
        Self {
            state,
            origin: origin.into(),
            instance: None,
            account: None,
            status: None,
            error,
            credential_persisted: false,
        }
    }
}

enum PollError {
    Reauth(String),
    Unreachable(String),
    /// No session exists for this origin and none could be restored.
    Disconnected,
}

fn http_client() -> Result<Client, String> {
    Client::builder()
        .timeout(HTTP_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| error.to_string())
}

fn normalize_origin(value: &str) -> Result<Url, String> {
    let parsed = Url::parse(value.trim()).map_err(|_| "Invalid remote Lumiverse URL")?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("Remote Lumiverse URL must be an HTTP(S) origin".into());
    }
    let host = parsed.host_str().unwrap_or_default();
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]");
    if parsed.scheme() != "https" && !loopback {
        return Err("Remote Lumiverse instances must use HTTPS".into());
    }
    Url::parse(&parsed.origin().ascii_serialization()).map_err(|error| error.to_string())
}

fn validate_metadata_endpoint(origin: &Url, value: &str, name: &str) -> Result<Url, String> {
    let endpoint = Url::parse(value).map_err(|_| format!("Invalid OAuth {name}"))?;
    if endpoint.origin() != origin.origin()
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
    {
        return Err(format!(
            "OAuth {name} uses {}; expected {}",
            endpoint.origin().ascii_serialization(),
            origin.origin().ascii_serialization(),
        ));
    }
    Ok(endpoint)
}

async fn discover(client: &Client, origin: &Url) -> Result<OAuthMetadata, String> {
    let discovery_url = origin
        .join("/api/auth/.well-known/openid-configuration")
        .map_err(|error| error.to_string())?;
    let response = client
        .get(discovery_url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|error| format!("Could not reach the Lumiverse OAuth server: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "The selected instance does not expose desktop OAuth ({})",
            response.status()
        ));
    }
    let metadata: OAuthMetadata = response
        .json()
        .await
        .map_err(|error| format!("Invalid Lumiverse OAuth metadata: {error}"))?;
    let issuer = validate_metadata_endpoint(origin, &metadata.issuer, "issuer")?;
    if issuer.path().trim_end_matches('/') != "/api/auth"
        || issuer.query().is_some()
        || issuer.fragment().is_some()
    {
        return Err(format!(
            "OAuth issuer {} is not the selected Lumiverse auth service",
            metadata.issuer
        ));
    }
    validate_metadata_endpoint(
        origin,
        &metadata.authorization_endpoint,
        "authorization endpoint",
    )?;
    validate_metadata_endpoint(origin, &metadata.token_endpoint, "token endpoint")?;
    Ok(metadata)
}

fn keyring_account(origin: &str) -> String {
    Sha256::digest(origin.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

trait RefreshCredentialStore: Send + Sync {
    fn save(&self, origin: &str, token: &str) -> Result<(), String>;
    fn load(&self, origin: &str) -> Result<Option<String>, String>;
    fn delete(&self, origin: &str) -> Result<(), String>;
}

struct KeyringCredentialStore;

impl KeyringCredentialStore {
    fn entry(origin: &str) -> Result<Entry, String> {
        Entry::new(KEYRING_SERVICE, &keyring_account(origin)).map_err(|error| error.to_string())
    }
}

impl RefreshCredentialStore for KeyringCredentialStore {
    fn save(&self, origin: &str, token: &str) -> Result<(), String> {
        Self::entry(origin)?
            .set_password(token)
            .map_err(|error| error.to_string())
    }

    fn load(&self, origin: &str) -> Result<Option<String>, String> {
        match Self::entry(origin)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn delete(&self, origin: &str) -> Result<(), String> {
        match Self::entry(origin)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

async fn save_refresh_token(
    state: &RemoteInstanceState,
    origin: String,
    token: String,
) -> Result<(), String> {
    let credentials = state.credentials.clone();
    tauri::async_runtime::spawn_blocking(move || credentials.save(&origin, &token))
        .await
        .map_err(|error| error.to_string())?
}

async fn load_refresh_token(
    state: &RemoteInstanceState,
    origin: String,
) -> Result<Option<String>, String> {
    let credentials = state.credentials.clone();
    tauri::async_runtime::spawn_blocking(move || credentials.load(&origin))
        .await
        .map_err(|error| error.to_string())?
}

async fn delete_refresh_token(state: &RemoteInstanceState, origin: String) -> Result<(), String> {
    let credentials = state.credentials.clone();
    tauri::async_runtime::spawn_blocking(move || credentials.delete(&origin))
        .await
        .map_err(|error| error.to_string())?
}

fn pkce_pair() -> (String, String) {
    let verifier = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

fn authorization_url(
    metadata: &OAuthMetadata,
    origin: &Url,
    redirect_uri: &str,
    state: &str,
    nonce: &str,
    challenge: &str,
) -> Result<Url, String> {
    let mut url = validate_metadata_endpoint(
        origin,
        &metadata.authorization_endpoint,
        "authorization endpoint",
    )?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", CLIENT_ID)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", REQUESTED_SCOPES)
        .append_pair("resource", RESOURCE)
        .append_pair("state", state)
        .append_pair("nonce", nonce)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256");
    Ok(url)
}

struct AuthorizationCallback {
    code: String,
    issuer: String,
}

fn parse_callback_target(
    target: &str,
    expected_state: &str,
) -> Result<AuthorizationCallback, String> {
    if target.len() > MAX_CALLBACK_REQUEST_BYTES || !target.starts_with('/') {
        return Err("Invalid OAuth callback request".into());
    }
    let url = Url::parse(&format!("http://127.0.0.1{target}"))
        .map_err(|_| "Invalid OAuth callback URL")?;
    if url.path() != "/callback" {
        return Err("Invalid OAuth callback path".into());
    }
    if let Some(error) = url.query_pairs().find(|(key, _)| key == "error") {
        return Err(format!("Lumiverse authorization was denied: {}", error.1));
    }
    let query = url.query_pairs().collect::<HashMap<_, _>>();
    if query.get("state").map(|value| value.as_ref()) != Some(expected_state) {
        return Err("OAuth callback state did not match".into());
    }
    let code = query
        .get("code")
        .filter(|value| !value.is_empty())
        .ok_or("OAuth callback did not include a code")?
        .to_string();
    let issuer = query
        .get("iss")
        .filter(|value| !value.is_empty())
        .ok_or("OAuth callback did not include its issuer")?
        .to_string();
    Ok(AuthorizationCallback { code, issuer })
}

async fn await_callback(
    listener: TcpListener,
    expected_state: &str,
) -> Result<AuthorizationCallback, String> {
    let (mut stream, _) = timeout(AUTHORIZATION_TIMEOUT, listener.accept())
        .await
        .map_err(|_| "Lumiverse authorization timed out".to_string())?
        .map_err(|error| error.to_string())?;
    // TCP does not preserve HTTP write boundaries. Read through the complete
    // header instead of assuming the request line arrives in the first packet.
    let request = timeout(Duration::from_secs(10), async {
        let mut request = Vec::with_capacity(1024);
        let mut chunk = [0_u8; 1024];
        loop {
            let read = stream.read(&mut chunk).await?;
            if read == 0 {
                break;
            }
            if request.len() + read > MAX_CALLBACK_REQUEST_BYTES {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "OAuth callback request was too large",
                ));
            }
            request.extend_from_slice(&chunk[..read]);
            if request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                break;
            }
        }
        Ok::<_, std::io::Error>(request)
    })
    .await
    .map_err(|_| "OAuth callback timed out".to_string())?
    .map_err(|error| error.to_string())?;
    let request = String::from_utf8_lossy(&request);
    let mut parts = request
        .lines()
        .next()
        .unwrap_or_default()
        .split_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or_default();
    let callback = if method == "GET" {
        parse_callback_target(target, expected_state)
    } else {
        Err("Invalid OAuth callback method".into())
    };
    let (status, heading, message) = if callback.is_ok() {
        (
            "200 OK",
            "Lumiverse connected",
            "You can close this browser tab and return to Lumiverse Desktop.",
        )
    } else {
        (
            "400 Bad Request",
            "Lumiverse could not connect",
            "Return to Lumiverse Desktop and try signing in again.",
        )
    };
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\"><title>{heading}</title><style>body{{font:16px system-ui;background:#17151d;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}}main{{max-width:34rem;padding:2rem;text-align:center}}p{{color:#b8b2c2}}</style></head><body><main><h1>{heading}</h1><p>{message}</p></main></body></html>"
    );
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
    callback
}

async fn exchange_code(
    client: &Client,
    metadata: &OAuthMetadata,
    origin: &Url,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<OAuthTokenResponse, String> {
    let token_endpoint =
        validate_metadata_endpoint(origin, &metadata.token_endpoint, "token endpoint")?;
    let response = client
        .post(token_endpoint)
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", CLIENT_ID),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", redirect_uri),
            ("resource", RESOURCE),
        ])
        .send()
        .await
        .map_err(|error| format!("Could not exchange the authorization code: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Lumiverse rejected the authorization code ({})",
            response.status()
        ));
    }
    response
        .json()
        .await
        .map_err(|error| format!("Invalid Lumiverse token response: {error}"))
}

async fn refresh_session(
    state: &RemoteInstanceState,
    client: &Client,
    origin: &Url,
    refresh_token: String,
) -> Result<RemoteOAuthSession, PollError> {
    let metadata = discover(client, origin)
        .await
        .map_err(PollError::Unreachable)?;
    let token_endpoint =
        validate_metadata_endpoint(origin, &metadata.token_endpoint, "token endpoint")
            .map_err(PollError::Unreachable)?;
    let response = client
        .post(token_endpoint)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", CLIENT_ID),
            ("refresh_token", refresh_token.as_str()),
            ("scope", REQUESTED_SCOPES),
            ("resource", RESOURCE),
        ])
        .send()
        .await
        .map_err(|error| {
            PollError::Unreachable(format!(
                "Could not refresh Lumiverse authorization: {error}"
            ))
        })?;
    if !response.status().is_success() {
        let status = response.status();
        #[derive(Deserialize)]
        struct OAuthErrorResponse {
            error: String,
        }
        let error = response.json::<OAuthErrorResponse>().await.ok();
        // Only an invalid grant proves the refresh credential is unusable.
        // Proxy errors and other OAuth failures must not erase a saved token.
        if matches!(status, StatusCode::BAD_REQUEST | StatusCode::UNAUTHORIZED)
            && error
                .as_ref()
                .is_some_and(|error| error.error == "invalid_grant")
        {
            return Err(PollError::Reauth(
                "Lumiverse authorization must be renewed".into(),
            ));
        }
        return Err(PollError::Unreachable(format!(
            "Lumiverse token refresh failed ({})",
            status
        )));
    }
    let token: OAuthTokenResponse = response.json().await.map_err(|error| {
        PollError::Unreachable(format!("Invalid Lumiverse token response: {error}"))
    })?;
    let next_refresh = token.refresh_token.or(Some(refresh_token));
    let persisted = if let Some(value) = &next_refresh {
        save_refresh_token(
            state,
            origin.as_str().trim_end_matches('/').into(),
            value.clone(),
        )
        .await
        .is_ok()
    } else {
        false
    };
    Ok(RemoteOAuthSession {
        access_token: token.access_token,
        refresh_token: next_refresh,
        access_expires_at: Instant::now() + Duration::from_secs(token.expires_in.unwrap_or(300)),
        credential_persisted: persisted,
    })
}

async fn fetch_snapshot(
    client: &Client,
    origin: &Url,
    session: &RemoteOAuthSession,
) -> Result<RemoteInstanceSnapshot, PollError> {
    let canonical_origin = origin.as_str().trim_end_matches('/');
    let me_url = origin
        .join("/api/desktop/v1/me")
        .map_err(|error| PollError::Unreachable(error.to_string()))?;
    let response = client
        .get(me_url)
        .bearer_auth(&session.access_token)
        .send()
        .await
        .map_err(|error| {
            PollError::Unreachable(format!("Could not reach the remote instance: {error}"))
        })?;
    if response.status() == StatusCode::UNAUTHORIZED {
        return Err(PollError::Reauth(
            "Lumiverse authorization must be renewed".into(),
        ));
    }
    if !response.status().is_success() {
        return Err(PollError::Unreachable(format!(
            "Remote instance identity request failed ({})",
            response.status()
        )));
    }
    let me: RemoteMeResponse = response.json().await.map_err(|error| {
        PollError::Unreachable(format!("Invalid remote instance identity: {error}"))
    })?;

    if !me.capabilities.can_read_status {
        return Ok(RemoteInstanceSnapshot {
            state: RemoteConnectionPhase::Restricted,
            origin: canonical_origin.into(),
            instance: Some(me.instance),
            account: Some(me.account),
            status: None,
            error: None,
            credential_persisted: session.credential_persisted,
        });
    }

    let status_url = origin
        .join("/api/desktop/v1/status")
        .map_err(|error| PollError::Unreachable(error.to_string()))?;
    let response = client
        .get(status_url)
        .bearer_auth(&session.access_token)
        .send()
        .await
        .map_err(|error| {
            PollError::Unreachable(format!("Could not read remote status: {error}"))
        })?;
    if response.status() == StatusCode::UNAUTHORIZED {
        return Err(PollError::Reauth(
            "Lumiverse authorization must be renewed".into(),
        ));
    }
    if response.status() == StatusCode::FORBIDDEN {
        return Ok(RemoteInstanceSnapshot {
            state: RemoteConnectionPhase::Restricted,
            origin: canonical_origin.into(),
            instance: Some(me.instance),
            account: Some(me.account),
            status: None,
            error: None,
            credential_persisted: session.credential_persisted,
        });
    }
    if !response.status().is_success() {
        return Err(PollError::Unreachable(format!(
            "Remote status request failed ({})",
            response.status()
        )));
    }
    let status = response.json().await.map_err(|error| {
        PollError::Unreachable(format!("Invalid remote status response: {error}"))
    })?;
    Ok(RemoteInstanceSnapshot {
        state: RemoteConnectionPhase::Connected,
        origin: canonical_origin.into(),
        instance: Some(me.instance),
        account: Some(me.account),
        status: Some(status),
        error: None,
        credential_persisted: session.credential_persisted,
    })
}

#[tauri::command]
pub async fn remote_instance_connect(
    app: AppHandle,
    state: State<'_, RemoteInstanceState>,
    origin: String,
) -> Result<RemoteInstanceSnapshot, String> {
    let origin = normalize_origin(&origin)?;
    let canonical_origin = origin.as_str().trim_end_matches('/').to_string();
    let client = http_client()?;
    let metadata = discover(&client, &origin).await?;
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| format!("Could not open the OAuth callback listener: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    let state_token = uuid::Uuid::new_v4().simple().to_string();
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let (verifier, challenge) = pkce_pair();
    let authorize = authorization_url(
        &metadata,
        &origin,
        &redirect_uri,
        &state_token,
        &nonce,
        &challenge,
    )?;
    app.opener()
        .open_url(authorize.to_string(), None::<String>)
        .map_err(|error| format!("Could not open the system browser: {error}"))?;

    let callback = await_callback(listener, &state_token).await?;
    if callback.issuer.trim_end_matches('/') != metadata.issuer.trim_end_matches('/') {
        return Err("OAuth callback issuer did not match the selected instance".into());
    }
    let _operation = state.lock_origin(&canonical_origin).await;
    let token = exchange_code(
        &client,
        &metadata,
        &origin,
        &callback.code,
        &verifier,
        &redirect_uri,
    )
    .await?;
    let credential_persisted = if let Some(refresh_token) = &token.refresh_token {
        save_refresh_token(&state, canonical_origin.clone(), refresh_token.clone())
            .await
            .is_ok()
    } else {
        false
    };
    let session = RemoteOAuthSession {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        access_expires_at: Instant::now() + Duration::from_secs(token.expires_in.unwrap_or(300)),
        credential_persisted,
    };
    state
        .sessions
        .lock()
        .unwrap()
        .insert(canonical_origin.clone(), session.clone());
    fetch_snapshot(&client, &origin, &session)
        .await
        .map_err(|error| match error {
            PollError::Reauth(message) | PollError::Unreachable(message) => message,
            PollError::Disconnected => unreachable!("fetch_snapshot never reports Disconnected"),
        })
}

/// Resolve a usable session for `origin`: in-memory session, keyring restore,
/// or a proactive refresh when the access token is about to expire. Refreshed
/// sessions are written back to the in-memory map. Caller holds lock_origin.
async fn resolve_session(
    state: &RemoteInstanceState,
    client: &Client,
    origin: &Url,
    canonical_origin: &str,
) -> Result<RemoteOAuthSession, PollError> {
    let mut session = state
        .sessions
        .lock()
        .unwrap()
        .get(canonical_origin)
        .cloned();
    if session.is_none() {
        match load_refresh_token(state, canonical_origin.to_string()).await {
            Ok(Some(refresh_token)) => {
                match refresh_session(state, client, origin, refresh_token).await {
                    Ok(refreshed) => session = Some(refreshed),
                    Err(PollError::Reauth(message)) => {
                        let _ = delete_refresh_token(state, canonical_origin.to_string()).await;
                        return Err(PollError::Reauth(message));
                    }
                    Err(PollError::Unreachable(message)) => {
                        return Err(PollError::Unreachable(message));
                    }
                    Err(PollError::Disconnected) => {
                        unreachable!("refresh_session never reports Disconnected")
                    }
                }
            }
            Ok(None) => {
                return Err(PollError::Disconnected);
            }
            Err(error) => {
                return Err(PollError::Unreachable(format!(
                    "Could not read the saved Lumiverse credential: {error}"
                )));
            }
        }
    }

    let mut session = session.expect("session resolved above");
    if session.access_expires_at <= Instant::now() + Duration::from_secs(30) {
        let Some(refresh_token) = session.refresh_token.clone() else {
            return Err(PollError::Reauth(
                "Lumiverse authorization must be renewed".into(),
            ));
        };
        match refresh_session(state, client, origin, refresh_token).await {
            Ok(refreshed) => session = refreshed,
            Err(PollError::Reauth(message)) => {
                let _ = delete_refresh_token(state, canonical_origin.to_string()).await;
                state.sessions.lock().unwrap().remove(canonical_origin);
                return Err(PollError::Reauth(message));
            }
            Err(PollError::Unreachable(message)) => {
                return Err(PollError::Unreachable(message));
            }
            Err(PollError::Disconnected) => {
                unreachable!("refresh_session never reports Disconnected")
            }
        }
    } else if !session.credential_persisted {
        if let Some(refresh_token) = &session.refresh_token {
            // A locked credential store can recover during this run. Retry
            // saving the current rotated token before Desktop is restarted.
            session.credential_persisted =
                save_refresh_token(state, canonical_origin.to_string(), refresh_token.clone())
                    .await
                    .is_ok();
        }
    }
    state
        .sessions
        .lock()
        .unwrap()
        .insert(canonical_origin.to_string(), session.clone());
    Ok(session)
}

pub(crate) async fn poll_remote_instance(
    state: &RemoteInstanceState,
    origin: String,
) -> RemoteInstanceSnapshot {
    let origin = match normalize_origin(&origin) {
        Ok(value) => value,
        Err(error) => {
            return RemoteInstanceSnapshot::empty(
                "",
                RemoteConnectionPhase::Unreachable,
                Some(error),
            );
        }
    };
    let canonical_origin = origin.as_str().trim_end_matches('/').to_string();
    let _operation = state.lock_origin(&canonical_origin).await;
    let client = match http_client() {
        Ok(value) => value,
        Err(error) => {
            return RemoteInstanceSnapshot::empty(
                &canonical_origin,
                RemoteConnectionPhase::Unreachable,
                Some(error),
            );
        }
    };

    let session = match resolve_session(state, &client, &origin, &canonical_origin).await {
        Ok(session) => session,
        Err(PollError::Disconnected) => {
            return RemoteInstanceSnapshot::empty(
                &canonical_origin,
                RemoteConnectionPhase::Disconnected,
                None,
            );
        }
        Err(PollError::Reauth(message)) => {
            return RemoteInstanceSnapshot::empty(
                &canonical_origin,
                RemoteConnectionPhase::ReauthRequired,
                Some(message),
            );
        }
        Err(PollError::Unreachable(message)) => {
            return RemoteInstanceSnapshot::empty(
                &canonical_origin,
                RemoteConnectionPhase::Unreachable,
                Some(message),
            );
        }
    };

    match fetch_snapshot(&client, &origin, &session).await {
        Ok(snapshot) => snapshot,
        Err(PollError::Reauth(message)) => {
            // A server may revoke an access token before its advertised expiry.
            // Refresh and retry exactly once before requiring interaction.
            let Some(refresh_token) = session.refresh_token.clone() else {
                state.sessions.lock().unwrap().remove(&canonical_origin);
                return RemoteInstanceSnapshot::empty(
                    &canonical_origin,
                    RemoteConnectionPhase::ReauthRequired,
                    Some(message),
                );
            };
            match refresh_session(state, &client, &origin, refresh_token).await {
                Ok(refreshed) => {
                    state
                        .sessions
                        .lock()
                        .unwrap()
                        .insert(canonical_origin.clone(), refreshed.clone());
                    match fetch_snapshot(&client, &origin, &refreshed).await {
                        Ok(snapshot) => snapshot,
                        Err(PollError::Reauth(message)) => {
                            let _ = delete_refresh_token(state, canonical_origin.clone()).await;
                            state.sessions.lock().unwrap().remove(&canonical_origin);
                            RemoteInstanceSnapshot::empty(
                                &canonical_origin,
                                RemoteConnectionPhase::ReauthRequired,
                                Some(message),
                            )
                        }
                        Err(PollError::Unreachable(message)) => RemoteInstanceSnapshot::empty(
                            &canonical_origin,
                            RemoteConnectionPhase::Unreachable,
                            Some(message),
                        ),
                        Err(PollError::Disconnected) => {
                            unreachable!("fetch_snapshot never reports Disconnected")
                        }
                    }
                }
                Err(PollError::Reauth(message)) => {
                    let _ = delete_refresh_token(state, canonical_origin.clone()).await;
                    state.sessions.lock().unwrap().remove(&canonical_origin);
                    RemoteInstanceSnapshot::empty(
                        &canonical_origin,
                        RemoteConnectionPhase::ReauthRequired,
                        Some(message),
                    )
                }
                Err(PollError::Unreachable(message)) => RemoteInstanceSnapshot::empty(
                    &canonical_origin,
                    RemoteConnectionPhase::Unreachable,
                    Some(message),
                ),
                Err(PollError::Disconnected) => {
                    unreachable!("refresh_session never reports Disconnected")
                }
            }
        }
        Err(PollError::Unreachable(message)) => RemoteInstanceSnapshot::empty(
            &canonical_origin,
            RemoteConnectionPhase::Unreachable,
            Some(message),
        ),
        Err(PollError::Disconnected) => {
            unreachable!("fetch_snapshot never reports Disconnected")
        }
    }
}

#[tauri::command]
pub async fn remote_instance_poll(
    state: State<'_, RemoteInstanceState>,
    origin: String,
) -> Result<RemoteInstanceSnapshot, String> {
    Ok(poll_remote_instance(&state, origin).await)
}

#[tauri::command]
pub async fn remote_instance_disconnect(
    app: AppHandle,
    state: State<'_, RemoteInstanceState>,
    origin: String,
) -> Result<(), String> {
    let origin = normalize_origin(&origin)?;
    let canonical_origin = origin.as_str().trim_end_matches('/').to_string();
    crate::capture::stop(&app, Some(&canonical_origin));
    let _operation = state.lock_origin(&canonical_origin).await;
    state.sessions.lock().unwrap().remove(&canonical_origin);
    delete_refresh_token(&state, canonical_origin).await
}

/// Chat or landing-page snapshot served by the instance's desktop API for
/// Discord Rich Presence. Mirrors the backend's `PresenceSnapshot` DTO.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceSnapshotDto {
    pub chat_id: Option<String>,
    pub character_name: Option<String>,
    pub message_count: Option<u64>,
    pub total_tokens: Option<u64>,
    pub model: Option<String>,
    #[serde(default)]
    pub character_count: Option<u64>,
}

/// Outcome of a presence poll. `ReauthRequired` and `Disconnected` tell the
/// tray a desktop sign-in is needed before presence can flow.
#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum PresenceFetch {
    Active { snapshot: PresenceSnapshotDto },
    Inactive,
    Disconnected,
    ReauthRequired { error: Option<String> },
    Unreachable { error: Option<String> },
}

async fn fetch_presence(
    client: &Client,
    origin: &Url,
    session: &RemoteOAuthSession,
) -> Result<Option<PresenceSnapshotDto>, PollError> {
    #[derive(Deserialize)]
    struct PresenceResponse {
        active: Option<PresenceSnapshotDto>,
    }
    let url = origin
        .join("/api/desktop/v1/presence")
        .map_err(|error| PollError::Unreachable(error.to_string()))?;
    let response = client
        .get(url)
        .bearer_auth(&session.access_token)
        .send()
        .await
        .map_err(|error| {
            PollError::Unreachable(format!("Could not reach the Lumiverse instance: {error}"))
        })?;
    if response.status() == StatusCode::UNAUTHORIZED {
        return Err(PollError::Reauth(
            "Lumiverse authorization must be renewed".into(),
        ));
    }
    if !response.status().is_success() {
        return Err(PollError::Unreachable(format!(
            "Presence request failed ({})",
            response.status()
        )));
    }
    let body: PresenceResponse = response
        .json()
        .await
        .map_err(|error| PollError::Unreachable(format!("Invalid presence response: {error}")))?;
    Ok(body.active)
}

/// Fetch the current user's presence from the instance's desktop
/// API, reusing (and refreshing) this origin's stored desktop session.
#[tauri::command]
pub async fn discord_presence_fetch(
    state: State<'_, RemoteInstanceState>,
    origin: String,
) -> Result<PresenceFetch, String> {
    poll_presence(state.inner(), origin).await
}

async fn poll_presence(
    state: &RemoteInstanceState,
    origin: String,
) -> Result<PresenceFetch, String> {
    let origin = normalize_origin(&origin).map_err(|error| error.to_string())?;
    let canonical_origin = origin.as_str().trim_end_matches('/').to_string();
    let _operation = state.lock_origin(&canonical_origin).await;
    let client = http_client().map_err(|error| error.to_string())?;

    let session = match resolve_session(state, &client, &origin, &canonical_origin).await {
        Ok(session) => session,
        Err(PollError::Disconnected) => return Ok(PresenceFetch::Disconnected),
        Err(PollError::Reauth(message)) => {
            return Ok(PresenceFetch::ReauthRequired {
                error: Some(message),
            })
        }
        Err(PollError::Unreachable(message)) => {
            return Ok(PresenceFetch::Unreachable {
                error: Some(message),
            })
        }
    };

    match fetch_presence(&client, &origin, &session).await {
        Ok(Some(snapshot)) => Ok(PresenceFetch::Active { snapshot }),
        Ok(None) => Ok(PresenceFetch::Inactive),
        Err(PollError::Reauth(message)) => {
            // A server may revoke an access token before its advertised
            // expiry. Refresh and retry exactly once before giving up.
            let Some(refresh_token) = session.refresh_token.clone() else {
                state.sessions.lock().unwrap().remove(&canonical_origin);
                return Ok(PresenceFetch::ReauthRequired {
                    error: Some(message),
                });
            };
            match refresh_session(state, &client, &origin, refresh_token).await {
                Ok(refreshed) => {
                    state
                        .sessions
                        .lock()
                        .unwrap()
                        .insert(canonical_origin.clone(), refreshed.clone());
                    match fetch_presence(&client, &origin, &refreshed).await {
                        Ok(Some(snapshot)) => Ok(PresenceFetch::Active { snapshot }),
                        Ok(None) => Ok(PresenceFetch::Inactive),
                        Err(PollError::Reauth(message)) => {
                            let _ = delete_refresh_token(state, canonical_origin.clone()).await;
                            state.sessions.lock().unwrap().remove(&canonical_origin);
                            Ok(PresenceFetch::ReauthRequired {
                                error: Some(message),
                            })
                        }
                        Err(PollError::Unreachable(message)) => Ok(PresenceFetch::Unreachable {
                            error: Some(message),
                        }),
                        Err(PollError::Disconnected) => {
                            unreachable!("fetch_presence never reports Disconnected")
                        }
                    }
                }
                Err(PollError::Reauth(message)) => {
                    let _ = delete_refresh_token(state, canonical_origin.clone()).await;
                    state.sessions.lock().unwrap().remove(&canonical_origin);
                    Ok(PresenceFetch::ReauthRequired {
                        error: Some(message),
                    })
                }
                Err(PollError::Unreachable(message)) => Ok(PresenceFetch::Unreachable {
                    error: Some(message),
                }),
                Err(PollError::Disconnected) => {
                    unreachable!("refresh_session never reports Disconnected")
                }
            }
        }
        Err(PollError::Unreachable(message)) => Ok(PresenceFetch::Unreachable {
            error: Some(message),
        }),
        Err(PollError::Disconnected) => unreachable!("fetch_presence never reports Disconnected"),
    }
}

#[cfg(test)]
mod tests;
