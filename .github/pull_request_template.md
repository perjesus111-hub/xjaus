## Summary

<!-- Explain the maintenance or user-facing reason for this change. -->

## Validation

- [ ] `npm ci`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --bin xjaus_backend`
- [ ] Not run (explain why below)

## Scope

- [ ] Renderer/UI
- [ ] Electron main/preload/security boundary
- [ ] Rust sidecar
- [ ] Linux packaging
- [ ] Windows packaging
- [ ] Documentation/community files

## Checklist

- [ ] I kept the change focused and documented any platform I could not test.
- [ ] I did not add tokens, account caches, credentials, or private logs.
- [ ] I did not claim compatibility, performance, or verification I did not observe.
- [ ] I updated relevant tests or documentation.
- [ ] I did not publish a release, change the license, or alter release artifacts.

## Notes for reviewers

<!-- Call out compatibility concerns, follow-up work, or deliberate limitations. -->