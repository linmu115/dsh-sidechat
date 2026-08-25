# Better Sidebar 0.16 compatibility metadata

Date: 2026-08-25

## Problem

The Sidechat 0.2.0 package still declared `dsh-better-sidebar ^0.12.0`, while the official DSH `0.1.1-rc.2` `web` profile and the Maintenance installer use Better Sidebar `0.16.0`. The Sidechat integration uses the retained external-tab service contract and already runs against that implementation, but dependency preflight correctly rejected the stale peer range.

## Change

- Changed the required Better Sidebar peer range to `^0.16.0`.
- Kept `dsh-annotation-core >=0.1.0 <0.2.0` unchanged.
- No Sidechat runtime, annotation state, session data or UI behavior changed.

## Verification

- Typecheck passed.
- Full test suite passed: 6 files, 66 tests.
- Build and package passed.
- Disposable official `0.1.1-rc.2` profile with Better Sidebar `0.16.0`: 6 Playwright journeys passed and the intentionally inapplicable missing-Core lane was skipped.

## Rollback

Revert the commit containing this report. Do not deploy that reverted package alongside Better Sidebar 0.16.x because Maintenance will reject the incompatible peer range.
