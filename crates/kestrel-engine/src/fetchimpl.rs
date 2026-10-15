//! `fetch` client backend (reqwest + rustls), buffered.

use std::cell::RefCell;
use std::rc::Rc;

use deno_core::OpState;
use deno_error::JsErrorBox;
use serde::Serialize;

#[derive(Serialize)]
pub struct FetchResp {
    pub status: u16,
    pub status_text: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: deno_core::ToJsBuffer,
    /// "1.0", "1.1", "2.0" or "3.0".
    pub version: String,
}

/// HTTP/2 prior-knowledge client (http:// URLs for `http2.connect`), optionally accepting
/// invalid certificates; cached per (insecure) variant.
struct H2Client(reqwest::Client);
/// Same as the shared client but without redirects (`fetch` with `redirect: "manual"`,
/// node:http clients).
struct NoRedirectClient(reqwest::Client);
fn no_redirect_client(state: &Rc<RefCell<OpState>>) -> Result<reqwest::Client, JsErrorBox> {
    let mut st = state.borrow_mut();
    if let Some(c) = st.try_borrow::<NoRedirectClient>() { return Ok(c.0.clone()); }
    let insecure = std::env::var("NODE_TLS_REJECT_UNAUTHORIZED").map(|v| v == "0").unwrap_or(false);
    // No default User-Agent: node:http clients send none.
    let c = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .danger_accept_invalid_certs(insecure)
        .build()
        .map_err(|e| JsErrorBox::type_error(e.to_string()))?;
    st.put(NoRedirectClient(c.clone()));
    Ok(c)
}
struct H2ClientInsecure(reqwest::Client);
fn h2_client(state: &Rc<RefCell<OpState>>, insecure: bool) -> Result<reqwest::Client, JsErrorBox> {
    let mut st = state.borrow_mut();
    if insecure {
        if let Some(c) = st.try_borrow::<H2ClientInsecure>() { return Ok(c.0.clone()); }
    } else if let Some(c) = st.try_borrow::<H2Client>() {
        return Ok(c.0.clone());
    }
    let c = reqwest::Client::builder()
        .user_agent("kestrel/0.0.1")
        .redirect(reqwest::redirect::Policy::none())
        .danger_accept_invalid_certs(insecure)
        .http2_prior_knowledge()
        .build()
        .map_err(|e| JsErrorBox::type_error(e.to_string()))?;
    if insecure { st.put(H2ClientInsecure(c.clone())); } else { st.put(H2Client(c.clone())); }
    Ok(c)
}

fn client(state: &Rc<RefCell<OpState>>) -> Result<reqwest::Client, JsErrorBox> {
    let mut st = state.borrow_mut();
    if let Some(c) = st.try_borrow::<reqwest::Client>() {
        return Ok(c.clone());
    }
    let insecure = std::env::var("NODE_TLS_REJECT_UNAUTHORIZED").map(|v| v == "0").unwrap_or(false);
    let c = reqwest::Client::builder()
        .user_agent("kestrel/0.0.1")
        .redirect(reqwest::redirect::Policy::limited(20))
        .danger_accept_invalid_certs(insecure)
        .build()
        .map_err(|e| JsErrorBox::type_error(e.to_string()))?;
    st.put(c.clone());
    Ok(c)
}

pub async fn fetch(
    state: Rc<RefCell<OpState>>,
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
    follow_redirects: bool,
) -> Result<FetchResp, JsErrorBox> {
    fetch_opts(state, url, method, headers, body, follow_redirects, false, false).await
}

/// `h2`: speak HTTP/2 with prior knowledge on plain http:// (TLS negotiates h2 via ALPN
/// anyway). `insecure`: accept invalid certificates for this request's client.
#[allow(clippy::too_many_arguments)]
pub async fn fetch_opts(
    state: Rc<RefCell<OpState>>,
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
    follow_redirects: bool,
    h2: bool,
    insecure: bool,
) -> Result<FetchResp, JsErrorBox> {
    let client = if h2 { h2_client(&state, insecure)? } else if !follow_redirects { no_redirect_client(&state)? } else { client(&state)? };
    let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| JsErrorBox::type_error(e.to_string()))?;
    let mut req = client.request(m, &url);
    for (k, v) in headers {
        req = req.header(k, v);
    }
    if let Some(b) = body {
        req = req.body(b);
    }
    let resp = req.send().await.map_err(|e| JsErrorBox::type_error(format!("fetch failed: {e}")))?;
    let status = resp.status();
    let version = match resp.version() {
        reqwest::Version::HTTP_10 => "1.0",
        reqwest::Version::HTTP_2 => "2.0",
        reqwest::Version::HTTP_3 => "3.0",
        _ => "1.1",
    }
    .to_string();
    let final_url = resp.url().to_string();
    let hdrs = resp
        .headers()
        .iter()
        .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let bytes = resp.bytes().await.map_err(|e| JsErrorBox::type_error(format!("fetch body: {e}")))?;
    Ok(FetchResp {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        url: final_url,
        headers: hdrs,
        body: bytes.to_vec().into(),
        version,
    })
}
