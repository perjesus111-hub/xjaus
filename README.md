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

- **State:** Released v1.2.4 (2026-11-23). Linux packages published; Windows installers configured but not natively validated.
- **Targets:** Linux x86-64 (AppImage, RPM, DEB) and Windows x64 (NSIS EXE, MSI). Configured targets are not tested-platform guarantees.
- **Authentication:** In-memory only; restarting requires interactive sign-in. Sign-out invalidates local auth and attempts legacy cleanup without claiming server-side revocation. See [Privacy](PRIVACY.md).
- **Streaming:** Gamepad navigation, favorites, optional diagnostics. Resolution up to 1440p, 15–45 Mbps, codec preferences are requests, not measured outcomes. Hardware decoding depends on negotiated stream, runtime, and driver.
- **Linux sandbox:** Do not use `--no-sandbox` to work around an unavailable user-namespace check. AppImage differential updates (`.zsync`) are disabled for distribution.

## Releases and downloads

### Latest published release: v1.2.4

- **GitHub Release:** [v1.2.4](https://github.com/perjesus111-hub/xjaus/releases/tag/v1.2.4) (2026-11-23)
- **Artifacts (Linux x86-64):**
  - AppImage: [`XJAUS-1.2.4-x86_64.AppImage`](https://github.com/perjesus111-hub/xjaus/releases/download/v1.2.4/XJAUS-1.2.4-x86_64.AppImage) (sha256: `2d4382bd8217a8ec5ccd623659583f539a25ad9b7b39cc39daf7e3742927253b`)
  - RPM: [`XJAUS-1.2.4-linux-x86_64.rpm`](https://github.com/perjesus111-hub/xjaus/releases/download/v1.2.4/XJAUS-1.2.4-linux-x86_64.rpm) (sha256: `e55b96141f3ef11d5a621782634aa0d81dc22b94b9f24749c5ec99958cab1a32`)
  - DEB: [`XJAUS-1.2.4-linux-amd64.deb`](https://github.com/perjesus111-hub/xjaus/releases/download/v1.2.4/XJAUS-1.2.4-linux-amd64.deb) (sha256: `8a598cdbef5b31f7381cac4c5761193358a3d268d9b40c2591758b3eeefa2c93`)
  - Checksums: [`SHA256SUMS`](https://github.com/perjesus111-hub/xjaus/releases/download/v1.2.4/SHA256SUMS) (covers the three files above)
- **Windows:** NSIS EXE and MSI configured in build but **not included in this release** (no native Windows QA, no signature).
- **Notes:** Static type-2 AppImage runtime (no `libfuse2` required), system theme support, no `.zsync` for distribution. See release body for full details.

### Previous release: v1.2.3

- **GitHub Release:** [v1.2.3](https://github.com/perjesus111-hub/xjaus/releases/tag/v1.2.3) (2026-11-15)
- **Artifacts (Linux x86-64):**
  - AppImage: [`XJAUS-1.2.3-x86_64.AppImage`](https://github.com/perjesus111-hub/xjaus/releases/download/v1.2.3/XJAUS-1.2.3-x86_64.AppImage) (sha256: `45d9e25a3710856ad283b612649ffca67fe4acc1c5b53cfd4f815359a3a3f814`)
  - RPM: [`XJAUS-1.2.3-linux-x86_64.rpm`](https://github.com/perjesus111-hub/xjaus/releases/download/v1.2.3/XJAUS-1.2.3-linux-x86_64.rpm) (sha256: `1c7332f11feca9697565870e01647d495ed3a350139a625b4ed83f1124bfe777`)
  - DEB: [`XJAUS-1.2.3-linux-amd64.deb`](https://github.com/perjesus111-hub/xjaus/releases/download/v1.2.3/XJAUS-1.2.3-linux-amd64.deb) (sha256: `9fd72c64e38390973a0541126fd9c4fa9facfe48c352d77c82d3bd34a555bae7`)
  - AppImage `.zsync`: [`XJAUS-1.2.3-x86_64.AppImage.zsync`](https://github.com/perjesus111-hub/xjaus/releases/download/v1.2.3/XJAUS-1.2.3-x86_64.AppImage.zsync) (experimental, unsigned)
  - Checksums: [`SHA256SUMS`](https://github.com/perjesus111-hub/xjaus/releases/download/v1.2.3/SHA256SUMS)
- **Windows:** Not included in this release.
- **Notes:** Static type-2 AppImage runtime (no `libfuse2` required), system theme support, experimental `.zsync` chain. See release body for full details.

### Historical: v1.2.1

- [GitHub Release v1.2.1](https://github.com/perjesus111-hub/xjaus/releases/tag/v1.2.1)
- Validation report: `docs/validation-1.2.1.md`
- Release notes: `docs/release-notes-1.2.1.md`

## Platform matrix

| Platform | Artifacts | CI build verified | Local QA | Signed | Notes |
|----------|-----------|-------------------|----------|--------|-------|
| Linux x86-64 | AppImage, RPM, DEB | ✅ Yes (c862733) | ✅ FUSE direct mount + DEB/RPM install & launch in QEMU VMs (Debian/Fedora) | ❌ No | Static type-2 AppImage runtime; sandbox enforced; no `.zsync` |
| Windows x64 | NSIS EXE, MSI | ✅ Source build & tests | ❌ No (Wine smoke-test only) | ❌ No | Separate Cargo manifest (`backend-windows`); no native installer validation |

**Honest status:** Linux FUSE/DEB/RPM build passed CI in commit `c862733` (CI run 45055705437). Local packaging verified FUSE mount, DEB/RPM install and app launch in QEMU VMs (Debian 13/Fedora 44). Windows NSIS/MSI compile and pass source tests but have **no native Windows QA and no signature**. Do not claim native Windows validation.

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