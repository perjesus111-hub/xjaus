# Contributing to XJAUS

## Before opening a pull request

- Search existing issues and pull requests.
- Keep a change focused. Do not mix renderer polish, streaming behavior, packaging, and dependency upgrades without a reason.
- Do not include access tokens, account caches, device-code responses, private logs, or user data.
- Preserve the Electron security boundary and Rust-sidecar command allowlists unless the change explicitly tests both sides.

## Local checks

```sh
npm ci
npm run typecheck
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --bin xjaus_backend
```

The Rust command requires Linux native development packages for the retained Tauri/WebKitGTK project. If your environment cannot provide them, say so in the pull request instead of claiming the check passed.

## Reporting streaming problems

Use the bug report template and include:

- package version and installation method;
- distribution and version, plus Wayland or X11;
- GPU and driver;
- controller model/connection where relevant; and
- Cloud Gaming or Remote Play.

Report received video dimensions and decoder telemetry separately from the settings you selected. Redact private data before attaching logs or screenshots.

## Pull request expectations

Explain the user-facing or maintenance reason for the change, list the checks you actually ran, and call out untested platforms. Do not publish a release or change the license as part of a pull request without maintainer approval.