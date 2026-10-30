# Release preflight — publication disabled

**Publication is disabled.** Both the CLI and exported `runLocal` fail unconditionally before creating snapshots, invoking helpers or invoking a consumer. The retained-descriptor implementation remains in the source as unreachable experimental code; it is not approved for use. The critical trust and execution chain has not been fixed. Do not treat this as a completed publisher or release approval.

The exported `run` is a **pathname-based preflight only**, not a publication or consumption interface. It can create snapshots and invoke its verifier, including `7z` by default. It verifies a detached Ed25519 signature and hashes five candidates against the manifest. Partial snapshots may remain after failure. Its output is not an approval record, and no same-UID isolation or post-preflight integrity is guaranteed.

For preflight, use a trusted host, tools, checkout and independently authenticated Ed25519 public key. Supply exactly five nonempty regular, singly linked files named `XJAUS-VERSION-x86_64.AppImage`, `XJAUS-VERSION-linux-x86_64.rpm`, `XJAUS-VERSION-linux-amd64.deb`, `XJAUS-VERSION-win-x64-setup.exe`, and `XJAUS-VERSION-win-x64-setup.msi`, with numeric `MAJOR.MINOR.PATCH` version. The independently produced manifest must contain exactly five distinct lines, each lowercase SHA-256, two spaces and the filename only, optionally followed by a final LF. Its detached signature is raw 64-byte Ed25519, not Minisign format; the public key is PEM SubjectPublicKeyInfo. The operator must independently pin and protect the trusted key. A valid signature does not prove provenance, reproducibility, native Windows behavior, Authenticode signatures, or arbitrary payload safety.

## Tests

```bash
node --test scripts/verify-release-gate.cjs scripts/verify-packaging.cjs
```

Tests generate temporary keys, never production keys. Historical tests of the disabled experimental local chain are explicitly skipped; they do not establish that chain is safe. Preflight unit tests use injected verifiers, while packaging tests separately exercise the real verifier.
