# Cloud Gaming: routing del idioma solicitado

Estado: corrección preparada en `release/xjaus-1.2.1`; **la aceptación por el servicio y el idioma de Age of Empires IV siguen pendientes de una nueva prueba real autorizada**. La sesión previa confirmó español incluso con la UI en inglés; no se reutiliza esa autorización para iniciar otra sesión.

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
| Cloud Gaming | Español | `es-MX` | `ES-MX` sin cambio | PASS en mapper, payload y cabecera local/mock; juego real pendiente |
| Cloud Gaming | English | `en-US` | `ES-MX` sin cambio | PASS en mapper, payload y cabecera local/mock; juego real pendiente |
| Cloud Gaming | Auto | locale de sistema; casos `es-MX` y `en-GB` | `ES-MX` sin cambio | PASS en mapper, payload y cabecera local/mock; juego real pendiente |
| Home / Remote Play | cualquiera | comportamiento previo `es-MX` | `ES-MX` sin cambio | PASS en pruebas de regresión locales; no se hizo sesión real nueva |

## Validación pendiente

La corrección aún **no** demuestra que el juego inicie en inglés. Antes de publicar hace falta una nueva prueba real autorizada de Age of Empires IV: Anniversary Edition en Cloud Gaming, primero con la app en español y luego con la app en inglés, registrando locale solicitado y pantalla inicial observada. Si el juego sigue en español, la siguiente investigación debe limitarse a las opciones internas de idioma del título, solo con permiso para iniciar esa sesión y navegar sus menús. Hasta entonces no se afirma que el idioma interno esté corregido.

## Sources

[1] https://learn.microsoft.com/en-us/gaming/gdk/docs/features/common/game-streaming/game-streaming-optimizing-your-game?view=gdk-2604 — Development Best Practices for Xbox Game Streaming
[2] https://learn.microsoft.com/en-us/gaming/gdk/docs/services/community/localized-strings/live-language-fallback?view=gdk-2604 — Xbox Services Language Fallback
[3] https://learn.microsoft.com/en-us/xbox/gdk/docs/gdk-dev/game-principles/localization/console_supported_languages?view=gdk-2604 — Console-supported languages
[4] https://learn.microsoft.com/en-us/gaming/gdk/docs/services/community/localized-strings/live-localized-strings-config?view=gdk-2604 — Configuring localized strings in Partner Center
[5] https://www.rfc-editor.org/rfc/rfc9110.html — RFC 9110: HTTP Semantics, Accept-Language
