# Cloud Gaming: routing del idioma solicitado

Estado: corrección preparada en `release/xjaus-1.2.1`. El 22 de octubre de 2026, un usuario informó una prueba real comparativa del mismo juego: al elegir Español el juego apareció en español; al elegir English apareció en inglés. Es evidencia observacional del usuario, sin captura ni telemetría adjunta al mensaje. No implica que XJAUS fuerce el idioma interno de todos los títulos. La persistencia tras reiniciar XJAUS se valida por separado.

## Preferencias separadas

- **Idioma de interfaz XJAUS:** `i18n.preference` (`auto`, `en`, `es`) y su locale de UI (`en`/`es`). Controla textos de la app y sigue siendo el valor que el usuario selecciona en Ajustes.
- **Idioma solicitado al Cloud Gaming:** se deriva al iniciar una sesión en la nube, en `streamingLocale`, un campo de la app/IPC (no se agrega como campo nuevo al protocolo Xbox). El backend lo normaliza y lo asigna al campo existente `settings.locale`. `en` → `en-US`; `es` → `es-MX`; `auto` → primer locale BCP-47 válido del sistema expuesto por Chromium, conservando región cuando exista. POSIX `es_MX.UTF-8` se canonicaliza a `es-MX`; `es` usa el fallback Xbox documentado a `es-MX`; `es-419` se mapea a `es-MX` como compatibilidad de la app (no hay validación del endpoint privado para ese caso); `en` a `en-US`. Si el sistema no ofrece un locale utilizable, se usa `en-US`. No se envía un país de cuenta.
- **Región/mercado:** no se deriva de la preferencia de idioma ni se modifica. DisplayCatalog conserva `market=MX`. El campo privado del payload de sesión `settings.market` conserva el valor previo exacto `ES-MX`, ahora independiente del locale. No afirmamos que ese campo equivalga a la región de la cuenta.
- **Remote Play/Home:** no recibe el nuevo locale solicitado; conserva su comportamiento previo. El cambio de idioma de stream se limita a Cloud Gaming.

## Campos verificados frente a experimentales

| Elemento | Qué está comprobado | Qué no está comprobado |
|---|---|---|
| `settings.locale` en `/v5/sessions/{cloud}/play` | XJAUS ya enviaba este campo; el código y los fixtures confirman su ubicación. `en-US`, `es-MX` y varios locales regionales figuran en la documentación pública de locales Xbox. | Microsoft no publica en el GDK consultado el esquema REST privado de esta solicitud. Que el servicio acepte una sustitución del valor y que el juego consuma esa preferencia es experimental hasta el smoke real. |
| HTTP `Accept-Language` de las solicitudes de sesión | Era una cabecera fija en español; ahora se construye desde el mismo locale solicitado, con respaldo de idioma. La sintaxis expresa preferencias de idioma HTTP según RFC 9110.[5] | No está documentado públicamente que el endpoint de sesión use esta cabecera para seleccionar idioma del juego. |
| `settings.market` del payload de sesión | XJAUS enviaba el valor `ES-MX` al usar locale español; las pruebas ahora exigen conservarlo aunque el locale solicitado sea inglés. | El significado/semántica de este campo del protocolo privado no está documentado por Microsoft en las fuentes consultadas. Se conserva sin cambio para no inferir ni modificar el mercado. |
| DisplayCatalog `market=MX` | Es una petición de metadatos separada; el código conserva MX y el idioma de catálogo sigue la preferencia de UI. | No determina ni se trata como región de la cuenta Xbox. |
| `Accept-Language: es-MX` de Profile API | Permanece fijo únicamente en las implementaciones de consulta de identidad (`profile.rs`/`profile_windows.rs`). No se usa en las solicitudes de sesión ni se cambió en esta corrección. | No se investigó si cambia nombres localizados devueltos por ese endpoint; se dejó fuera del flujo de idioma de Cloud Gaming. |
| Región física, cuenta Xbox y paquete del juego | Microsoft documenta que Xbox Game Streaming detecta por separado la región física de conexión y el locale del dispositivo local; ambos participan en la configuración del servidor.[1] | XJAUS no cambia ni consulta la región de la cuenta en este flujo. Tampoco puede garantizar que el título cambie audio, subtítulos o menús solo por recibir un locale distinto. |

La documentación pública enumera `en-US`, `es-MX`, `es-ES` y `es-AR`; los servicios Xbox aplican reglas de fallback, por ejemplo `es-AR` → `es-MX` y `en-CA` → `en-GB`.[2][3] La configuración de cadenas localizadas se define por título y publisher, así que la presencia de esos locales no garantiza que Age of Empires IV tenga cada recurso o que cambie su idioma de inicio.[4] Esto justifica usar `en-US` para la opción manual English y mantener `es-MX` para la opción manual Español; **no convierte la modificación del campo REST privado en un comportamiento oficialmente garantizado**.

## Pruebas automatizadas añadidas

- Mapper UI → locale solicitado: English manual, Español manual, Auto con `en-GB`/`es-MX`, POSIX locale, fallback español y entradas inválidas.
- Backends: el sidecar Electron y el argumento tipado Tauri reciben `streamingLocale` separado del perfil de pantalla.
- Payload: locale solicitado no cambia `settings.market`; `settings.market` conserva `ES-MX`; Home/Remote Play conserva `es-MX`.
- HTTP: `Accept-Language` sigue el locale solicitado en Cloud.
- Seguridad: locale inválido se rechaza; no se acepta como texto libre de cabecera.
- Sistema: Electron preserva el locale regional configurado mediante `LC_ALL`, `LC_MESSAGES` o `LANG` en ese orden; no convierte todo español a `es-MX`. No cambia la configuración de GNOME ni la escala de pantalla.

## Matriz automatizada y real

| Flujo | Preferencia UI | Locale solicitado | Mercado de sesión | Resultado |
|---|---|---|---|---|
| Cloud Gaming | Español | `es-MX` | `ES-MX` sin cambio | PASS en mapper/payload/cabecera local; el usuario reporta que el mismo juego apareció en español |
| Cloud Gaming | English | `en-US` | `ES-MX` sin cambio | PASS en mapper/payload/cabecera local; el usuario reporta que el mismo juego apareció en inglés |
| Cloud Gaming | Auto | locale de sistema; casos `es-MX` y `en-GB` | `ES-MX` sin cambio | PASS en mapper, payload y cabecera local/mock; resultado real de título no reportado para Auto |
| Home / Remote Play | cualquiera | comportamiento previo `es-MX` | `ES-MX` sin cambio | PASS en pruebas de regresión locales; la sesión real nueva se registra aparte |

## Evidencia real reportada por el usuario

El 22 de octubre de 2026, el usuario informó que probó el mismo juego con ambas opciones: Español → el juego apareció en español; English → el mismo juego apareció en inglés. Se registra como observación real aportada por el usuario. No se inventan hora, versión exacta cargada, telemetría ni capturas, pues no acompañaron el reporte. El resultado observado aplica a esa prueba y no garantiza el idioma de todos los títulos.

## Validación real en XJAUS 1.2.1 (23 de octubre de 2026)

- **Persistencia del idioma: PASS.** En una instancia desechable del payload AppImage extraído, se eligió Español, se cerró el proceso y se abrió uno nuevo en Xvfb. Tras el reinicio, el estado leído de la aplicación fue `languagePreference=es`, selector `es` y `document.documentElement.lang=es`; la captura `language-es.png` muestra el selector Español. Esto verifica la preferencia de XJAUS tras reiniciar, no una garantía de idioma de cada juego.
- **Cloud Gaming / transporte: PASS parcial.** Se inició una sesión real de Age of Empires IV desde la instancia 1.2.1. El video llegó a 1920×1080, `readyState=4`, `hasStream=true` y `currentTime` avanzó de aproximadamente 65.19 a 72.84. Dos muestras de telemetría mostraron aproximadamente 13–15 Mbps recibidos, ~60 FPS, RTT de 13–17 ms, pérdida 0% y decodificación ~5 ms. Esto verifica transporte y recepción sostenida de video.
- **Juego / demostración: BLOQUEADO por confirmación.** El primer cuadro del juego era una pantalla inicial de accesibilidad en español. No se pulsó «Guardar y continuar» porque podría persistir preferencias del juego sin aprobación explícita. La sesión se cerró con el control de XJAUS; el video volvió a `readyState=0`, sin stream. Por ello esta prueba no llegó a gameplay y no se generó un video demostrativo de gameplay. `reddit-demo/cloud-settings-es.png` es un recorte real y revisado que excluye el identificador visible en el cuadro original.
- **Remote Play: NO PASS.** Se intentó una conexión real desde la consola detectada como `connectedstandby` y con botón de conexión habilitado. Tras aproximadamente 45 segundos la aplicación volvió al dashboard; no hubo video (`readyState=0`, dimensiones 0×0) y la consola seguía en `connectedstandby`. La causa exacta no quedó capturada; Remote Play no se declara funcional.
- **Interfaz de inicio de sesión: UI revisada; OAuth NO probado.** Se inspeccionó la pantalla de inicio de sesión del instalador Windows bajo Wine. No se inició un nuevo flujo OAuth ni se introdujo código/credencial; una prueba real de device-code requiere que el usuario ingrese y apruebe el código personalmente.
- **Mercado/región: sin cambios de cuenta.** No se modificó la región de cuenta, consola ni sistema. Las pruebas del código confirman que `settings.market` se mantiene en `ES-MX` y no se deriva del idioma; DisplayCatalog conserva `market=MX`. El mercado efectivo de la cuenta o la respuesta del servicio no se verificó en vivo.

## Matriz automatizada y real

| Flujo | Preferencia UI | Locale solicitado | Mercado de sesión | Resultado |
|---|---|---|---|---|
| Cloud Gaming | Español | `es-MX` | `ES-MX` independiente | PASS en mapper/payload/cabecera; el usuario reportó el mismo juego en español; stream real recibió video y mostró la pantalla inicial del juego en español |
| Cloud Gaming | English | `en-US` | `ES-MX` independiente | PASS en mapper/payload/cabecera; el usuario reportó el mismo juego en inglés; no se repitió una segunda sesión por la pantalla de configuración inicial |
| Auto | locale del sistema | locale regional válido | `ES-MX` independiente | PASS en mapper/payload/cabecera local/mock; resultado de título no comprobado |
| Home / Remote Play | cualquiera | comportamiento previo `es-MX` | `ES-MX` independiente | PASS en regresiones locales; prueba real de Remote Play no logró obtener video |

## Límite de interpretación

La selección de idioma de XJAUS se pasa como locale solicitado al Cloud Gaming, y el resultado observado del mismo juego fue reportado por el usuario. XJAUS no fuerza opciones internas del título. La prueba nueva confirma transporte de Cloud Gaming y persistencia de la preferencia de XJAUS, pero quedó detenida antes del gameplay por una confirmación de primera ejecución. Remote Play y el mercado efectivo del servicio permanecen sin validar en vivo.

## Sources

[1] https://learn.microsoft.com/en-us/gaming/gdk/docs/features/common/game-streaming/game-streaming-optimizing-your-game?view=gdk-2604 — Development Best Practices for Xbox Game Streaming
[2] https://learn.microsoft.com/en-us/gaming/gdk/docs/services/community/localized-strings/live-language-fallback?view=gdk-2604 — Xbox Services Language Fallback
[3] https://learn.microsoft.com/en-us/xbox/gdk/docs/gdk-dev/game-principles/localization/console_supported_languages?view=gdk-2604 — Console-supported languages
[4] https://learn.microsoft.com/en-us/gaming/gdk/docs/services/community/localized-strings/live-localized-strings-config?view=gdk-2604 — Configuring localized strings in Partner Center
[5] https://www.rfc-editor.org/rfc/rfc9110.html — RFC 9110: HTTP Semantics, Accept-Language
