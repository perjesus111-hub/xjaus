# XJAUS

[English](README.md)

Cliente de escritorio independiente para Xbox Cloud Gaming y Xbox Remote Play. Electron ofrece una interfaz orientada al mando y un proceso auxiliar Rust gestiona la autenticación y el control de la transmisión. El juego en la nube depende de la elegibilidad de la cuenta, la región y el servicio; Remote Play requiere una consola compatible con las funciones remotas habilitadas.

## 1.2.4: código en preparación, no publicado

- **Destinos de empaquetado:** Linux x86-64 (AppImage, RPM, DEB) y Windows x64 (EXE NSIS, MSI). No equivalen a compatibilidad probada ni certifican una instalación en Windows nativo.
- **Sesión:** la autenticación no se guarda ni se restaura; inicia sesión tras reiniciar. Otras preferencias pueden persistir. Cerrar sesión intenta limpiar credenciales antiguas, pero no revoca tokens en Microsoft. Consulta [Privacidad](PRIVACY.md).
- **Transmisión:** navegación con mando, favoritos y diagnóstico opcional. Hasta 1440p, 15–45 Mbps y selección de códec son preferencias, no garantías. La decodificación depende de la transmisión, los controladores y el entorno.
- **Linux:** no desactives el aislamiento con `--no-sandbox`. Las actualizaciones diferenciales de AppImage (`.zsync`) quedan fuera de esta preparación.

## Código y validación

CI utiliza Node 24 y manifiestos Cargo distintos para Linux y Windows. Consulta [Contribución](CONTRIBUTING.md), [Arquitectura](docs/ARCHITECTURE.md), [compilación de Windows](WINDOWS-BUILD.md) y [reversión](docs/ROLLBACK.md). `npm run dist:linux` utiliza Docker y no forma parte de la validación estática. Empaquetar no autoriza ejecutar ni distribuir el resultado.

[Historial](CHANGELOG.md) · [Informes de seguridad](SECURITY.md) · [Licencia GPL-3.0](LICENSE)

Basado en el trabajo de Greenlight; véanse los [créditos y avisos](README.md#license-and-acknowledgments). Proyecto no afiliado ni respaldado por Microsoft o Xbox.
