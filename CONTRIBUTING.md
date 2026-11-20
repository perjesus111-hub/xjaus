# Contributing / Contribución

Use an isolated branch from the intended base. Keep changes focused, retain license and attribution notices, and keep manifest and lockfile changes together. A change to stream or auth behavior should trace the renderer, preload/main boundary and both Rust runners. Prefer regression tests with synthetic inputs.

For static checks without installing dependencies:

```sh
node --test scripts/verify-version-alignment.cjs
python3 scripts/check-tls-locks.py
git diff --check
```

For broader validation in a separately approved test environment, use [the CI workflow](.github/workflows/validation.yml) as the command matrix. Review test subprocesses first: the full suite is not static-only. Report exact commands, tested commit, platforms, skips and limitations. Do not add generated packages, accounts, session data, private evidence or unreviewed screenshots. Use the [issue template](.github/ISSUE_TEMPLATE/bug_report.md) for ordinary bugs and [private reporting](SECURITY.md) for security issues.

En español: trabaja en una rama aislada, usa datos sintéticos y distingue comprobaciones estáticas de pruebas con ejecución y validación de paquetes.
