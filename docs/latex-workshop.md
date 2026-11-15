# VS Code / LaTeX Workshop

Komodo supports local SyncTeX in both directions on Windows. Install TeX Live or
MiKTeX with `synctex` on PATH, compile with `-synctex=1`, and keep the matching
`.synctex.gz` (or `.synctex`) next to the generated PDF. Restart Komodo after PATH
changes. This does not upload your source or PDF.

Add the following to VS Code's `settings.json`, replacing the executable path
with your installed or portable Komodo executable. No settings are changed automatically.

```json
{
  "latex-workshop.view.pdf.viewer": "external",
  "latex-workshop.view.pdf.external.viewer.command": "C:/path/to/komodo-pdf.exe",
  "latex-workshop.view.pdf.external.viewer.args": ["%PDF%"],
  "latex-workshop.view.pdf.external.synctex.command": "C:/path/to/komodo-pdf.exe",
  "latex-workshop.view.pdf.external.synctex.args": [
    "--forward-search", "%TEX%", "%LINE%", "%PDF%"
  ]
}
```

- **Source → PDF:** run LaTeX Workshop's `SyncTeX from cursor` command. Komodo
  reuses its running window, opens/activates the PDF tab, scrolls to the matching
  location and briefly highlights it. Cold starts are queued until the reader is ready.
- **PDF → source:** Ctrl+double-click the typeset text. Komodo opens the matched
  file and line in the existing VS Code window. Ordinary double-click still selects text.
- **Compiler output changes:** use Komodo's PDF reload controls; SyncTeX data and
  PDF must come from the same build. Do not move just the PDF away from its source project.

The usual per-user and system VS Code installs are detected. For a custom install,
set `KOMODO_VSCODE_PATH` to the actual `Code.exe` (not `code.cmd`) before starting
Komodo. `KOMODO_SYNCTEX_PATH` similarly selects a custom SyncTeX executable.
Missing tools, missing sources, missing/stale SyncTeX data and failed matches show
an error instead of silently claiming a successful jump. SyncTeX processes have a
10-second timeout. Commands use argument arrays, not a shell; `SYNCTEX_EDITOR` and
`SYNCTEX_VIEWER` are explicitly removed so they cannot launch extra commands.
Both UTF-8 output and the Windows ANSI output used by older TeX Live versions are
supported, including Japanese source paths.

## Scope

Designed for ordinary locally generated TeX PDFs. Remote WSL/container source
paths are not mapped to Windows paths. A separate SyncTeX auxiliary directory is
not currently supported. Post-processing/cropping the PDF can invalidate the
mapping; rebuild rather than using a transformed PDF. SyncTeX often resolves to a
nearby source line, not an exact character. Windows single-instance forwarding is
supported; other platforms require further native testing.

Configuration follows the upstream [LaTeX Workshop external viewer documentation](https://github.com/James-Yu/LaTeX-Workshop/wiki/View).
