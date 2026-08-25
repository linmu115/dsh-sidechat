# Release verification

This file records author-side release evidence. Workshop verification and Registry admission remain independent maintainer decisions.

## Clean-checkout gate

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm pack --dry-run --json
```

Acceptance criteria:

- the annotation-core development dependency resolves from a public, full Git commit rather than a local path;
- unit tests and bundle-contract tests pass;
- the packed tarball contains the host entry, browser entry, declarations, bundle patch, license, and README;
- the GitHub Actions profile-mount job installs the tarball into the pinned DSH baseline and observes the side-chat UI journey.

Failure-isolation, hot-reload, removal, and current Workshop-baseline evidence remain `null` until the Workshop harness records them.
