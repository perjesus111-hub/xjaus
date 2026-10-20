# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for a suspected vulnerability, especially if it could expose authentication data, local files, IPC access, package integrity, or a reproducible exploit.

Use GitHub's private security-advisory reporting for this repository when the option is available. If private reporting is unavailable, use a private contact method listed by the repository owner. Include a minimal reproduction, affected version or commit, impact, and any mitigation you found. Do not include real access tokens, account caches, or unredacted credentials.

## Scope

Reports are particularly useful for the Electron renderer/preload/main boundary, Rust-sidecar IPC, token storage, external-link handling, release artifacts, and dependency supply chain.

## Response expectations

This repository does not promise a response or remediation timeline. Maintainers will assess credible reports privately, coordinate a fix when feasible, and credit reporters only with their consent.