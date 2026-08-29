# 0.4.0 - DSH 0.1.2-alpha.1 native Sessions migration

- Removed the deleted `connection.api.sessions` and `dsh-client-runtime` paths.
- Parent and child model routes now come from each Session's native `modelSelection` projection.
- Sidechat transcript data now comes from `uiConversation.binding(id).target('chat')`; Session snapshots remain responsible only for lifecycle state.
- Model-setting saves remain hot loaded: mounted children receive the new route at the next request boundary without cancelling an active response.
- Alpha-only client services are declared through `dsh.client.inject`; remaining installable DSH packages use open ranges. This release contains no RC2 compatibility adapter.

Verification: typecheck, unit tests including model-route serialization/hot reload, client bundle build, package dry run, and live alpha profile loading.
