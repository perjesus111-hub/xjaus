# XJAUS

[Español](README.es.md)

XJAUS is an independent desktop client for Xbox Cloud Gaming and Xbox Remote Play. Its controller-oriented interface runs in Electron, with a Rust sidecar for authentication and stream control. Cloud availability depends on Microsoft service eligibility, region and account; Remote Play requires a compatible console configured for remote features.

## Navigation

- [1.2.4 status](#124-status)
- [Releases and downloads](#releases-and-downloads)
- [Platform matrix](#platform-matrix)
- [Source and validation](#source-and-validation)
- [CI and checks](#ci-and-checks)
- [Support and contribution](#support-and-contribution)
- [License and acknowledgments](#license-and-acknowledgments)
- [Disclaimer](#disclaimer)

## 1.2.4 status

- **State:** Source preparation for v1.2.4 (PR #12, branch `private/xjaus-1.2.4`, commit `ed1b6b0`). Not a release.
- **Targets:** Linux x86-64 (AppImage, RPM, DEB) and Windows x64 (NSIS EXE, MSI). Configured targets are not tested-platform guarantees.
- **Authentication:** In-memory only; restarting requires interactive sign-in. Sign-out invalidates local auth and attempts legacy cleanup without claiming server-side revocation. See [Privacy](PRIVACY.md).
- **Streaming:** Gamepad navigation, favorites, optional diagnostics. Resolution up to 1440p, 15–45 Mbps, codec preferences are requests, not measured outcomes. Hardware decoding depends on negotiated stream, runtime, and driver.
- **Linux sandbox:** Do not use `--no-sandbox` to work around an unavailable user-namespace check. AppImage differential updates (`.zsync`) are disabled for distribution.

## Releases and downloads

### Latest published release: v1.2.3

- **GitHub Release:** [v1.2.3](https://github.com/perjesus111-hub/xjaus/releases/tag/v1.2.3) (2026-11-15)
- **Artifacts (Linux x86-64):**
  - AppImage: [`XJAUS-1.2.3-x86_64.AppImage`](https://github.com/perjesus111-hub/xjaus/releases/download/v1.2.3/XJAUS-1.2.3-x86_64.AppImage) (sha256: `45d9e25a3710856ad283b612649ffca67fe4acc1c5b53cfd4f815359a3a3f814`)
  - RPM: [`XJAUS-1.2.3-linux-x86_64.rpm`](https://github.com/perjesus111-hub/xjaus/releases/download/v1.2.3/XJAUS-1.2.3-linux-x86_64.rpm) (sha256: `1c7332f11feca9697565870e01647d495ed3a350139a625b4ed83f1124bfe777`)
  - DEB: [`XJAUS-1.2.3-linux-amd64.deb`](https://github.com/perjesus111-hub/xjaus/releases/download/v1.2.3/XJAUS-1.2.3-linux-amd64.deb) (sha256: `9fd72c64e38390973a0541126fd9c4fa9facfe48c352d77c82d3bd34a555bae7`)
  - AppImage `.zsync`: [`XJAUS-1.2.3-x86_64.AppImage.zsync`](https://github.com/perjesus111-hub/xjaus/releases/download/v1.2.3/XJAUS-1.2.3-x86_64.AppImage.zsync) (experimental, unsigned)
  - Checksums: [`SHA256SUMS`](https://github.com/perjesus111-hub/xjaus/releases/download/v1.2.3/SHA256SUMS)
- **Windows:** Not included in this release.
- **Notes:** Static type-2 AppImage runtime (no `libfuse2` required), system theme support, experimental `.zsync` chain. See release body for full details.

### v1.2.4 candidate (this PR)

- No download artifacts published. This PR prepares source only.
- Linux packaging path: `npm run dist:linux` (Docker, digest-pinned Debian trixie `node:24.22.3-trixie-slim@sha256:af02d57b...`, Rust 1.96.0).
- Windows packaging: see [WINDOWS-BUILD.md](WINDOWS-BUILD.md). Native Windows QA not performed; no signature.

### Historical: v1.2.1

- [GitHub Release v1.2.1](https://github.com/perjesus111-hub/xjaus/releases/tag/v1.2.1)
- Validation report: `docs/validation-1.2.1.md`
- Release notes: `docs/release-notes-1.2.1.md`

## Platform matrix

| Platform | Artifacts | CI build verified | Local QA (this PR) | Signed | Notes |
|----------|-----------|-------------------|---------------------|--------|-------|
| Linux x86-64 | AppImage, RPM, DEB | ✅ Yes (ed1b6b0) | ✅ FUSE direct mount + DEB/RPM install & launch in QEMU VMs (Debian/Fedora) — [evidence](/var/tmp/xjaus-guest.vPJhhj/evidence.txt) | ❌ No | Static type-2 AppImage runtime; sandbox enforced; no `.zsync` |
| Windows x64 | NSIS EXE, MSI | ✅ Source build & tests | ❌ No (Wine smoke-test only) | ❌ No | Separate Cargo manifest (`backend-windows`); no native installer validation |

**Honest status:** Linux FUSE/DEB/RPM build passed CI in commit `ed1b6b0` (CI run 44950533288). Local packaging verified FUSE mount, DEB/RPM install and app launch in QEMU VMs (Debian 13/Fedora 44) — see evidence. Windows NSIS/MSI compile and pass source tests but have **no native Windows QA and no signature**. Do not claim native Windows validation.

## Source and validation

- CI workflow (source): [.github/workflows/validation.yml](.github/workflows/validation.yml) — Node 24, separate Cargo manifests for Linux (`src-tauri`) and Windows (`backend-windows`).
- Source checks: [CONTRIBUTING.md](CONTRIBUTING.md)
- Architecture boundaries: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Linux packaging (local): `npm run dist:linux` (Docker, not part of CI source validation)
- Windows build instructions: [WINDOWS-BUILD.md](WINDOWS-BUILD.md)
- Rollback procedure: [docs/ROLLBACK.md](docs/ROLLBACK.md)

Packaging is separate from source validation and does not authorize running or distributing its outputs.

## CI and checks

| Check | Linux (ubuntu-24.04) | Windows (windows-2025) |
|-------|---------------------|------------------------|
| Version metadata | ✅ | ✅ |
| Frontend tests (Vitest 337) | ✅ | ✅ |
| Electron tests (56) | ✅ | ✅ |
| Linux backend (Rust) | ✅ | — |
| Windows backend (Rust) | — | ✅ |
| Packaging simulation | ✅ (synthetic) | — |
| Release simulation | ✅ (synthetic) | — |

**Latest CI run:** [45055705437](https://github.com/perjesus111-hub/xjaus/actions/runs/45055705437) — all 4 jobs PASS.

## Support and contribution

- **Issues:** Include distribution, desktop session (Wayland/X11), GPU/driver, package version, controller model, and whether the problem affects cloud gaming or Remote Play. Distinguish selected profile from actual received video dimensions and decoder statistics. Never attach access tokens, account caches, or unredacted authentication logs.
- **Security:** See [SECURITY.md](SECURITY.md) for responsible disclosure.
- **Contributing:** Source checks and workflow in [CONTRIBUTING.md](CONTRIBUTING.md). PRs target `main`; version bumps follow the release preparation process.

## License and acknowledgments

XJAUS is distributed under the GNU General Public License version 3. See [LICENSE](LICENSE). Preserve upstream copyright and license notices when redistributing or modifying the project.

Protocol and implementation research references xal-node (including its Device Code authentication flow in msal.ts), xbox-xcloud-player and OpenXbox projects. Third-party dependencies retain their own licenses. Microsoft/Xbox names, game artwork and console imagery are not relicensed under the GPL by this repository; redistribution permissions for bundled visual assets must be reviewed before a public release.

Based on the original architecture and authentication behavior by the Greenlight contributors, licensed under GPL-3.0.

## Disclaimer

XJAUS is an independent open-source project and is not affiliated, sponsored, or endorsed by Microsoft or Xbox.