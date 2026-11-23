#!/usr/bin/env python3
"""Fail closed on unsupported TLS versions or registry sources in both locks."""
import pathlib
import re
import sys
import tomllib

ROOT = pathlib.Path(__file__).resolve().parents[1]
REGISTRY = 'registry+https://github.com/rust-lang/crates.io-index'


def check(packages):
    found = set()
    errors = []
    for package in packages:
        name = package['name']
        if name not in ('webpki-roots', 'rustls-webpki'):
            continue
        version = package['version']
        match = re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version)
        parts = tuple(map(int, match.groups())) if match else ()
        if name == 'webpki-roots':
            safe = parts[:1] == (1,) and parts >= (1, 0, 10)
            if safe:
                found.add(name)
            safe = safe or version == '0.26.11'
        else:
            safe = parts[:2] == (0, 103) and parts >= (0, 103, 16)
            if safe:
                found.add(name)
        if not safe or package.get('source') != REGISTRY:
            errors.append(f'{name} {version}: version/registry outside approved TLS policy')
    for name in sorted({'webpki-roots', 'rustls-webpki'} - found):
        errors.append(f'{name}: no corrected primary version')
    return errors


if __name__ == '__main__':
    failed = False
    for manifest in ('src-tauri', 'backend-windows'):
        with (ROOT / manifest / 'Cargo.lock').open('rb') as lock:
            packages = tomllib.load(lock)['package']
        errors = check(packages)
        if errors:
            failed = True
            for error in errors:
                print(f'{manifest}: {error}', file=sys.stderr)
        else:
            print(f'{manifest}: TLS lock PASS')
    sys.exit(int(failed))
