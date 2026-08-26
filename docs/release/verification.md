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
- the packed tarball contains the host entry, browser entry, declarations, bundle patch, Manager Contract v2 panel, change notes, license, and both READMEs;
- the Manager panel binds one `model-select` to `dsh-sidechat/defaultModelRoute` with `apply: save` and `null` inheritance;
- Settings save produces a new Host revision and switches every mounted Sidechat without restarting the profile;
- fixed-route rejection falls back to each child session's parent, and rapid saves converge to the newest revision;
- the model submit gate prevents a new prompt from racing a switch without cancelling an answer already in progress;
- the GitHub Actions profile-mount job installs the tarball into the pinned DSH baseline and observes the side-chat UI journey.

Failure-isolation, hot-reload, removal, and current Workshop-baseline evidence remain `null` until the Workshop harness records them.
