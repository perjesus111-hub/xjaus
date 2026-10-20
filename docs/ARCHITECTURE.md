# Architecture

## Runtime boundary

XJAUS ships an Electron desktop application and a Rust executable sidecar.

1. **Renderer (`src/`)** — Vite compiles the TypeScript user interface. It owns display state, input presentation, gamepad navigation, stream UI, and WebRTC-facing browser work.
2. **Electron main process (`electron/main.cjs`)** — creates the isolated browser window, starts and stops the sidecar, and mediates IPC. It disables Node integration, enables context isolation and sandboxing, denies permission requests, blocks new windows and navigation, and limits external URLs.
3. **Preload (`electron/preload.cjs`)** — exposes a small `window.xjaus` API. Commands and fullscreen actions are allowlisted before they reach the main process.
4. **Rust sidecar (`src-tauri/src/bin/xjaus_backend.rs`)** — receives newline-delimited JSON requests over stdin and writes JSON replies to stdout. It owns device-code authentication, encrypted/OS-backed token storage, console discovery, session lifecycle, stream signaling, settings, and cancellation.

The main process validates both the sender frame and the command before forwarding a request. The sidecar independently validates its command list. This duplicated allowlist is deliberate: the renderer does not receive a generic IPC transport and the backend does not accept arbitrary commands.

## Data flow

```text
Renderer -> preload allowlist -> Electron IPC authorization
         -> Rust sidecar stdin JSON -> Xbox/service APIs
Renderer <- preload result    <- Electron pending request map
         <- Rust sidecar stdout JSON
```

The sidecar is spawned with `shell: false`; Electron does not forward sidecar stderr to the renderer. On shutdown, Electron ends stdin and kills the child if needed.

## Why `src-tauri/` remains

`src-tauri/` is not dead packaging clutter. It contains the Rust application modules and the `xjaus_backend` binary used by Electron. Its retained Tauri library target and configuration preserve the original application path and make the sidecar share code with the prior Tauri integration. As a result, Linux Rust builds need the Tauri/WebKitGTK native development dependencies even though release packages use Electron for the visible UI.

Do not remove or rewrite `src-tauri/` merely because the distributed interface is Electron. Any architectural simplification needs an explicit dependency and packaging review.

## Packaging

- `scripts/build-linux.cjs` builds the Linux sidecar used by AppImage, RPM, and DEB packaging.
- `scripts/build-windows.cjs` cross-builds and stages the Windows sidecar for the NSIS installer.
- `electron/backend-path.cjs` resolves the platform-specific packaged sidecar path.
- `WINDOWS-BUILD.md` documents the Linux-hosted Windows x64 packaging path and its limitations.

Renderer output goes to `dist/`; release artifacts go under `release/`. Both are ignored by Git.