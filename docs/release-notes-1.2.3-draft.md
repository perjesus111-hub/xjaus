# XJAUS 1.2.3 — draft, not published

## Changes

- Linux windowed mode uses the desktop compositor's native title bar, including on the login screen. Its appearance follows the desktop theme. Wayland controls final placement.
- The Linux AppImage filename is `XJAUS-1.2.3-x86_64.AppImage`. Existing black-and-gold app styling remains the default.

## Packaging and validation limits

- AppImage, RPM and DEB were built locally; the NSIS EXE was rebuilt after the Windows sidecar crate was bumped to 1.2.3. The MSI built after copying the 32-bit mingw runtime DLLs (`libgcc_s_dw2-1.dll`, `libwinpthread-1.dll`) from the mingw32 sysroot into the disposable Wine prefix's `syswow64`, which let WiX's `candle.exe` load wine-mono. All Windows installers remain unsigned and are Wine-tested only. These artifacts are not yet approved for release.
- The AppImage catalog bot tested v1.2.2 and passed it with warnings: an old runtime requiring host libc and libfuse2, a glibc 2.39 reference, redundant `linux` in the filename, a dark window on a light-theme test system, and no AppImageUpdate information. The original report is the AppImage catalog PR 10806 bot comment 6504521652; full job log is GitHub Actions run 40926999978.
- Linux FUSE compatibility may still be required. No runtime upgrade has been demonstrated. `--appimage-extract-and-run` is an alternative where supported. The source of the glibc 2.39 reference and actual minimum distro compatibility remain unverified; a newer runtime alone would not establish compatibility of Electron and the sidecar.
- AppImageUpdate update information and `.zsync` are not implemented or validated. Do not claim differential updating from electron-builder's blockmap.
- A real drag on GNOME Wayland, authenticated playback, a physical 21:9 display and native Windows are not yet validated. Windows installers are not signed. No installer should be announced until its final payload and signature state have been independently verified.
- The original full AppImage report must be checked before claiming its entire warning list has been resolved.
