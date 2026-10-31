# Release preparation: validation only, publishing disabled

This document is a design and limitation record, not authorization. There is no release job or publishing entry point in the validation workflow. The experimental local publisher remains disabled. Do not merge, create/move release tags, sign, create releases, or upload assets without separate owner authorization.

## Separate decisions and identities

1. Independently review the exact candidate bytes, their build provenance and AppRun outside the publication gate. Record version, build commit, eventual release commit, filenames, byte lengths and SHA-256 digests. A checksum by itself does not authenticate provenance or approval. Any changed byte or release identity requires review again.
2. The owner separately authorizes production signing under an established custody, backup and recovery policy. A new CI build is a different set of bytes and requires its own review; an attestation about a CI build does not describe a local build.
3. The owner separately authorizes publication after review, signing and protections have been verified. A PR review alone does not authenticate approval of the bytes. Two keys or two accounts are not evidence of two independent human reviewers.

## Future protected publication — not implemented or enabled

A future implementation must obtain its trusted policy and byte-approval record independently of PR-controlled content, restrict its eligible event, commit and tag using authenticated GitHub context and permissions, and bind those to the approved record. Validation jobs must have no effective write credential. Publishing must run only inside an actually configured protected environment, with minimal job-level permissions and immutable full-SHA action pins. Protect workflow and tag changes; specify owner bypass and recovery explicitly, without pretending a second independent person exists. A caller-supplied field claiming a ref, permission or approval is not proof of any of them.

The publisher must check exactly the approved five names, sizes and hashes immediately before any irreversible operation and verify downloaded published bytes afterward. It must not reopen attacker-controlled mutable paths after verification or offer a manual fallback that bypasses the same requirements. A trustworthy quiescent staging directory and host are preconditions unless a stronger binding is implemented and tested; sequential path checks are not an atomic directory snapshot. A compromised host, GitHub administrator, CI runtime or dependency remains a separate risk.

An environment gate, protected tags, logs and checksums are not a cryptographic anti-rollback anchor. Specify rollback/revocation and recovery before claiming stronger resistance. Confirm repository/plan availability and actual configured settings via API: an available feature is not an enabled protection. Retention and deletion of CI artifacts and asset/tag immutability must be explicitly reviewed.

## What the current checks do and do not do

`validation.yml` is a read-only CI workflow. `scripts/ci-candidate-manifest.cjs` is a nonpublishing local consistency checker, not an approval mechanism. Its records, policy, claimed refs and permissions are supplied by its caller; no reviewer identity, effective GitHub token permission, provenance, trusted policy or later consumer is authenticated. Its tests use synthetic data. Green tests or a mock transport are not a release gate or proof that future uploads are identical to reviewed bytes.

Actual protected-environment policy, trusted byte approval, protected tags/workflow, production signing and publication are not established by this document. Keep NO-GO until those controls are configured, independently reviewed, exercised in their real trust boundary, and explicitly authorized.
