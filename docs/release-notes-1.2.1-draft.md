# XJAUS 1.2.1 — Draft release notes

**Status: local preparation only — not published, merged, tagged, or announced.**

## Highlights

- English and Spanish interface preferences are propagated to the requested Cloud Gaming device locale (`en-US` / `es-MX`) and matching `Accept-Language` header. The app language is kept separate from the session market (`ES-MX`) and catalog market (`MX`); XJAUS does not change the Xbox account, system, or console region. A title may still apply its own language rules.
- Improved Xbox device-code sign-in lifecycle handling, including cancellation and stale-attempt protection.
- Expanded English/Spanish interface copy and release packaging for Linux and Windows x64.

## Language-test note

A user reported a real comparison of the same game: selecting Español showed the game in Spanish; selecting English showed that same game in English. This is an observed result for that test, not a universal claim that XJAUS forces a game's internal language. The separate validation report records the new restart and stream checks, including their limits.

## Local artifacts

Linux x86_64 packages prepared locally:

- `release/linux/XJAUS-1.2.1-linux-x86_64.AppImage`
- `release/linux/XJAUS-1.2.1-linux-x86_64.rpm`
- `release/linux/XJAUS-1.2.1-linux-amd64.deb`

Windows x64 installers prepared locally:

- `release/win/XJAUS-1.2.1-win-x64-setup.exe` (NSIS)
- `release/win/XJAUS-1.2.1-win-x64-setup.msi` (MSI candidate)

The EXE and MSI pass container inspection and were smoke-tested under Wine/Xvfb, not on native Windows. Neither is code-signed. The MSI is included for local evaluation only; do not present it as fully supported for public distribution until native Windows installation/upgrade testing and signing are addressed. `release/SHA256SUMS` covers the final local installer set.

## Validation status

- Automated test/build results and real-device checks are recorded in `docs/validation-1.2.1.md`.
- A real Cloud Gaming session established video transport, but the game stopped at its first-run accessibility confirmation; no setting was saved and no gameplay video was produced.
- Remote Play did not reach video. OAuth was not started. These are outstanding acceptance gates, not passes.
- This draft is not an announcement; do not publish or merge it without explicit authorization.
