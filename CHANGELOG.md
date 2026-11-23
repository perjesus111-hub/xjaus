# Changelog

All notable changes to XJAUS are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
versions follow [Semantic Versioning](https://semver.org/).

## [1.2.4] - 2026-11-23

### Changed

- Use in-memory authentication only; restarting requires interactive sign-in. Sign-out invalidates local authentication and attempts legacy credential cleanup without claiming server-side revocation.
- Strengthen stream attempt ownership, cancellation and logout handling across the renderer, Electron IPC and Rust runners; bound sidecar IPC admission and message sizes.
- Align application version metadata; use explicit inert DEB/RPM package hooks. Keep AppImage differential updates out of distribution.

### Dependencies

- Reconcile TLS lockfile policy across both Rust manifests and update the Windows Tokio lock entry.
- Override the specified minimatch 9.x/10.x build dependency ranges to 11.0.8. Other majors remain in the lockfile; this is not an installed-tree or package-level audit.

### Validation limits

- This is source preparation. Hosted CI, candidate payloads, native Windows installation, real-account streaming, signing and publication are not established by local static checks.

### Published assets

- Linux x86-64: AppImage, RPM and DEB with `SHA256SUMS`.
- Windows: NSIS EXE and MSI configured in build but not included (no native Windows QA, no signature).

## [1.2.3] - Historical unreleased preparation

### Changed

- Linux windowed mode uses the compositor's native title bar, including at sign-in, rather than a hidden title bar. Its appearance follows the desktop theme; Wayland controls final positioning.
- The Linux AppImage is named `XJAUS-1.2.3-x86_64.AppImage`; RPM, DEB and Windows naming remain unchanged.
- The Linux AppImage uses the static type-2 runtime (electron-builder appimage toolset `1.0.3`, runtime 20251108). The runtime is a static-pie ELF with no dynamic `NEEDED` entries, so mounting no longer depends on the host's `libfuse2`; Electron itself still requires the standard desktop libraries listed in the DEB/RPM dependencies.
- The desktop interface follows the operating system color scheme: Electron derives the window background from `nativeTheme`, the renderer mirrors `prefers-color-scheme` on `<html data-system-theme>`, and the stylesheet carries a light-theme variant. The in-game stream HUD deliberately stays dark.
- Linux packaging (`npm run dist:linux`) runs inside a digest-pinned Debian trixie container (`node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0`, Rust 1.96.0) and executes the build as the invoking user's UID/GID, keeping host toolchain drift out of the artifact provenance.
- The supported AppImage build path refuses an unavailable user-namespace probe and rejects `--no-sandbox` rather than disabling Electron's sandbox silently. The conservative probe may reject systems that could use a different sandbox mechanism.

### Validation limits

- AppImageUpdate / zsync remains disabled for distribution; the separate prototype is experimental and unauthenticated. Its pinned appimagetool snapshot (SHA-256 `793fca0c…`) is no longer downloadable — the continuous asset was rebuilt and the 1.9.1/1.9.0 tagged assets hash differently — so re-pinning requires a new independent verification decision before any real-artifact embedding test.
- Dark remains the default appearance on systems without a light preference; light-system verification covered a browser preview of the built renderer plus unit tests, not yet the packaged window.
- Exact normal-window geometry and maximization restoration, dashboard dragging, physical controller, authenticated streaming, physical ultrawide displays and native Windows remain unverified. Linux AppImage/RPM/DEB were rebuilt locally inside the pinned container on 2026-11-14 (SHA-256 in `release/linux/SHA256SUMS`); they are unsigned and not approved for release.

## [1.2.2] - 2026-10-26

### Added

- Fullscreen/window switching with F11, dashboard and streaming controls, and an in-game menu action.
- Window bounds and maximized-state persistence with display-aware restore safeguards.

### Changed

- Automatic fullscreen for a stream is now isolated from manual fullscreen state, so an explicit user window choice survives session start and stop.
- The player keeps the source video aspect ratio with `object-fit: contain`; it does not claim native ultrawide streaming.

### Validation limits

- Fedora GNOME Wayland at 300% scale was smoke-tested for F11/window switching. A physical 21:9 monitor and authenticated playback were not used for this change.

## [1.2.1] - 2026-10-24

### Added

- English and Spanish interface preferences now select a corresponding Cloud
  Gaming device locale (`en-US` / `es-MX`) and `Accept-Language` header, while
  keeping locale separate from the existing session market (`ES-MX`) and the
  catalog market (`MX`). Auto follows the system locale where available.
- Xbox device-code sign-in flow with bounded polling, cancellation, and guards
  against stale or overlapping login attempts.

### Changed

- Expanded English/Spanish UI coverage and clarified that a title's own language
  support remains outside XJAUS's control.

### Release status

- Published as v1.2.1. The validation report is `docs/validation-1.2.1.md`
  and the release notes are `docs/release-notes-1.2.1.md`.

## [1.2.0] - 2026-10-21

### Added

- **Dynamic Home with a real daily catalog carousel:** six entitled, art-backed
  titles selected deterministically per day from the real Cloud Gaming catalog,
  with automatic rotation, manual navigation (mouse, keyboard, gamepad arrows),
  position indicators and gold prev/next controls pinned to the hero overlay.
- **Featured-banner actions dialog:** "Play now", "Add/remove favorite" and
  "Cancel" actions with full mouse, keyboard and gamepad operation. Opening the
  dialog never starts a stream; "Play now" reuses the existing, validated Cloud
  Gaming connect flow (authentication, availability and entitlement checks) for
  the selected title only. Escape, the gamepad B button and "Cancel" close the
  dialog without side effects and restore focus to the originating banner.
- **Favorites on Home:** backed by the same CloudLibrary storage as the Cloud
  Gaming section, with immediate two-way synchronization.
- **Settings sub-navigation with six sections:** General, Streaming, Video &
  audio, Interface, Diagnostics and About, modeled as ARIA tabs with roving
  tabindex and gamepad navigation.
- **Interface preferences section:** persisted UI customization kept in its own
  storage namespace, separate from streaming engine settings.
- **Diagnostics section with a sanitized technical report copy:** copies the
  real diagnostic state (status, resolution, bitrate, FPS, RTT and errors when
  present) while redacting credential-like values, URLs, IPs and account data.
- **In-game stream menu:** controller-accessible overlay menu during playback,
  centered per the approved design.

### Fixed

- Featured-banner "Play now" no longer auto-starts a stream when the banner or
  its call-to-action is activated; the dialog is the only entry point.
- Carousel prev/next controls stay vertically centered in the hero and remain
  visible during focus and gamepad navigation.
- Gamertag capsule restored to the top-right header position.
- Gamepad B closes the featured dialog before any global navigation handler.
- Stream keepalive HTTP 401 now refreshes the authentication bundle and retries
  the keepalive without recreating the session peer.
- GitHub repository link in About allows only the exact project URL.

## [1.0.2]

Initial Electron packaging releases (AppImage, RPM, DEB, NSIS) of the
black/graphite/gold interface redesign with a Rust streaming sidecar.
