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
- mounted-child request bindings are leased and isolated: they do not persist a Sidechat choice as DSH's global default model;
- the model submit gate prevents a new prompt from racing a switch without cancelling an answer already in progress;
- the GitHub Actions profile-mount job installs the tarball into the pinned DSH baseline and observes the side-chat UI journey.

Failure-isolation, hot-reload, removal, and current Workshop-baseline evidence remain `null` until the Workshop harness records them.

## 0.3.1 local release evidence (2026-08-28)

- `pnpm typecheck`: passed.
- `pnpm test`: 14 files / 95 tests passed.
- `pnpm build` and `pnpm pack --dry-run --json`: passed; the package is
  `@evylynn/dsh-sidechat@0.3.1` and includes the Manager panel, change note,
  Host and Client bundles, declarations, sources, license, and both READMEs.
- The Better Sidebar peer remains required for installation discovery but uses
  range `*`, so no Better Sidebar version is rejected by Sidechat metadata.

## 0.3.0 local release evidence (2026-08-26)

- `pnpm typecheck`: passed.
- `pnpm test`: 14 files / 95 tests passed.
- `pnpm build` and `pnpm pack`: passed; package `@evylynn/dsh-sidechat@0.3.0`, tarball `evylynn-dsh-sidechat-0.3.0.tgz` includes the Manager panel plus Host, Client, declarations, docs, and sources.
- Disposable DSH `0.1.1-rc.2` web profile with `dsh-resource-management@0.3.3`: 7 Playwright lanes passed and the one incompatible-core-only lane was expectedly skipped.
- The Manager lane mounted two independent real child sessions, saved `deepseek-v4-pro`, observed both open Sidechat labels reach the same new Host revision without refresh/restart, saved “跟随主会话”, observed both return to `deepseek-v4-flash`, then reloaded and recovered the same two child ids.
- The inherit round trip is also the integration regression for global-default isolation: the parent route remained Flash after both child bindings had used Pro.
