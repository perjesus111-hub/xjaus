# Changelog

All notable changes to XJAUS are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
versions follow [Semantic Versioning](https://semver.org/).

## [1.2.1] - Unreleased

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

- Local draft only. Do not treat this entry as a published release; the validation
  report is `docs/validation-1.2.1.md` and the unpublished notes are
  `docs/release-notes-1.2.1-draft.md`.

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
