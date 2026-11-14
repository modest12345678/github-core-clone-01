# Standalone Git Forge (TypeScript / Node 22)

A standalone, GitHub-compatible git forge: no UI, one process serving git smart
HTTP, the REST v3 API, GraphQL and MCP from its own in-memory store. Built for
the make.fun "standalone git forge" bounty.

## Run

```
node main.ts
```

Node 22+ (erasable TypeScript runs natively; no transpile step, no
dependencies, standard library only).

Environment:

- `MAKEFUN_ENV_URL` — when set, the forge binds an ephemeral port, POSTs
  `{"port": <port>}` to `$MAKEFUN_ENV_URL/register`, then long-polls
  `$MAKEFUN_ENV_URL/done` until `{"done": true}` and exits 0.
- `MAKEFUN_SHOP_TOKEN` — the bearer token the suite presents; requests without
  a matching token get 401. Unset: any non-empty bearer is accepted.
- `MAKEFUN_LOGIN` — the login the token names (default `octocat`).

## Surfaces

| Surface | Path | Notes |
| --- | --- | --- |
| Git smart HTTP | `/{owner}/{repo}.git` | upload-pack protocol v2 (+v0 fallback), receive-pack v0 with report-status, side-band-64k, delete-refs; fast-forward only; shallow (deepen) support |
| REST v3 | `/api/v3` | user, meta, repos, contents (CRUD with sha guards), labels, issues, pulls, squash merge with 3-way conflict detection, pagination with `Link` headers |
| GraphQL v4 | `/api/graphql` | hand-rolled executor: introspection (`__type`, `__schema`), fragments, variables, aliases, include/skip, batching (array bodies), `createPullRequest` |
| MCP | `/mcp` | JSON-RPC 2.0 over Streamable HTTP: `initialize`, `server/discover`, `tools/list`, `tools/call` (8 tools on the same store) |

## Determinism

The store is in-memory and fully deterministic: ids come from fixed counters,
timestamps from a logical clock advanced one tick per mutating operation, and
no wall-clock time, randomness, port or date enters any stateful output. Two
runs of the same trial leave identical state exports.

## Layout

```
main.ts            entrypoint (bind, register, serve, exit 0 on done)
src/httpd.ts       HTTP plumbing, routing, auth
src/store.ts       domain store: repos, refs, issues, PRs, labels, clock
src/objects.ts     git object core (commits, trees, ancestry, tree writes)
src/packfile.ts    packfile codec (delta apply), pkt-line, sideband
src/smarthttp.ts   git smart HTTP: upload-pack v2+v0, receive-pack v0
src/rest.ts        REST v3 handlers
src/graphql.ts     GraphQL parser/executor/schema/introspection
src/mcp.ts         MCP JSON-RPC handlers
```

## License

MIT (see LICENSE).
