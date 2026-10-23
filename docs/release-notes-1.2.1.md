# XJAUS 1.2.1

## Español

XJAUS 1.2.1 incorpora mejoras en el flujo de inicio de sesión con código de dispositivo y una preferencia de interfaz en inglés o español que se propaga a la solicitud de Cloud Gaming como locale, separada del mercado configurado. English solicita `en-US`; Español solicita `es-MX`. XJAUS no cambia la región de la cuenta, consola o sistema, y no garantiza el idioma interno de todos los juegos.

### Paquetes

- Linux x86-64: AppImage, RPM y DEB.
- Windows x64: instalador NSIS EXE e instalador MSI.

Consulta el asset `SHA256SUMS` adjunto a la publicación para verificar los cinco instaladores. En el paquete local de preparación, el manifiesto equivalente está en `release/SHA256SUMS`; `release/linux/SHA256SUMS` solo cubre los tres paquetes Linux.

### Validación y límites conocidos

- La suite automatizada local pasó: Vitest 309/309; Node 23/23; Rust 113/113 (biblioteca), 122/122 (backend) y 113/113 pruebas del objetivo Windows bajo Wine.
- Se observó una sesión real de Cloud Gaming de Age of Empires IV con video 1920×1080. La pantalla inicial de accesibilidad se mostró en inglés; **no se verificó el menú principal** ni se guardaron ajustes iniciales del juego.
- **Remote Play no está verificado**: la prueba no obtuvo video.
- **OAuth no está verificado**: no se inició un flujo nuevo de autorización.
- El mercado efectivo remoto de la cuenta no se comprobó en vivo. La preservación de `ES-MX` se verificó en la configuración/código de la solicitud, no como resultado remoto de Xbox.
- Los instaladores de Windows **no están firmados** y solo recibieron pruebas bajo Wine; **no se han validado en Windows nativo**.
- La compatibilidad de los paquetes Linux no se certificó en todas las distribuciones ni en SteamOS.

El informe detallado está en [`docs/validation-1.2.1.md`](docs/validation-1.2.1.md).

## English

XJAUS 1.2.1 improves the device-code sign-in lifecycle and adds an English/Spanish interface preference that propagates a locale to Cloud Gaming requests, separately from the configured market. English requests `en-US`; Español requests `es-MX`. XJAUS does not change the account, console, or system region, and does not guarantee the internal language of every game.

### Packages

- Linux x86-64: AppImage, RPM, and DEB.
- Windows x64: NSIS EXE installer and MSI installer.

Use the attached `SHA256SUMS` release asset to verify all five installers. In the local preparation package, the corresponding manifest is `release/SHA256SUMS`; `release/linux/SHA256SUMS` covers only the three Linux packages.

### Validation and known limitations

- The local automated suite passed: Vitest 309/309; Node 23/23; Rust 113/113 (library), 122/122 (backend), and 113/113 Windows-target tests under Wine.
- A real Age of Empires IV Cloud Gaming session delivered 1920×1080 video. The initial accessibility screen appeared in English; **the main menu was not verified**, and no first-run game settings were saved.
- **Remote Play is not verified**: the test did not obtain video.
- **OAuth is not verified**: no new authorization flow was started.
- The account's effective remote market was not checked live. Preservation of `ES-MX` was verified in local request configuration/code, not as an Xbox remote result.
- Windows installers are **unsigned** and received Wine-only testing; they have **not been validated on native Windows**.
- Linux package compatibility has not been certified across all distributions or on SteamOS.

See [`docs/validation-1.2.1.md`](docs/validation-1.2.1.md) for the detailed report.
