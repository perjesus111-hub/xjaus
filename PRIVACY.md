# Privacy / Privacidad

XJAUS contacts Microsoft/Xbox services for device sign-in, account/catalog and console information, and streaming. Those services handle requests according to their own policies. A 1.2.4 start requires fresh interactive sign-in: authentication is held in memory, rather than saved and restored by XJAUS. UI preferences, window state and application data such as favorites can remain on disk; this is not a no-local-data mode.

Sign-out is local and attempts legacy credential cleanup. Failed cleanup can leave older credentials behind; earlier clients may still use them. Local sign-out does not revoke Microsoft tokens. Do not delete credential stores or restore old profile data as part of a routine rollback.

Treat diagnostic reports, logs, crash dumps, screenshots and build paths as potentially identifying even if redaction is applied. Review copies before sharing. Omit authorization headers, cookies, tokens, device codes, gamertags, console identifiers, account caches and home paths. Never attach a credential store or raw profile.

En español: XJAUS contacta con servicios de Microsoft/Xbox. La sesión 1.2.4 es efímera, pero las preferencias y otros datos locales pueden persistir. Revisa y sanea informes, capturas y registros antes de compartirlos.
