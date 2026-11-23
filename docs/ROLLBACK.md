# Rollback / Reversión

## Source only

Record the base and branch tip before making changes (`git rev-parse HEAD`, `git status --short`). To compare or return to the verified baseline without changing any development checkout, use a separate detached worktree at `dfc4bfd710bbd6e4fc1b6a240cba356631332e65`. Keep the private branch for evidence. If reverting an integrated change, review a new `git revert` commit against its actual history rather than resetting shared `main`. None of these steps changes an installed app.

## Installed application (separate approval required)

Inventory exact package or AppImage path, platform, install scope, current version and known-good prior bytes. Verify source and digests independently, record a dry run of the platform rollback, and protect any authorized non-secret backup. Do not copy credential stores or change another Xbox client. Older versions can restore legacy credentials and may lack security fixes; prefer a clean isolated profile and fresh sign-in rather than importing old application data. If recovery would require restoring credentials or disabling sandboxing, stop and reassess. Confirm version, launch and sign-in in an approved isolated test before replacing anything. No package rollback has been rehearsed by this source review.
