# Sidechat 0.3.2: version-open peer compatibility

Sidechat no longer uses peer semver ranges as an installation gate. Every host, UI, shared Core, Sidebar, React, and Cordis peer now declares `*` while preserving whether the peer is required or optional.

Development dependencies and the lockfile remain pinned to the tested DSH baseline so builds stay reproducible. Runtime compatibility is determined by the services and UI contracts that are actually present; a future incompatible DSH release may fail at the affected feature instead of being rejected before installation.

Validation: `pnpm typecheck`, `pnpm build`, `pnpm test`, and package dry-run.
