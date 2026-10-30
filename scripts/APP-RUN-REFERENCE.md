# AppRun reference provenance and review

**Status: experimental; NOT approved for releases.** No production trust anchor or signing key is established by this document. A matching digest is not reviewer approval, publisher authentication, or permission to publish. The release verifier must remain fail-closed until a separately authorized trust anchor and independently reviewed reference are installed.

## Inputs and observed experiment

Generate the reference from reviewed builder source and the build-time patch, **not from the candidate or another AppImage**. The observed local checkout is based on commit `3259031dda1650176811da81cc91b35219eed10c` but has uncommitted changes; the commit alone does not identify these inputs. Record the actual reviewed source revision and dirty-tree state for any approval.

- `package-lock.json`, lockfile version 3, SHA-256 `8bef31b95fab6139c78d85961435bf6c91faae485eb34095c9a05ac7e4d1c4e4`. It pins `app-builder-lib` **26.15.3**, npm tarball integrity `sha512-2VnyWkqsP5v5XbBhL3tD5Syx8iNPBYsoU7kY4S2fz7wg8Rj/nztWKCUzGKaFRTv0Xwf3/H058CR1Kvtd/3lRow==`.
- Installed `node_modules/app-builder-lib/out/targets/appimage/appImageUtil.js`: SHA-256 `4d3b63afc9939ace718e0b3537e2b1508c15fde7fd030206cbe207bcb6a8f030`.
- `scripts/secure-appimage-preload.cjs`: SHA-256 `0150986fd4ba800b974935566183e86012f841be8701356423aa4472920d5628`. It patches the generator in memory and rejects unsupported generator versions/content.
- Node.js `v26.7.0`. Effective configuration below matches `verifyLauncher` in `scripts/linux-verify.cjs`: no EULA or MIME file.
- Local output: 3,426 bytes, SHA-256 `7bc1a3c5817e3c60ed285ca35a217639be1d1d3f478fdb81b768b01e8e2feb1d`. **This is an experimental observation, not an approved reference digest.**

## Independent reconstruction evidence (2026-10-30)

Two separate scratch directories, separate empty npm caches and clean HOME/environment were populated with the checkout's package.json and lockfile using `npm ci --ignore-scripts --no-audit --no-fund` against the npm registry. Each installed 336 packages without lifecycle scripts. npm's integrity checks establish consistency with the supplied lockfile, not independent trust in that lockfile or publisher. Separately fetched `https://registry.npmjs.org/app-builder-lib/-/app-builder-lib-26.15.3.tgz` and computed its SHA-512: it matched the exact lockfile SRI above. Its extracted generator and both freshly installed copies each matched SHA-256 `4d3b63afc9939ace718e0b3537e2b1508c15fde7fd030206cbe207bcb6a8f030`. The separately copied preload in both trees matched `0150986fd4ba800b974935566183e86012f841be8701356423aa4472920d5628`.

Both reconstructions ran the documented generator invocation under independent `bwrap --unshare-all` sandboxes, with network unshared, clean environment, `/usr` and their respective trees read-only, private `/tmp`, and the same host Node binary bind-mounted read-only. The two complete output files compared byte-for-byte equal, as did each with a clean-environment generation outside bwrap: 3,426 bytes, SHA-256 `7bc1a3c5817e3c60ed285ca35a217639be1d1d3f478fdb81b768b01e8e2feb1d`. The scratch copies are ephemeral, not an approved durable reference. Node v26.7.0 executable SHA-256 `ad19784f7e90ba789a099eccba77ede8dc90a778c424f1c10a70fed3ff903fdc`; npm 11.19.0. These are same-host, same-lockfile, same-Node reproductions, not independent host/toolchain or reviewer verification. Installation itself was not sandboxed; lifecycle scripts were disabled. The host, Node distribution, registry, lockfile origin, preload authorship, and complete dependency tree were not independently authenticated.

Configuration was traced from the current dirty checkout, not the candidate: package.json SHA-256 `d2d6020ed74b06cbb85426d49f3a92d6d27136f6d6e9bb6b9c7a01e464c61b46`; scripts/packaging.cjs SHA-256 `e4484094771a78e7e3af68c760f763dbcd770c2b6748c8c4fdb628e50434fcb3`. Its Linux invocation preloads the patch and sets the AppImage artifact name/output, with no generator-field overrides. Builder `linuxPackager.js`, `appInfo.js`, `LinuxTargetHelper.js`, `AppImageTarget.js` and `appImageUtil.js` trace `name=xjaus`, `productName=XJAUS`, `syncDesktopName=true` and `desktopName=io.github.xjaus.xjaus.desktop` to the five documented template fields. No file associations or configured license exist, and the build-resources root has no auto-discovered license/eula .txt or .html; the root `LICENSE` is not the searched resource. The Linux desktop executable arguments override the builder's default `--no-sandbox` desktop argument with `--class=io.github.xjaus.xjaus`. This is source/config tracing, not an instrumented production packaging run; external configuration, environment or later changes require revalidation.

Full generated script was inspected: it discovers APPDIR if absent, prepends AppDir paths to PATH and library/data/schema variables, sets BIN to `$APPDIR/xjaus`, installs an EXIT trap unless `APPIMAGE_EXIT_AFTER_INSTALL` is set, rejects an exact `--no-sandbox` argument before probing, and refuses when `unshare -Ur true` fails, disabling the trap before both refusals. On ordinary exit the trap execs the binary with the original quoted argument array; there is no generated EULA block. The script includes unused error/yesno/check_dep helpers. In a disposable fake AppDir with controlled unshare and executable stubs, failed probe and explicit `--no-sandbox` each returned 1 without invoking the executable; a successful fake probe forwarded a spaced argument and class argument intact; `APPIMAGE_EXIT_AFTER_INSTALL=1` returned without invoking the executable. This is a launcher logic test, not evidence of actual Electron sandbox enforcement: `unshare` is a PATH-resolved heuristic and success does not prove Chromium sandboxing, and an untrusted AppDir/PATH, other flags or host can affect execution. No real AppImage, Electron process, namespace isolation or production build was exercised in this experiment.

No reviewer approval, release authorization, key creation or publication is implied. An independent reviewer must inspect the actual bytes and inputs and approve a protected durable reference before use as a release trust anchor.

## Reproduce in a trusted, isolated environment

Use independently obtained, reviewed inputs, a trusted Node executable and dependencies reconstructed from the pinned lockfile and integrity-checked package sources. Verify the complete dependency tree, Node distribution, environment and build configuration independently; hashing only the three files below does not establish their provenance or protect against a compromised host. Do not load candidate files as code. From the repository root, with a pre-existing private scratch directory in `SCRATCH`, run:

```sh
set -eu
umask 077
test "$(node --version)" = v26.7.0
test "$(node -p "require('app-builder-lib/package.json').version")" = 26.15.3
printf '%s\n' \
 '8bef31b95fab6139c78d85961435bf6c91faae485eb34095c9a05ac7e4d1c4e4  package-lock.json' \
 '4d3b63afc9939ace718e0b3537e2b1508c15fde7fd030206cbe207bcb6a8f030  node_modules/app-builder-lib/out/targets/appimage/appImageUtil.js' \
 '0150986fd4ba800b974935566183e86012f841be8701356423aa4472920d5628  scripts/secure-appimage-preload.cjs' | sha256sum -c -
node -r "$PWD/scripts/secure-appimage-preload.cjs" -e "process.stdout.write(require('app-builder-lib/out/targets/appimage/appImageUtil').generateAppRunScript({DesktopFileName:'io.github.xjaus.xjaus.desktop',ExecutableName:'xjaus',ProductName:'XJAUS',ProductFilename:'XJAUS',ResourceName:'appimagekit-xjaus'}))" > "$SCRATCH/AppRun.reference"
wc -c "$SCRATCH/AppRun.reference"
sha256sum "$SCRATCH/AppRun.reference"
```

This runs the trusted generator and preload, not the generated launcher. Preserve the full output and record all input identities, commands, output size and hash. If any source, dependency, Node version, configuration, environment, patch or packaging behavior changes—or a check fails—stop; independently review the change and regenerate. Do not automatically update an approved digest.

## Independent review and comparison

1. A reviewer independent of the candidate build verifies input provenance and configuration against the actual release build, reviews the complete generator and patch and the **entire generated AppRun**, including sandbox failure and argument handling. Reproduce separately from the same authenticated inputs and compare complete reference files byte-for-byte (`cmp -s reference-A reference-B`); inspect and resolve any difference. Record reviewer identity, date, input identities, exact reference bytes, size and digest, decision and authorization in a protected review record. No approval is implied here.
2. Only after explicit approval, preserve the approved reference and its review record in a trusted, immutable/authenticated location independent of the candidate. A change to any input invalidates the approval pending fresh review. Production key creation, custody, trust-anchor selection and publication require separate authorization.
3. Extract the candidate's unique, regular root `AppRun` as data with a trusted, bounded SquashFS parser; reject missing, duplicate, nonregular, oversized or malformed entries and extraction errors. Never execute the candidate AppImage, its runtime, or its AppRun. Compare **all bytes** of the extracted launcher against the approved reference, for example `cmp -s "$SCRATCH/AppRun.reference" "$SCRATCH/AppRun.candidate"`; any difference or error rejects. This comparison alone is not a complete release gate: authenticate the manifest and bind the verified artifact bytes to the eventual consumer without path-replacement races.
