# XJAUS

[English](README.md)

Cliente de escritorio independiente para Xbox Cloud Gaming y Xbox Remote Play. Electron ofrece una interfaz orientada al mando y un proceso auxiliar Rust gestiona la autenticación y el control de la transmisión. El juego en la nube depende de la elegibilidad de la cuenta, la región y el servicio; Remote Play requiere una consola compatible con las funciones remotas habilitadas.

## Navegación

- [Estado 1.2.4](#estado-124)
- [Publicaciones y descargas](#publicaciones-y-descargas)
- [Matriz de plataformas](#matriz-de-plataformas)
- [Código y validación](#código-y-validación)
- [CI y controles](#ci-y-controles)
- [Soporte y contribución](#soporte-y-contribución)
- [Licencia y créditos](#licencia-y-créditos)
- [Descargo de responsabilidad](#descargo-de-responsabilidad)

## Estado 1.2.4

- **Estado:** Publicada v1.2.4 (2026-11-23). Paquetes Linux publicados; instaladores Windows configurados pero no validados nativamente.
- **Destinos:** Linux x86-64 (AppImage, RPM, DEB) y Windows x64 (EXE NSIS, MSI). Los destinos configurados no son garantías de plataforma probada.
- **Autenticación:** Solo en memoria; reiniciar requiere inicio de sesión interactivo. Cerrar sesión invalida la autenticación local e intenta limpieza de credenciales antiguas sin afirmar revocación en servidor. Ver [Privacidad](PRIVACY.md).
- **Transmisión:** Navegación con mando, favoritos, diagnóstico opcional. Hasta 1440p, 15–45 Mbps y preferencias de códec son peticiones, no resultados medidos. La decodificación de hardware depende de la transmisión negociada, el entorno y el controlador.
- **Sandbox Linux:** No uses `--no-sandbox` para evadir una comprobación de user-namespace no disponible. Las actualizaciones diferenciales de AppImage (`.zsync`) están deshabilitadas para distribución.

## Publicaciones y descargas

### Última versión publicada: v1.2.4

- **GitHub Release:** [v1.2.4](https://github.com/perjesus111-hub/xjaus/releases/tag/v1.2.4) (2026-11-23)
- **Artefactos (Linux x86-64):**
  - AppImage: [`XJAUS-1.2.4-x86_64.AppImage`](https://github.com/perjesus111-hub/xjaus/releases/download/v1.2.4/XJAUS-1.2.4-x86_64.AppImage) (sha256: `2d4382bd8217a8ec5ccd623659583f539a25ad9b7b39cc39daf7e3742927253b`)
  - RPM: [`XJAUS-1.2.4-linux-x86_64.rpm`](https://github.com/perjesus111-hub/xjaus/releases/download/v1.2.4/XJAUS-1.2.4-linux-x86_64.rpm) (sha256: `e55b96141f3ef11d5a621782634aa0d81dc22b94b9f24749c5ec99958cab1a32`)
  - DEB: [`XJAUS-1.2.4-linux-amd64.deb`](https://github.com/perjesus111-hub/xjaus/releases/download/v1.2.4/XJAUS-1.2.4-linux-amd64.deb) (sha256: `8a598cdbef5b31f7381cac4c5761193358a3d268d9b40c2591758b3eeefa2c93`)
  - Sumas de verificación: [`SHA256SUMS`](https://github.com/perjesus111-hub/xjaus/releases/download/v1.2.4/SHA256SUMS) (cubre los tres archivos arriba)
- **Windows:** Instaladores NSIS EXE y MSI configurados en el build pero **no incluidos en esta release** (sin QA nativa de Windows, sin firma).
- **Notas:** Runtime AppImage type-2 estático (sin requerir `libfuse2`), tema del sistema, sin `.zsync` para distribución. Ver cuerpo de la release para detalles.

### Versión previa: v1.2.3

- **GitHub Release:** [v1.2.3](https://github.com/perjesus111-hub/xjaus/releases/tag/v1.2.3) (2026-11-15)
- **Artefactos (Linux x86-64):**
  - AppImage: [`XJAUS-1.2.3-x86_64.AppImage`](https://github.com/perjesus111-hub/xjaus/releases/download/v1.2.3/XJAUS-1.2.3-x86_64.AppImage) (sha256: `45d9e25a3710856ad283b612649ffca67fe4acc1c5b53cfd4f815359a3a3f814`)
  - RPM: [`XJAUS-1.2.3-linux-x86_64.rpm`](https://github.com/perjesus111-hub/xjaus/releases/download/v1.2.3/XJAUS-1.2.3-linux-x86_64.rpm) (sha256: `1c7332f11feca9697565870e01647d495ed3a350139a625b4ed83f1124bfe777`)
  - DEB: [`XJAUS-1.2.3-linux-amd64.deb`](https://github.com/perjesus111-hub/xjaus/releases/download/v1.2.3/XJAUS-1.2.3-linux-amd64.deb) (sha256: `9fd72c64e38390973a0541126fd9c4fa9facfe48c352d77c82d3bd34a555bae7`)
  - AppImage `.zsync`: [`XJAUS-1.2.3-x86_64.AppImage.zsync`](https://github.com/perjesus111-hub/xjaus/releases/download/v1.2.3/XJAUS-1.2.3-x86_64.AppImage.zsync) (experimental, sin firmar)
  - Sumas: [`SHA256SUMS`](https://github.com/perjesus111-hub/xjaus/releases/download/v1.2.3/SHA256SUMS)
- **Windows:** No incluida en esta release.
- **Notas:** Runtime AppImage type-2 estático (sin requerir `libfuse2`), tema del sistema, cadena `.zsync` experimental. Ver cuerpo de la release para detalles.

### Histórica: v1.2.1

- [GitHub Release v1.2.1](https://github.com/perjesus111-hub/xjaus/releases/tag/v1.2.1)
- Informe de validación: `docs/validation-1.2.1.md`
- Notas de publicación: `docs/release-notes-1.2.1.md`

## Matriz de plataformas

| Plataforma | Artefactos | Build verificado en CI | QA local | Firmado | Notas |
|------------|------------|------------------------|----------|---------|-------|
| Linux x86-64 | AppImage, RPM, DEB | ✅ Sí (c862733) | ✅ Montaje FUSE directo + instalación y arranque DEB/RPM en VMs QEMU (Debian/Fedora) | ❌ No | Runtime AppImage type-2 estático; sandbox obligatorio; sin `.zsync` |
| Windows x64 | EXE NSIS, MSI | ✅ Build y tests fuente | ❌ No (solo Wine smoke-test) | ❌ No | Manifiesto Cargo separado (`backend-windows`); sin validación de instalador nativo |

**Estado honesto:** Linux FUSE/DEB/RPM build pasó CI en commit `c862733` (CI run 45055705437). Empaquetado local verificado montaje FUSE, instalación DEB/RPM y arranque de la app en VMs QEMU (Debian 13/Fedora 44). Instaladores Windows NSIS/MSI compilan y pasan tests de fuente pero **no tienen QA nativo Windows ni firma**. No afirmar validación nativa Windows.

## Código y validación

- CI workflow (fuente): [.github/workflows/validation.yml](.github/workflows/validation.yml) — Node 24, manifiestos Cargo separados para Linux (`src-tauri`) y Windows (`backend-windows`).
- Comprobaciones de fuente: [CONTRIBUTING.md](CONTRIBUTING.md)
- Límites de arquitectura: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Empaquetado Linux (local): `npm run dist:linux` (Docker, no parte de validación CI de fuente)
- Instrucciones build Windows: [WINDOWS-BUILD.md](WINDOWS-BUILD.md)
- Procedimiento reversión: [docs/ROLLBACK.md](docs/ROLLBACK.md)

Empaquetar es separado de la validación de fuente y no autoriza ejecutar ni distribuir sus resultados.

## CI y controles

| Control | Linux (ubuntu-24.04) | Windows (windows-2025) |
|---------|---------------------|------------------------|
| Metadatos de versión | ✅ | ✅ |
| Tests frontend (Vitest 337) | ✅ | ✅ |
| Tests Electron (56) | ✅ | ✅ |
| Backend Linux (Rust) | ✅ | — |
| Backend Windows (Rust) | — | ✅ |
| Simulación empaquetado | ✅ (sintética) | — |
| Simulación release | ✅ (sintética) | — |

**Última ejecución CI:** [45055705437](https://github.com/perjesus111-hub/xjaus/actions/runs/45055705437) — los 4 jobs PASAN.

## Soporte y contribución

- **Issues:** Incluir distribución, sesión de escritorio (Wayland/X11), GPU/controlador, versión de paquete, modelo de mando, y si el problema afecta a cloud gaming o Remote Play. Distinguir perfil seleccionado de dimensiones de video reales y estadísticas de decodificador. Nunca adjuntar tokens de acceso, cachés de cuenta o logs de autenticación sin redactar.
- **Seguridad:** Ver [SECURITY.md](SECURITY.md) para divulgación responsable.
- **Contribución:** Comprobaciones de fuente y flujo en [CONTRIBUTING.md](CONTRIBUTING.md). PRs contra `main`; bumps de versión siguen el proceso de preparación de release.

## Licencia y créditos

XJAUS se distribuye bajo la Licencia Pública General de GNU versión 3. Ver [LICENSE](LICENSE). Preservar avisos de copyright y licencia upstream al redistribuir o modificar el proyecto.

Investigación de protocolo e implementación referencia a xal-node (incluyendo su flujo Device Code en msal.ts), xbox-xcloud-player y proyectos OpenXbox. Las dependencias de terceros conservan sus propias licencias. Nombres Microsoft/Xbox, arte de juegos e imágenes de consolas no son relicenciados bajo la GPL por este repositorio; los permisos de redistribución de assets visuales incluidos deben revisarse antes de una publicación pública.

Basado en la arquitectura y comportamiento de autenticación original de los contribuyentes de Greenlight, licenciados bajo GPL-3.0.

## Descargo de responsabilidad

XJAUS es un proyecto de código abierto independiente y no está afiliado, patrocinado ni respaldado por Microsoft o Xbox.