# Sidechat 0.3.1: open Better Sidebar peer range

## Context

Sidechat 0.3.0 declared `dsh-better-sidebar ^0.16.0`. Because caret ranges below
1.0 stop at the next minor version, Maintenance rejected Better Sidebar 0.17.x
before staging even though the client service surface consumed by Sidechat is
still available.

## Change

- Keep `dsh-better-sidebar` as a required peer so package managers still prompt
  when the runtime service is missing.
- Change its version range to `*`; Sidechat no longer decides which Better
  Sidebar versions an experimental Maintenance profile may exercise.
- Keep runtime injection authoritative: a deployment without the
  `betterSidebar` service remains inactive instead of silently substituting an
  implementation.

Compatibility is now established by Maintenance preview, staging, and runtime
verification rather than by an artificial peer-version ceiling.
