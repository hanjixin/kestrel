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
}

fn client(state: &Rc<RefCell<OpState>>) -> Result<reqwest::Client, JsErrorBox> {
    let mut st = state.borrow_mut();
    if let Some(c) = st.try_borrow::<reqwest::Client>() {
        return Ok(c.clone());
    }
    let c = reqwest::Client::builder()
        .user_agent("kestrel/0.0.1")
        .redirect(reqwest::redirect::Policy::limited(20))
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
    let client = client(&state)?;
    let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| JsErrorBox::type_error(e.to_string()))?;
    let mut req = client.request(m, &url);
    for (k, v) in headers {
        req = req.header(k, v);
    }
    if let Some(b) = body {
        req = req.body(b);
    }
    if !follow_redirects {
        // Per-request policy isn't configurable on a shared client; build a one-off client.
        let c = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| JsErrorBox::type_error(e.to_string()))?;
        req = c.request(req.build().map_err(|e| JsErrorBox::type_error(e.to_string()))?.method().clone(), &url);
    }
    let resp = req.send().await.map_err(|e| JsErrorBox::type_error(format!("fetch failed: {e}")))?;
    let status = resp.status();
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
    })
}
