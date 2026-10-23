# Windows x64 packaging (Linux cross build)

## Build

From this directory on a Linux host with Node/npm, Rust, Wine and MinGW-w64:

```sh
rustup target add x86_64-pc-windows-gnu
npm ci
npm test
npm run build:win
```

`build:win` runs `electron-builder --win --x64 --publish never`; the committed
Windows target list selects both the NSIS `.exe` installer and the MSI target.
Its npm pre-hook builds the frontend and the real Rust sidecar before packaging.
`release/win/` is deliberately outside Vite's `dist/`.

For long builds on this Fedora host, run through a user systemd unit with
`MemoryMax=infinity`, `MemoryHigh=infinity`, `Nice=5`, the project as working
directory, and PATH inherited. Set WINEPREFIX to a disposable, user-owned
scratch directory; do not reuse a Wine prefix that may contain account data.

Expected outputs are `release/win/XJAUS-<version>-win-x64-setup.exe` and
`release/win/XJAUS-<version>-win-x64-setup.msi`. Both installers are configured
per-user. NSIS uses an interactive wizard and directory chooser; MSI uses the
Windows Installer UI. The NSIS bootstrap is PE32 (x86); its **app-64.7z payload**,
Electron application and Rust backend are x64 / PE32+. Bootstrap architecture is
not the installed application's architecture.

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

### Windows 1.2.1 status (local, not native-Windows validation)

The following 1.2.1 installers were generated locally and passed 7-Zip container
integrity checks:

- `release/win/XJAUS-1.2.1-win-x64-setup.exe` — 115,137,563 bytes; SHA-256 `c22be927bcdc34b1b0b1d4b8ebae2b1fee46c578f447e795c842d00be958f5d2`; NSIS installer.
- `release/win/XJAUS-1.2.1-win-x64-setup.msi` — 396,742,144 bytes; SHA-256 `b6b81a2d4731ef317f0cb1cd78fcd8e79abfcde6348dd074d4eeca16a49e866c`; MSI package with x64 template.

The EXE payload was extracted and the packaged application was smoke-tested under
Wine/Xvfb. The MSI was installed in a disposable Wine prefix and its packaged UI
was opened under Xvfb. These are not native Windows tests. The NSIS bootstrap is
PE32/x86 as expected; the installed app and Rust backend payload are x64. No code
signing certificate was applied or verified. Treat the MSI as a local candidate,
not a public-ready installer, until native Windows install/upgrade/uninstall and
signing checks are complete. Neither installer was used for a real Xbox OAuth or
Remote Play test. See `docs/validation-1.2.1.md` and `release/SHA256SUMS` for the
current test matrix and checksums.

The final integrated run on 23 October 2026 passed 113/113 Windows-target Rust
tests under the disposable Wine prefix. Cargo emitted four non-fatal warnings
about an unused assignment/variables and dead code. This validates the cross-target
test binary under Wine only; it does not establish native Windows compatibility.

### Earlier packaging evidence (not a 1.2.1 installer claim)

A prior Windows packaging exercise verified frontend/Electron tests, Linux Rust
tests, Windows-target Rust tests under an isolated Wine prefix, NSIS archive
extraction, matching packaged backend/ASAR bytes, PE architecture, DLL imports,
and no ELF or native Node modules in the shipped application. A Wine/Xvfb smoke
probe of that earlier packaged Windows Electron application confirmed the loaded
page, preload IPC bridge, unauthenticated status, and synthetic settings. This is
**not native Windows testing** and does not establish real Xbox login, controller,
GPU, or streaming behavior; those results do not certify the 1.2.1 package.

The earlier installer/application/sidecar were unsigned. No signing certificate
was used or requested. An earlier `npm audit` reported 8 moderate development-
toolchain findings; no force-upgrade was applied. These are historical results,
not a fresh 1.2.1 audit.

An earlier wake-deadline test with a 50 ms real-time network budget failed once
under parallel load and passed on serial reruns; production wake behavior was not
changed. This historical observation does not replace the 1.2.1 integrated test
results recorded for the release candidate.

Primary documentation consulted: electron-builder's Multi Platform Build, MSI,
NSIS, and architecture documentation; Microsoft Win32 security API documentation
for protected DACLs. Wine is needed for Windows packaging; Mono is not required
for NSIS. Actual local electron-builder version: 26.15.3.
