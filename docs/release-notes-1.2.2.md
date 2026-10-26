# XJAUS 1.2.2

## Español

XJAUS 1.2.2 añade alternancia entre pantalla completa real y modo ventana redimensionable sin reiniciar la aplicación ni cambiar los protocolos de Xbox. El control está disponible con **F11**, desde el dashboard, en la barra durante transmisión y en el menú in-game. Escape y B siguen cerrando el menú local sin desconectar la sesión.

La aplicación conserva la geometría normal y el estado maximizado cuando es seguro restaurarlos. Si cambian los monitores, valida la geometría contra las áreas de trabajo disponibles para evitar abrir fuera de pantalla. En Wayland, la posición final queda sujeta al compositor. El video usa `object-fit: contain`: preserva la relación de aspecto de la señal y puede mostrar barras discretas en lugar de estirar o recortar el contenido.

### Paquetes

- Linux x86-64: AppImage, RPM y DEB.
- Windows x64: instalador NSIS EXE e instalador MSI.

Consulta `SHA256SUMS`, adjunto a la release, para verificar los cinco instaladores.

### Validación y límites conocidos

- F11 y el cambio entre ventana/fullscreen se probaron realmente en Fedora GNOME Wayland con escala de interfaz de 300 %.
- No se verificó esta mejora en un monitor físico 21:9 ni dentro de una sesión de streaming autenticada; esas rutas tienen pruebas automatizadas/integradas, no una reproducción real para esta release.
- Remote Play, OAuth nuevo y todas las rutas de Cloud Gaming no se vuelven a declarar verificados por este cambio.
- Los instaladores Windows no están firmados. Solo se prueban bajo Wine salvo que se indique explícitamente una validación nativa posterior; SmartScreen puede advertir por reputación o falta de firma.

## English

XJAUS 1.2.2 adds switching between real fullscreen and a resizable window without restarting the application or changing Xbox protocols. The control is available through **F11**, the dashboard, the streaming toolbar, and the in-game menu. Escape and B still close the local menu without disconnecting the session.

The application preserves normal window geometry and maximized state when it is safe to restore them. If displays change, it validates geometry against available work areas to avoid opening off-screen. On Wayland, the compositor remains authoritative for final positioning. Video uses `object-fit: contain`: it preserves the source aspect ratio and may use discreet bars instead of stretching or cropping the stream.

### Packages

- Linux x86-64: AppImage, RPM, and DEB.
- Windows x64: NSIS EXE installer and MSI installer.

Use the `SHA256SUMS` asset attached to the release to verify all five installers.

### Validation and known limitations

- F11 and window/fullscreen switching were tested on Fedora GNOME Wayland at 300% interface scale.
- This improvement has not been verified on a physical 21:9 monitor or inside an authenticated streaming session; those paths have automated/integrated coverage, not real playback verification for this release.
- This change does not newly certify Remote Play, fresh OAuth, or every Cloud Gaming route.
- Windows installers are unsigned. They are Wine-tested only unless a later native validation is explicitly reported; SmartScreen may warn because of reputation or missing signing.
