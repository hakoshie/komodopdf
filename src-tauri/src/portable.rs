use std::path::PathBuf;
use tauri::Manager;

/// Detects whether the app is running in portable mode.
/// Portable mode is triggered by placing a file named `portable` (no extension)
/// in the same directory as the executable.
pub fn is_portable() -> bool {
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            return exe_dir.join("portable").exists();
        }
    }
    false
}

/// Returns the appropriate data directory for the app.
/// In portable mode, this is a `data` folder next to the executable.
/// Otherwise, it falls back to the standard OS app-data directory.
pub fn data_dir(app: &impl Manager<tauri::Wry>) -> PathBuf {
    if is_portable() {
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                return exe_dir.join("data");
            }
        }
    }
    app.path()
        .app_data_dir()
        .expect("failed to get app data dir")
}

pub fn valid_conversation_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, byte)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

pub fn history_dir(app: &impl Manager<tauri::Wry>) -> anyhow::Result<PathBuf> {
    Ok(if is_portable() {
        data_dir(app)
    } else {
        app.path().document_dir()?.join("Komodo PDF")
    })
}

pub fn conversation_dir(
    app: &impl Manager<tauri::Wry>,
    file_hash: &str,
    conversation_id: &str,
) -> anyhow::Result<PathBuf> {
    anyhow::ensure!(
        file_hash.len() == 64
            && file_hash.bytes().all(|b| b.is_ascii_hexdigit())
            && valid_conversation_id(conversation_id),
        "Invalid PDF or conversation ID"
    );
    let root = history_dir(app)?;
    Ok(root
        .join("conversations")
        .join(file_hash)
        .join(conversation_id))
}
