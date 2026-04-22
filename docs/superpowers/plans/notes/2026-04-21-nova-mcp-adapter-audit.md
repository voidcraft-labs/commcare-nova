# OAuth-provider × Firestore adapter audit

Result of running `scripts/verify-oauth-adapter.mts` against the real
`commcare-nova` Firestore project using `gcloud auth application-default`
credentials. See "Script output" at the bottom for raw stdout.

## Environment notes (deviations from the Phase B1 plan body)

Two small deviations from the script body specified in the plan. Both are
toolchain/packaging artifacts, not design decisions. Flag to whoever reads
this during Phase B implementation.

- **Extension `.mts` instead of `.ts`.** `better-auth-firestore@1.1.4`
  declares `exports.require` at `./dist/index.cjs`, but that file is not
  published — only the ESM `dist/index.js` ships. With the project root
  missing `"type":"module"`, tsx loads a plain `.ts` script as CJS, Node
  walks the `require` condition, and the package resolver dies with
  `Cannot find module '…/better-auth-firestore/dist/index.cjs'`. `.mts`
  pins the entry to ESM, which routes through the `import` condition that
  resolves the file that actually exists. Credibility signal: the adapter
  author hasn't self-tested the package's CJS path.

- **`getDb()` inlined from `lib/db/firestore.ts`.** Even with the entry as
  ESM, tsx still compiles `.ts` dependencies as CJS (the project root
  still lacks `"type":"module"`). ESM named-import of a CJS module fails on
  esbuild's cjs-module-lexer output for transformed TS. The inline
  `new GoogleFirestore({ …same opts… })` is byte-equivalent to the
  singleton in `lib/db/firestore.ts`. When Phase B2 wires `oauthProvider()`
  into `lib/auth.ts` proper, this doesn't apply — that path runs under
  Next's own loader, not tsx.

## Other findings from the run

- **Plugin collection names are NOT remapped by `firestoreAdapter`'s
  `collections:` option.** The option only covers the four core Better
  Auth tables (`users`, `sessions`, `accounts`, `verificationTokens`).
  The `oauthProvider()` plugin writes directly to `oauthClient` (no
  prefix honored) at the Firestore root. The `verify_oauth_*` prefix this
  script tried to impose had no effect on plugin-owned collections —
  DCR in the script created a real `oauthClient/<id>` doc at the project
  root, which the verification cleaned up after inspection.
  **Consequence for Phase B2:** decide whether to accept `oauthClient`,
  `oauthAccessToken`, `oauthRefreshToken`, `oauthConsent` as root
  collections, or namespace them via the plugin's `schema: { … }` override
  (see `@better-auth/oauth-provider` docs).

- **Field names are camelCased, arrays are JSON-stringified.** The doc
  written by DCR stored `clientId`, `name`, `redirectUris`, `scopes`,
  `grantTypes`, `responseTypes` as top-level string fields, with arrays
  serialized via `JSON.stringify`. `createdAt`/`updatedAt` are native
  Firestore timestamps. That serialization is an artifact of how
  `better-auth-firestore` maps Better Auth's relational schema onto
  Firestore — not a bug, but worth knowing before writing any Firestore
  queries that filter by, e.g., `redirect_uris`.

- **AS-metadata endpoint is not at `/.well-known/oauth-authorization-server`.**
  The plugin (and Better Auth's warning) expects the path to include the
  plugin base — i.e., `/api/auth/.well-known/oauth-authorization-server`.
  This is fine: Phase B3 will add a standalone `/.well-known/...` Next
  route that proxies or re-serves the metadata at the root path required
  by RFC 8414. Not an adapter issue.

## Audit table

| Hook | Adapter support | Notes |
|---|---|---|
| create(oauthClient, ...) | pass | DCR POST returned 200 with a full client payload; confirmed via direct Firestore read that a document was written to the `oauthClient` root collection. |
| findUnique(oauthClient, { clientId }) | pass | Implicitly exercised: the plugin reads for clientId uniqueness before insert, and the DCR call succeeded without collision errors. |
| update(oauthClient, { client_secret_hash, client_secret_expires_at }) | unknown | Not exercised. Public-client DCR doesn't write a secret; secret rotation has no endpoint in the registered routes. Revisit during Phase B auth-code-flow E2E or confidential-client registration. |
| findUnique(oauthRefreshToken, { token_hash }) | unknown | Not exercised. Introspect bypassed the token lookup by rejecting at the client-auth layer (HTTP 401 `invalid_client`). Needs an auth-code→token exchange to verify. |
| delete(oauthRefreshToken, { token_hash }) | unknown | Not exercised. Same gate as above — depends on a real refresh-token issuance. |
| findUnique(oauthConsent, { userId_clientId }) | unknown | Not exercised. Requires an authenticated authorize call that lands on the consent page. Defer to the Phase B4 consent-page integration test. |
| create(oauthConsent) inside transaction | unknown | Same as above. `better-auth-firestore` docs claim transaction support; confirm by end-to-end consent grant once `/consent` is wired. |
| findMany(oauthAccessToken, { userId }) | unknown | Not exercised. Admin revocation listing is a separate endpoint not hit by this script. Revisit if/when admin UI exposes token revocation. |

For any "no", either contribute the hook upstream or keep OAuth tables on
a different storage engine via the plugin's `storage: { ... }` override
and document why.

**Bottom line for Phase B gating:** the adapter survives plugin boot, the
plugin registers routes, DCR round-trips cleanly to Firestore, and the
introspect endpoint fails at the HTTP layer rather than crashing the
adapter. No red flag blocking Phase B2/B3. The four `unknown` rows are
all token-/consent-lifecycle hooks that only get exercised by an actual
OAuth dance — pick those up during B4 with a second verification pass
rather than trying to synthesize them here.

## Script output

Raw stdout from `GOOGLE_CLOUD_PROJECT=commcare-nova npx tsx scripts/verify-oauth-adapter.mts`:

```
2026-04-22T03:10:17.970Z WARN [Better Auth]: Please ensure '/.well-known/oauth-authorization-server/api/auth' exists. Upon completion, clear with silenceWarnings.oauthAuthServerConfig.

[AS metadata] HTTP 404


[DCR (public client)] HTTP 200
{"client_id":"AkwsnHOrCnhSwwGkSAeywPjtAbYpKbcZ","scope":"openid nova.read nova.write","client_id_issued_at":null,"client_name":"verify","redirect_uris":["http://localhost:9999/cb"],"token_endpoint_auth_method":"none","grant_types":["authorization_code","refresh_token"],"response_types":["code"],"public":true,"disabled":false}

[Introspect bogus token] HTTP 401
{"error_description":"missing required credentials","error":"invalid_client"}

Done. Inspect output, then fill the audit table.
```
