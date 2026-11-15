//! SyncTeX stays local: no shell interpolation or editor commands from PDF data.
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ForwardRequest {
    pub pdf: String,
    pub source: String,
    pub line: u32,
}
#[derive(Default)]
pub struct Requests(pub Mutex<VecDeque<ForwardRequest>>);

pub fn from_args(args: &[String], cwd: &Path) -> Option<ForwardRequest> {
    let i = args.iter().position(|a| a == "--forward-search")?;
    let source = args.get(i + 1)?;
    let line = args.get(i + 2)?.parse::<u32>().ok().filter(|n| *n > 0)?;
    let pdf = args.get(i + 3)?;
    let absolute = |s: &str| {
        let p = Path::new(s);
        if p.is_absolute() {
            p.to_owned()
        } else {
            cwd.join(p)
        }
    };
    if !Path::new(pdf).extension()?.eq_ignore_ascii_case("pdf") {
        return None;
    }
    Some(ForwardRequest {
        pdf: absolute(pdf).to_string_lossy().into_owned(),
        source: absolute(source).to_string_lossy().into_owned(),
        line,
    })
}

#[derive(Debug, Serialize)]
pub struct Position {
    pub page: u32,
    pub x: f64,
    pub y: f64,
}

fn field<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    text.lines()
        .find_map(|line| line.strip_prefix(name))
        .map(str::trim)
}
fn position(text: &str) -> Result<Position, String> {
    let page = field(text, "Page:")
        .and_then(|s| s.parse::<u32>().ok())
        .filter(|p| *p > 0);
    let x = field(text, "x:")
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|n| n.is_finite());
    let y = field(text, "y:")
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|n| n.is_finite());
    match (page, x, y) { (Some(page), Some(x), Some(y)) => Ok(Position { page, x, y }), _ => Err("No SyncTeX match. Rebuild TeX with -synctex=1 and keep the .synctex.gz beside the PDF.".into()) }
}
// Older TeX Live on Windows writes paths in the system ANSI code page (e.g.
// CP932), while current builds may use UTF-8. Do not corrupt Japanese filenames.
fn decode_output(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_owned();
    }
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn MultiByteToWideChar(
                code_page: u32,
                flags: u32,
                bytes: *const u8,
                count: i32,
                wide: *mut u16,
                capacity: i32,
            ) -> i32;
        }
        if let Ok(count) = i32::try_from(bytes.len()) {
            // CP_ACP = 0, the code page used by legacy native console tools.
            let size = unsafe {
                MultiByteToWideChar(0, 0, bytes.as_ptr(), count, std::ptr::null_mut(), 0)
            };
            if size > 0 {
                let mut wide = vec![0u16; size as usize];
                let written = unsafe {
                    MultiByteToWideChar(0, 0, bytes.as_ptr(), count, wide.as_mut_ptr(), size)
                };
                if written > 0 {
                    return String::from_utf16_lossy(&wide[..written as usize]);
                }
            }
        }
    }
    String::from_utf8_lossy(bytes).into_owned()
}

async fn run(pdf: &str, args: &[String]) -> Result<String, String> {
    let pdf = Path::new(pdf);
    if !pdf.is_absolute() || !pdf.is_file() {
        return Err("SyncTeX requires an existing absolute PDF path.".into());
    }
    let executable = std::env::var_os("KOMODO_SYNCTEX_PATH").unwrap_or_else(|| "synctex".into());
    let mut command = tokio::process::Command::new(executable);
    command
        .args(args)
        .current_dir(pdf.parent().unwrap())
        .env_remove("SYNCTEX_EDITOR")
        .env_remove("SYNCTEX_VIEWER")
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = tokio::time::timeout(Duration::from_secs(10), command.output()).await
        .map_err(|_| "SyncTeX timed out after 10 seconds".to_string())?
        .map_err(|e| format!("Could not run synctex. Install TeX Live/MiKTeX and put synctex on PATH (or set KOMODO_SYNCTEX_PATH): {e}"))?;
    if !output.status.success() {
        return Err(format!("SyncTeX failed: {}", decode_output(&output.stderr)));
    }
    Ok(decode_output(&output.stdout))
}

#[tauri::command]
pub async fn synctex_forward(request: ForwardRequest) -> Result<Position, String> {
    if request.line == 0 {
        return Err("Source line must be positive".into());
    }
    position(
        &run(
            &request.pdf,
            &[
                "view".into(),
                "-i".into(),
                format!("{}:0:{}", request.line, request.source),
                "-o".into(),
                request.pdf.clone(),
            ],
        )
        .await?,
    )
}

fn source_location(text: &str, pdf: &Path) -> Result<(PathBuf, u32), String> {
    let source = field(text, "Input:")
        .filter(|s| !s.is_empty())
        .ok_or("No source found in SyncTeX data")?;
    let line = field(text, "Line:")
        .and_then(|s| s.parse::<u32>().ok())
        .filter(|n| *n > 0)
        .ok_or("No source line found")?;
    let source = Path::new(source);
    let source = if source.is_absolute() {
        source.to_owned()
    } else {
        pdf.parent().ok_or("No PDF directory")?.join(source)
    };
    let source = source
        .canonicalize()
        .map_err(|_| "The TeX source file could not be found on this computer")?;
    if !source.is_file() {
        return Err("SyncTeX source is not a file".into());
    }
    Ok((source, line))
}

#[tauri::command]
pub async fn synctex_inverse(pdf: String, page: u32, x: f64, y: f64) -> Result<(), String> {
    if page == 0 || !x.is_finite() || !y.is_finite() || x < 0.0 || y < 0.0 {
        return Err("Invalid PDF position".into());
    }
    let output = run(
        &pdf,
        &["edit".into(), "-o".into(), format!("{page}:{x}:{y}:{pdf}")],
    )
    .await?;
    let (source, line) = source_location(&output, Path::new(&pdf))?;
    let mut candidates: Vec<PathBuf> = std::env::var_os("KOMODO_VSCODE_PATH")
        .map(PathBuf::from)
        .into_iter()
        .collect();
    #[cfg(windows)]
    for (variable, suffix) in [
        ("LOCALAPPDATA", "Programs/Microsoft VS Code/Code.exe"),
        ("ProgramFiles", "Microsoft VS Code/Code.exe"),
    ] {
        if let Some(root) = std::env::var_os(variable) {
            candidates.push(PathBuf::from(root).join(suffix));
        }
    }
    #[cfg(not(windows))]
    candidates.push(PathBuf::from("/usr/bin/code"));
    let editor = candidates.into_iter().find(|p| p.is_file()).ok_or(
        "VS Code not found. Set KOMODO_VSCODE_PATH to the VS Code executable and restart Komodo.",
    )?;
    // Canonical Windows paths may have the extended-length prefix, which Code's CLI does not expect.
    let path = source.to_string_lossy();
    let path = if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(&path).to_owned()
    };
    let mut command = tokio::process::Command::new(editor);
    command.args(["--reuse-window", "--goto", &format!("{path}:{line}:1")]);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not open VS Code: {e}"))?;
    tauri::async_runtime::spawn(async move {
        let _ = child.wait().await;
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn utf8_paths_remain_intact() {
        assert_eq!(
            decode_output("Input:C:/日本語/test.tex".as_bytes()),
            "Input:C:/日本語/test.tex"
        );
    }
    #[tokio::test]
    #[ignore = "Requires a local TeX fixture at KOMODO_TEST_SYNCTEX_PDF"]
    async fn real_synctex_roundtrip() {
        let pdf = std::env::var("KOMODO_TEST_SYNCTEX_PDF").unwrap();
        let source = Path::new(&pdf)
            .with_extension("tex")
            .to_string_lossy()
            .into_owned();
        let result = synctex_forward(ForwardRequest {
            pdf: pdf.clone(),
            source: source.clone(),
            line: 5,
        })
        .await
        .unwrap();
        assert_eq!(result.page, 2);
        let text = run(
            &pdf,
            &[
                "edit".into(),
                "-o".into(),
                format!("{}:{}:{}:{}", result.page, result.x, result.y, pdf),
            ],
        )
        .await
        .unwrap();
        let (path, line) = source_location(&text, Path::new(&pdf)).unwrap();
        assert_eq!(path, Path::new(&source).canonicalize().unwrap());
        assert_eq!(line, 5);
    }
    #[test]
    fn parses_arguments_without_splitting_paths() {
        let a = ["app", "--forward-search", "a b.tex", "42", "a b.pdf"].map(str::to_string);
        let r = from_args(&a, &std::env::temp_dir()).unwrap();
        assert_eq!(r.line, 42);
        assert!(r.source.ends_with("a b.tex"));
        assert!(from_args(
            &["app", "--forward-search", "x", "0", "x.pdf"].map(str::to_string),
            Path::new(".")
        )
        .is_none());
    }
    #[test]
    fn parses_first_match_and_rejects_nonfinite_coordinates() {
        let p = position("SyncTeX result begin\nPage:2\nx:10.5\ny:99\nPage:3\nx:4\ny:5").unwrap();
        assert_eq!(p.page, 2);
        assert_eq!(p.x, 10.5);
        assert_eq!(p.y, 99.0);
        assert!(position("Page:1\nx:NaN\ny:5").is_err());
        assert!(position("No result").is_err());
    }
}
