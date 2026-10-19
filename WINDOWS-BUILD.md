# Windows x64 packaging (Linux cross build)

## Build

From this directory on a Linux host with Node/npm, Rust, Wine and MinGW-w64:

```sh
rustup target add x86_64-pc-windows-gnu
npm ci
npm test
npm run build:win
```

`build:win` is exactly `electron-builder --win nsis --x64`.
Its npm pre-hook builds the frontend and the real Rust sidecar before packaging.
`release/win/` is deliberately outside Vite's `dist/`.

For long builds on this Fedora host, run through a user systemd unit with
`MemoryMax=infinity`, `MemoryHigh=infinity`, `Nice=5`, the project as working
directory, and PATH inherited. Set WINEPREFIX to a disposable directory under
`/home/Greg/.hermes/cache/scratch/`, not a credential-bearing Wine prefix.

Output: `release/win/XJAUS-0.1.0-win-x64-setup.exe`.
NSIS uses an interactive wizard, per-user installation and a directory chooser.
The standard NSIS bootstrap is PE32 (x86); its **app-64.7z payload**, Electron
application and Rust backend are x64 / PE32+. Bootstrap architecture is not the
installed application's architecture.

## Backend and production resources

`backend-windows/Cargo.toml` is a headless manifest pointing to the existing
`src-tauri/src/bin/xjaus_backend.rs`; it does not pull Tauri/WebView2 GUI build
dependencies into the Electron sidecar. Shared authentication, catalog, session,
cancellation, wake and subscription code remains the same. Windows-specific
storage implementations use LOCALAPPDATA, atomic replacement, protected per-user
ACLs and Windows Credential Manager (no environment-derived fallback vault).
The Windows profile-cache implementation retains the profile module's portable
logic/tests; keep portable profile changes synchronized with `profile.rs`.
Linux's original storage modules, backend build and launcher are unchanged.

`electron/backend-path.cjs` chooses `resources/bin/xjaus_backend.exe` on Windows,
and retains the Linux backend filename/path. The child has `windowsHide: true`.

`scripts/build-windows.cjs` uses the GNU Rust target and MinGW linker, validates
PE/x64, stages only the backend and explicitly needed GNU runtime DLLs, and
records imports at `build/windows/backend-imports.json`. The current backend
imports Windows OS/API-set DLLs only; no extra MinGW runtime DLL is required.

Packaging allowlist: frontend `dist`, Electron `.cjs` runtime files (not tests),
PNG window icons, package metadata and npm production dependencies. The only
extra Windows resources are the staged `.exe` / runtime `.dll` files. Source
Cargo trees, credentials, home/profile directories and Linux ELF files are not
packaged. Production npm dependencies have no native `.node` modules, so there
is no Windows Node prebuild to fetch/rebuild; native host build-tool modules
remain development-only. The ICO is a multi-size conversion of the user's
existing `resources/icon_source.png`, with no new artwork.

## Verification and limitations

Build/test logs and detailed audits from this packaging run are stored in
`/home/Greg/.hermes/cache/scratch/xjaus-windows/` (scratch is automatically
pruned when idle; retain important evidence elsewhere if needed).

Verified: frontend and Electron tests, Linux Rust tests, Windows-target Rust
tests executed under an isolated Wine prefix, actual NSIS archive extraction,
matching packaged backend/ASAR bytes, PE architecture, DLL imports, and no ELF
or native Node modules in the shipped application. A Wine/Xvfb smoke probe of
the exact packaged Windows Electron application confirmed a fully loaded XJAUS
page, the real preload IPC bridge, the Windows Rust backend's unauthenticated
status and stored synthetic settings. This is **not native Windows testing**
and does not establish real Xbox login, controller, GPU or streaming behavior.
Wine was launched with disposable user data, no sandbox and GPU disabled only
for the smoke test; those flags are not part of the application configuration.

The installer, application and sidecar are unsigned: their Authenticode
certificate-directory fields are zero. Windows may show publisher/SmartScreen
warnings. No signing certificate was used or requested. npm audit reported
8 moderate development-toolchain findings; no force-upgrade was applied.

The existing wake-deadline test has a 50 ms real-time network budget and failed
once under parallel build/test load on both Wine and Linux. Full serial reruns
passed; production wake behavior and that test were not changed.

Primary documentation consulted: electron-builder's Multi Platform Build,
NSIS and architecture documentation on electron.build; Microsoft Win32 security
API documentation for protected DACLs. Wine is needed for Windows packaging;
Mono is not required for NSIS. Actual local electron-builder version: 26.15.3.
