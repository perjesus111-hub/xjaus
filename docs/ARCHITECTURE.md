# Architecture

| Layer | Code | Responsibility |
| --- | --- | --- |
| Renderer | `src/`, `index.html`, `public/login.html` | UI, preferences, WebRTC media and input; calls the backend through `src/backend.ts`. |
| Electron trust boundary | `electron/preload.cjs`, `electron/main.cjs`, `electron/security.cjs` | Narrow renderer API, IPC validation, desktop lifecycle and Rust sidecar supervision. |
| Electron sidecar | `src-tauri/src/bin/xjaus_backend.rs` | JSON requests over process stdio, authentication and session lifecycle. Linux builds from `src-tauri/Cargo.toml`; Windows builds the same entry point from `backend-windows/Cargo.toml`. |
| Retained Tauri runner | `src-tauri/src/lib.rs` | Native command bridge sharing Rust service modules; not the Electron distribution. |
| Packaging | `package.json`, `scripts/packaging.cjs`, `scripts/build-windows.cjs` | Renderer assets and platform sidecar are inputs; package verification and release authorization are separate. |

Auth and stream attempt identities are distinct. Review admission, cancellation, late responses and logout across both runners; rejecting a late response locally does not establish remote cleanup. Keep credentials on the trusted side of the bridge and sanitize diagnostic exports separately from UI errors. Read [privacy](../PRIVACY.md) before capturing fixtures or diagnostics.
