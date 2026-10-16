# Windows PDF file opening

Windows installers register Komodo PDF as an available PDF handler. They do not
choose the user's default app. An unpackaged executable does not register itself.

The NSIS hook supports the selected current-user or all-users scope. The MSI WiX
fragment uses the per-machine scope of Tauri's MSI template. Both register the
same application-specific ProgID, `OpenWithProgids`, application capabilities and
`RegisteredApplications`, with a quoted executable and quoted `%1` argument.
Uninstall removes Komodo's own registration. The extension's default value and
Windows `UserChoice` are left alone.

These custom installer definitions are intentional: Tauri 2.11.2's generic NSIS
`fileAssociations` macro writes the extension's default value and does not create
the capabilities registration used here. Do not add a parallel generic `.pdf`
association without reviewing those effects.

## Runtime behavior

Windows single-instance notifications are handed to a serial worker immediately.
The synchronous WM_COPYDATA callback does not access windows or emit webview
events: during startup those operations can reenter Tauri while its window locks
are held. The worker preserves request order and performs the wake-up and focus
operations after the callback has returned.

On Windows the process sets its explicit AppUserModelID from the configured
application identifier before creating any windows. NSIS shortcuts and both
installers' PDF ProgIDs use the same identity, so Explorer/PDF launches can group
with the pinned application. Existing pins pointing to an older or virtualized
installation may also need their target updated to the current installed executable.

The initial process arguments and Windows single-instance callback feed a native
queue. The callback uses the **launching process's** working directory. Native
paths are preserved, including spaces, Unicode, percent signs and `#`; `file:`
URLs are decoded using `url::Url::to_file_path`. Non-file URLs, flags and non-PDF
arguments are ignored. URL query strings and fragments are not supported.

The webview subscribes before draining the queue, so an event sent before React
mounts is harmless. The filesystem plugin grants access only to each requested
file when drained, after plugin initialization. Manual and native requests share
a serialized loader, which hashes bytes before PDF.js transfers them and disposes
of a document when its tab closes. Each new path opens in a separate tab; opening
an existing path focuses that tab. A batch leaves the last successfully opened
PDF active. A failed file does not block the next file.

## Automated checks

```sh
npm ci
npm test
npm run build
python3 scripts/check-windows-associations.py
npx playwright test
cargo test --manifest-path src-tauri/Cargo.toml open_requests
```

The Rust command needs Tauri's platform dependencies. Run it on Windows to execute
the drive-letter, UNC and Windows file-URL test as well. The browser fixtures mock
Tauri IPC while using real PDF.js rendering; they do not exercise Explorer,
WebView2, native IPC or the Windows registry.

## Remaining Windows acceptance checks

Use a test VM and build both installers from this branch with `npm run tauri build`.
Test NSIS current-user and all-users installs, and MSI per-machine installation
separately, including upgrade from 0.1.2 and uninstall/reinstall. Avoid mixing MSI
and NSIS installations in the same scope during these checks.

- Record the existing PDF handler. Install Komodo, check that it is offered in
  Settings > Apps > Default apps and in PDF > Open with. Verify that installation
  has preserved the previous default. Use Open with once for the opening tests.
- With Komodo closed, open a PDF with an ordinary path, then one such as
  `C:\Users\Test User\Documents\日本語 資料\100%20 #1.pdf`. The requested PDF
  should render without choosing a file in Komodo's dialog.
- Repeat with Komodo already running and minimized. The same instance should
  restore, gain focus where Windows permits it, and display the requested PDF.
- Launch multiple PDFs quickly during startup and after startup. Also pass
  several quoted file paths to the executable. Every request should be consumed
  in order and the last successful PDF should remain visible.
- Run the executable from a different working directory with a relative PDF path;
  verify that the sender's directory is used for a second launch.
- Try a `file:///C:/...` URL with encoded spaces/Unicode and an accessible UNC path
  or `file://server/share/...` URL. Network access/permissions are external factors.
- Try an unreadable, deleted or malformed PDF, then a valid PDF. Errors should be
  visible and the next request should work. Confirm the manual Open PDF flow too.
- Uninstall. Komodo's candidate/capability entries should disappear, other PDF
  handlers should remain, and the extension default must not be rewritten by the
  uninstaller. Windows may independently repair a user's choice if it had pointed
  to an application that is now removed.

## Evidence and references

At dev base `2c96693a8375d8ec898a31ab2db8b09d613a47cc`, `lib.rs` registered no
single-instance plugin, never read process arguments, and exposed no file-open
handoff command. PDF opening existed only inside Toolbar's dialog handler.
`tauri.conf.json` contained neither PDF associations nor custom registration.
These are confirmed omissions; the original user's installed version, Windows
registry and exact failure UI were not available for inspection in the cloud.

- [Tauri single-instance lifecycle and callback](https://v2.tauri.app/plugin/single-instance/)
- [Tauri configuration](https://v2.tauri.app/reference/config/)
- [Microsoft application registration](https://learn.microsoft.com/en-us/windows/win32/shell/default-programs#registering-an-application-for-use-with-default-programs)
  describes Capabilities, ProgIDs and RegisteredApplications; its legacy API/UI
  guidance is not a substitute for testing Windows 10/11 Settings.
- [Tauri 2.11.2 NSIS installer](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.2/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi)
- [Tauri 2.11.2 association macro](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.2/crates/tauri-bundler/src/bundle/windows/nsis/FileAssociation.nsh)
- [Tauri 2.11.2 MSI template](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.2/crates/tauri-bundler/src/bundle/windows/msi/main.wxs)

## Local Windows validation (2026-10-16)

Integrated the fix into local dev `d9ff1aa` (which includes direct ChatGPT sign-in),
preserving the existing uncommitted ChatGptSettings.tsx byte for byte. Dependency
and browser-fixture conflicts retain both the authentication and PDF-opening work.

The actual MSI build exposed ICE69: Tauri puts external components in a different
feature from its `Path` file component. The association fragment now uses the
quoted `[INSTALLDIR]komodo-pdf.exe` path instead of a cross-feature `[#Path]`
reference. A regression check covers that restriction.

Validation performed on this PC:

- Production TypeScript/Vite and native Windows release builds passed.
- MSI, NSIS current-user, and NSIS both-scope installers were generated. MSI
  retains warnings from Tauri's standard template; ICE69 is resolved.
- Updated the existing NSIS current-user installation from registered version
  0.1.1 to 0.1.2 using the generated current-user installer (exit code 0).
- Windows Shell enumerates the installed Komodo executable as a PDF handler.
  RegisteredApplications, Capabilities, OpenWithProgids, and the quoted ProgID
  command point to the installed app. An older manual Applications registration
  for the development executable remains present.
- The existing Foxit PDF UserChoice (including its hash) and extension default
  were identical before and after installation.
- Real WebView2 checks passed through the registered ProgID using ShellExecuteEx:
  cold launch of a Japanese/space/percent/hash path, another PDF while minimized
  with the same process restored, a relative path from the second launch's working
  directory, a correctly escaped file URL, a missing-file error, and recovery on
  the next valid request. UI Automation verified the distinct rendered PDF text.
- Unit tests: 16 passed. Installer static checks: 5 passed. Windows Rust
  open_requests tests: 4 passed, including drive/UNC parsing.
- Browser suite: 18 passed and the cold-start test hit the default 30-second
  budget during concurrent compilation. Re-running both association browser
  tests with a 60-second budget passed (2/2), covering all 19 distinct cases.

Not exercised on this PC: all-users/MSI installation or uninstall/reinstall,
live network UNC file access, and visual interaction with the Windows Settings
default-app picker. Candidate enumeration and capabilities registration were
verified without changing the selected default app. Those wider installer checks
remain suitable for an isolated Windows VM.
