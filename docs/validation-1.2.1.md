# XJAUS 1.2.1 — local validation report

**Prepared:** 23 October 2026

**Branch:** `release/xjaus-1.2.1`

**Status:** local candidate only; not merged, tagged, pushed, published, or posted to Reddit.

## Summary

- **Language preference after restart — PASS:** XJAUS 1.2.1 restarted in an isolated Xvfb instance and restored `es` in the app preference, language control, and HTML `lang` attribute.
- **Cloud Gaming transport — PASS, gameplay incomplete:** a real Age of Empires IV Cloud Gaming session delivered 1920×1080 video with advancing playback and sustained receive telemetry. It stopped at the game's first-run accessibility screen; no game preference was saved, and no gameplay demo video was recorded.
- **Xbox market/account region — unchanged by this work:** no account, console, or system region setting was opened or modified. Code tests preserve the session payload's existing `settings.market=ES-MX`, independent of the selected locale; the separate DisplayCatalog query remains `market=MX`. The service's effective account market was not checked live.
- **Remote Play — NOT VERIFIED:** a real connection attempt from the detected `connectedstandby` console returned to the dashboard without video after roughly 45 seconds; the console remained in standby. The exact failure reason was not captured.
- **Sign-in — UI reviewed; OAuth not run:** the packaged Windows smoke instance displayed the login screen. No device code, credentials, consent, or new OAuth session was requested or entered.
- **Reddit evidence — partial:** privacy-reviewed screenshots are present in the evidence folder. No gameplay video exists because the game displayed a persistent first-run confirmation that requires the user's approval.

## Real checks

### Language persistence

After selecting Spanish, the disposable XJAUS 1.2.1 AppImage payload was closed and launched as a fresh process under Xvfb. Read-back showed `languagePreference=es`, the language control set to `es`, and `document.documentElement.lang=es`. `reddit-demo/language-es.png` is the post-restart selector capture. This is an app-preference restart test; it does not promise that every title will use the selected language.

Separately, the user reported that the same game appeared in Spanish when Español was selected and in English when English was selected. That user-observed comparison is preserved in `docs/cloud-stream-language.md`; no capture or telemetry accompanied the original report.

### Cloud Gaming

The 1.2.1 renderer started a real Cloud Gaming session for Age of Empires IV. Observed: 1920×1080, `readyState=4`, `hasStream=true`, and `currentTime` advanced from approximately 65.19 to 72.84. Two telemetry samples reported approximately 13–15 Mbps received, about 60 FPS, 13–17 ms RTT, 0% packet loss, and about 5 ms decode time. The stream therefore passed transport/video-receive validation.

The first game frame was an in-game accessibility setup screen in Spanish. The test did **not** press “Save and continue,” because that could persist game preferences without explicit approval. The stream was closed using XJAUS's own stop control; afterward the video returned to `readyState=0`, dimensions 0×0, and no stream. This was not a gameplay test. `reddit-demo/cloud-settings-es.png` is a cropped, visually reviewed frame with the visible account identifier excluded.

### Remote Play

The sole discovered console was initially `connectedstandby`, and its real connection button was enabled. The test initiated Remote Play, waited approximately 45 seconds, and observed the player return to the dashboard with `readyState=0`, no video dimensions, and the console still in `connectedstandby`. No stream was established; no console or account settings were changed. Do not claim Remote Play works based on this attempt.

### Login and privacy

The packaged MSI smoke instance rendered the login UI under Wine/Xvfb. This did not exercise Microsoft OAuth. A real device-code test still requires the user to enter and approve the code personally; credentials and codes must not be sent in chat.

Screenshots reviewed for privacy:

- `reddit-demo/login-screen.png` — login UI; no credentials entered.
- `reddit-demo/language-en.png` — English selector.
- `reddit-demo/language-es.png` — Spanish selector after application restart.
- `reddit-demo/cloud-settings-es.png` — real game frame, cropped to remove the account identifier; first-run accessibility screen, not gameplay.

The unredacted game frame is kept outside the distributable evidence folder with restrictive permissions; it is not included in the evidence archive or intended for sharing.

## Installer artifacts

All five local artifacts exist and passed container tests. The Linux release verifier reported the unpacked backend byte-identical to the release sidecar, mode `0755`, and expected ASAR metadata/renderer. DEB and RPM metadata report version `1.2.1`, x86-64 architecture, GPL-3.0-only, and the configured project homepage. RPM digest verification passed. The authoritative all-platform manifest is `release/SHA256SUMS`; `sha256sum -c release/SHA256SUMS` verified all five entries. `release/linux/SHA256SUMS` is the Linux-only manifest emitted by the Linux verifier.

| Artifact | Size (bytes) | SHA-256 | Validation limit |
|---|---:|---|---|
| `release/linux/XJAUS-1.2.1-linux-x86_64.AppImage` | 130,360,357 | `c752d8b7cd77ed4846bc9da79f4fed2bf3a6ef6b9dfd8a1dbe03ed634c0049bd` | Container tested; packaged payload UI was exercised in isolated Xvfb. This is not proof of FUSE-mode or older-distro compatibility. |
| `release/linux/XJAUS-1.2.1-linux-x86_64.rpm` | 93,040,753 | `b15bbd1c5109df5902049cde822713121e98fb23e786b912abe10e5d52a9046b` | Metadata and container checked; payload extracted for comparison. No system installation test. |
| `release/linux/XJAUS-1.2.1-linux-amd64.deb` | 104,148,248 | `1a4a812998828de6ca69df6447467efb34e2fa17ff7753776931b8a1b0494ab5` | Control metadata and container checked; payload extracted for comparison. No system installation test. |
| `release/win/XJAUS-1.2.1-win-x64-setup.exe` | 115,137,563 | `c22be927bcdc34b1b0b1d4b8ebae2b1fee46c578f447e795c842d00be958f5d2` | NSIS container and x64 app payload smoke-tested under Wine/Xvfb; not native Windows. The 32-bit NSIS bootstrap is expected. |
| `release/win/XJAUS-1.2.1-win-x64-setup.msi` | 396,742,144 | `b6b81a2d4731ef317f0cb1cd78fcd8e79abfcde6348dd074d4eeca16a49e866c` | MSI container checked and smoke-installed under Wine/Xvfb; not native Windows. Unsigned; treat as a local candidate, not a verified public MSI release. |

The Linux formats were built and inspected independently. The Windows installers were generated and tested in a disposable Wine environment. No Windows code-signing certificate was applied or verified. Native Windows install, upgrade, uninstall, and signing checks remain open.

## Automated gates

The corrected final integrated run completed successfully on 23 October 2026:

- `npm test`: Vitest 91/91 files and 309/309 tests passed; Node test runner 23/23 passed.
- `npm run build` and `npx tsc -p tsconfig.json --noEmit`: passed.
- `cargo fmt --all --check`: passed.
- Rust library tests: 113/113 passed; `xjaus_backend` tests: 122/122 passed; Linux backend build: passed.
- Windows-target Rust tests under the disposable Wine prefix: 113/113 passed; Cargo emitted four non-fatal unused/dead-code warnings.
- `git diff --check`: passed.
- `node scripts/linux-verify.cjs`: passed packaged Linux sidecar identity/mode and ASAR metadata/renderer checks.
- DEB control metadata was read through `ar`/`tar` because `dpkg-deb` is not installed; RPM metadata and digest checks passed; `7z t` passed for all five installers.

An initial isolated run omitted `TMPDIR`, so two settings tests failed during setup. Supplying the required scratch `TMPDIR` made the corrected run pass; no code change was needed. `cargo clippy` was not run because `cargo-clippy` is not installed in the active stable toolchain.

## Release boundary / remaining approvals

No merge, push, tag, GitHub release, external upload, or Reddit post was performed. Outstanding gates are:

1. User approval before saving the game's first-run accessibility settings, then a real gameplay capture and privacy review.
2. A manually approved, isolated OAuth device-code smoke test if the user wants login authorization tested beyond the visible UI and automated lifecycle tests.
3. A successful Remote Play stream after checking console remote-feature/network readiness; this test did not change those settings.
4. Native Windows installer testing and signing before describing the MSI/EXE as a public Windows release.
