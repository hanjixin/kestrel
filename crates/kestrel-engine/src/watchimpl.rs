//! fs.watch via the `notify` crate (inotify / FSEvents / kqueue).

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use deno_core::{op2, OpState};
use deno_error::JsErrorBox;
use notify::Watcher;

struct Watch {
    _watcher: notify::RecommendedWatcher,
    rx: tokio::sync::mpsc::UnboundedReceiver<(String, String)>,
}
#[derive(Default)]
struct Watches {
    next: u32,
    map: HashMap<u32, Rc<RefCell<Watch>>>,
}
fn watches(state: &mut OpState) -> &mut Watches {
    if state.try_borrow::<Watches>().is_none() {
        state.put(Watches::default());
    }
    state.borrow_mut::<Watches>()
}

#[op2(fast)]
pub fn op_fs_watch(state: &mut OpState, #[string] path: &str, recursive: bool) -> Result<u32, JsErrorBox> {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<(String, String)>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            let kind = match ev.kind {
                notify::EventKind::Create(_) | notify::EventKind::Remove(_) => "rename",
                notify::EventKind::Modify(notify::event::ModifyKind::Name(_)) => "rename",
                _ => "change",
            };
            for p in ev.paths {
                let _ = tx.send((kind.to_string(), p.to_string_lossy().into_owned()));
            }
        }
    })
    .map_err(|e| JsErrorBox::generic(e.to_string()))?;
    let mode = if recursive { notify::RecursiveMode::Recursive } else { notify::RecursiveMode::NonRecursive };
    watcher.watch(std::path::Path::new(path), mode).map_err(|e| {
        let code = match e.kind { notify::ErrorKind::PathNotFound => "ENOENT", _ => "EIO" };
        JsErrorBox::new("Error", format!("{code}: {e}, watch '{path}'"))
    })?;
    let w = watches(state);
    let rid = w.next;
    w.next += 1;
    w.map.insert(rid, Rc::new(RefCell::new(Watch { _watcher: watcher, rx })));
    Ok(rid)
}

/// Next event as [kind, path]; null once the watcher is closed.
#[op2]
#[serde]
pub async fn op_fs_watch_next(state: Rc<RefCell<OpState>>, rid: u32) -> Result<Option<(String, String)>, JsErrorBox> {
    let w = { let mut st = state.borrow_mut(); watches(&mut st).map.get(&rid).cloned() };
    let Some(w) = w else { return Ok(None) };
    // Poll without holding the RefCell across the await.
    loop {
        let r = w.borrow_mut().rx.try_recv();
        match r {
            Ok(ev) => return Ok(Some(ev)),
            Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => return Ok(None),
            Err(_) => {
                let alive = { let mut st = state.borrow_mut(); watches(&mut st).map.contains_key(&rid) };
                if !alive { return Ok(None); }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }
    }
}

#[op2(fast)]
pub fn op_fs_unwatch(state: &mut OpState, rid: u32) {
    watches(state).map.remove(&rid);
}
