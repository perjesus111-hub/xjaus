# Release notes template

> Replace bracketed fields. Do not publish until artifacts, checksums, and the release commit are verified.

# XJAUS [version]

## Highlights

- [User-visible change, with a concrete limit if applicable]

## Requirements and limits

- Linux x86_64 or Windows x64 package availability: [state exact artifacts].
- Cloud Gaming requires an eligible account, supported region, and the service requirements in effect.
- Codec, bitrate, resolution, frame rate, controller behavior, and hardware decode depend on negotiation, hardware, drivers, runtime, and network.
- [Any version-specific known limitation].

## Downloads and verification

| Artifact | SHA-256 |
| --- | --- |
| `[artifact]` | `[sha256]` |

Download only from this release. Verify files against the attached `SHA256SUMS`:

```sh
sha256sum -c SHA256SUMS
```

## Upgrade notes

- [Migration, setting reset, or compatibility note; otherwise say “None.”]

## Validation performed

- [Exact command and result]
- [Exact package/archive verification]

## Known issues

- [Known issue, affected scope, and workaround if verified]

## Security

Do not attach tokens, account caches, device-code responses, or unredacted logs to issues. See `SECURITY.md` for private reporting guidance.