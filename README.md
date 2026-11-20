# XJAUS

[Español](README.es.md)

XJAUS is an independent desktop client for Xbox Cloud Gaming and Xbox Remote Play. Its controller-oriented interface runs in Electron, with a Rust sidecar for authentication and stream control. Cloud availability depends on Microsoft service eligibility, region and account; Remote Play requires a compatible console configured for remote features.

## 1.2.4: source preview, not a release

- **Targets:** Linux x86-64 (AppImage, RPM, DEB) and Windows x64 (NSIS EXE, MSI). Configured targets are not tested-platform guarantees. No 1.2.4 download or native Windows installer validation is claimed here.
- **Sign-in:** 1.2.4 does not save or restore the authentication session. Sign in again after restarting; other preferences can persist. Sign-out attempts legacy cleanup, but is not server-side token revocation. See [Privacy](PRIVACY.md) before using or downgrading.
- **Streaming:** Gamepad navigation, favorites and optional diagnostics are available. Resolution up to 1440p, 15–45 Mbps and codec settings are requests or preferences, not measured outcomes. Hardware decoding depends on the negotiated stream, runtime and driver.
- **Linux sandbox:** Do not use `--no-sandbox` to work around an unavailable user-namespace check. Differential AppImage updates (`.zsync`) are not part of this release preparation.

## Source and validation

The CI workflow uses Node 24 and separate Cargo manifests for Linux and Windows. Review [Contributing](CONTRIBUTING.md) for source checks and [Architecture](docs/ARCHITECTURE.md) for the platform boundaries. The Linux packaging path is `npm run dist:linux` (Docker); Windows instructions are in [WINDOWS-BUILD.md](WINDOWS-BUILD.md). Packaging is separate from source validation and does not authorize running or distributing its outputs.

[Changelog](CHANGELOG.md) · [Security reports](SECURITY.md) · [Rollback](docs/ROLLBACK.md)

## License and acknowledgments

XJAUS is distributed under the GNU General Public License version 3. See [LICENSE](LICENSE). Preserve upstream copyright and license notices when redistributing or modifying the project.

Protocol and implementation research references xal-node (including its Device Code authentication flow in msal.ts), xbox-xcloud-player and OpenXbox projects. Third-party dependencies retain their own licenses. Microsoft/Xbox names, game artwork and console imagery are not relicensed under the GPL by this repository; redistribution permissions for bundled visual assets must be reviewed before a public release.

Based on the original architecture and authentication behavior by the Greenlight contributors, licensed under GPL-3.0.

## Disclaimer

XJAUS is an independent open-source project and is not affiliated, sponsored, or endorsed by Microsoft or Xbox.
