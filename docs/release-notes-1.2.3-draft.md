# XJAUS 1.2.3 — draft, not published

## Changes

- Linux windowed mode uses the desktop compositor's native title bar, including on the login screen. Its appearance follows the desktop theme. Wayland controls final placement.
- The Linux AppImage filename is `XJAUS-1.2.3-x86_64.AppImage`. Existing black-and-gold app styling remains the default.

## Packaging and validation limits

- AppImage, RPM and DEB were built locally; the NSIS EXE was rebuilt after the Windows sidecar crate was bumped to 1.2.3. The MSI built after copying the 32-bit mingw runtime DLLs (`libgcc_s_dw2-1.dll`, `libwinpthread-1.dll`) from the mingw32 sysroot into the disposable Wine prefix's `syswow64`, which let WiX's `candle.exe` load wine-mono. Both installers are unsigned; they were built with Wine tooling, but installer execution under Wine or native Windows has not been verified. These artifacts are not yet approved for release.
- A prior NSIS payload was extracted and inspected, but it is not established that its hash matched the subsequently rebuilt installer. Re-extract and audit the exact final installer, including ASCII and UTF-16 private-path scans, before release.
- The AppImage catalog bot tested v1.2.2 and passed it with warnings: an old runtime requiring host libc and libfuse2, a glibc 2.39 reference, redundant `linux` in the filename, a dark window on a light-theme test system, and no AppImageUpdate information. The original report is the AppImage catalog PR 10806 bot comment 6504521652; full job log is GitHub Actions run 40926999978.
- Linux FUSE compatibility may still be required. No runtime upgrade has been demonstrated. `--appimage-extract-and-run` is an alternative where supported. The source of the glibc 2.39 reference and actual minimum distro compatibility remain unverified; a newer runtime alone would not establish compatibility of Electron and the sidecar.
- AppImageUpdate update information and `.zsync` are not implemented or validated. Do not claim differential updating from electron-builder's blockmap.
- An isolated native-Wayland login instance was checked at scale 300%: the user reported that mouse dragging worked, but the compositor position change was not independently captured. Two synthetic F11 cycles returned the compositor window to its prior dimensions in that instance; maximization was not independently verified. Login controls, exact position restore, dashboard drag, physical controller, authenticated playback, physical 21:9 and native Windows remain unverified.
- The original full AppImage report must be checked before claiming its entire warning list has been resolved.
