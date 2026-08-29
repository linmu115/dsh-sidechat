# Sidechat 0.4.3 — Core capability negotiation

- Stop rejecting Annotation Core solely because its version is outside the old `0.1.x` release line.
- Accept any non-empty Core version that advertises every feature required by the current Sidechat surface.
- Keep `dsh-annotation-core` as an optional `*` runtime peer, so Maintenance can exercise arbitrary plugin version combinations.
- Remove the build-time Git dependency on Core and compile against a local structural capability contract, eliminating the last fixed Core commit from Sidechat.
