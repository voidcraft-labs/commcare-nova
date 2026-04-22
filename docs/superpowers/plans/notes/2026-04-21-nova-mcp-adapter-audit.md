# OAuth-provider × Firestore adapter audit

Result of running `scripts/verify-oauth-adapter.mts` against the real
`commcare-nova` Firestore project using `gcloud auth application-default`
credentials. See "Script output" at the bottom for raw stdout.

## Environment notes (deviations from the Phase B1 plan body)

Two small deviations from the script body specified in the plan. Both are
toolchain/packaging artifacts, not design decisions. Flag to whoever reads
this doc before wiring `oauthProvider()` into `lib/auth.ts`.

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
  singleton in `lib/db/firestore.ts`. This doesn't apply once
  `oauthProvider()` is wired into `lib/auth.ts` proper — that path runs
  under Next's own loader, not tsx.

## Other findings from the run

- **Plugin collection names are NOT remapped by `firestoreAdapter`'s
  `collections:` option.** The option only covers the four core Better
  Auth tables (`users`, `sessions`, `accounts`, `verificationTokens`).
  The `oauthProvider()` plugin writes directly to `oauthClient` (no
  prefix honored) at the Firestore root. The `verify_oauth_*` prefix this
  script tried to impose had no effect on plugin-owned collections —
  DCR in the script created a real `oauthClient/<id>` doc at the project
  root, which the script now deletes at the end of `run()` via a
  `where("clientId", "==", <dcr client_id>)` + delete pass.
  **Consequence when `oauthProvider()` is wired into `lib/auth.ts`:**
  decide whether to accept `oauthClient`, `oauthAccessToken`,
  `oauthRefreshToken`, `oauthConsent` as root collections, or namespace
  them via the plugin's `schema: { <table>: { modelName } }` override
  (see `@better-auth/oauth-provider` docs).

- **Field names are camelCased, arrays are JSON-stringified.** The doc
  written by DCR stored `clientId`, `name`, `redirectUris`, `scopes`,
  `grantTypes`, `responseTypes` as top-level string fields, with arrays
  serialized via `JSON.stringify`. `createdAt`/`updatedAt` are native
  Firestore timestamps. That serialization is an artifact of how
  `better-auth-firestore` maps Better Auth's relational schema onto
  Firestore — not a bug, but worth knowing before writing any Firestore
  queries that filter by, e.g., `redirect_uris`.

- **AS-metadata is served via RFC 8414 path insertion.** With an issuer
  path of `/api/auth` (from `baseURL: http://localhost:3000` + Better
  Auth's default `/api/auth` prefix), the plugin registers the route at
  `/.well-known/oauth-authorization-server/api/auth` — the issuer path is
  inserted AFTER the well-known segment, not prefixed before it. That's
  what Better Auth's warning prints verbatim in the captured output. The
  script probes the bare path deliberately to confirm path insertion is
  in effect; a 404 there is the expected signal. The standalone Next
  route mounting `oauthProviderAuthServerMetadata(auth)` must live at the
  path-insertion location (`/.well-known/oauth-authorization-server/api/auth`),
  not at the bare `/.well-known/oauth-authorization-server`. Not an
  adapter issue.

## Audit table

| Hook | Adapter support | Notes |
|---|---|---|
| create(oauthClient, ...) | pass | DCR POST returned 200 with a full client payload; confirmed via direct Firestore read that a document was written to the `oauthClient` root collection. |
| findUnique(oauthClient, { clientId }) | pass | Implicitly exercised: the plugin reads for clientId uniqueness before insert, and the DCR call succeeded without collision errors. |
| update(oauthClient, { client_secret_hash, client_secret_expires_at }) | unknown | Not exercised. Public-client DCR doesn't write a secret; secret rotation has no endpoint in the registered routes. Revisit when confidential-client registration is added or when a secret-rotation flow is implemented. |
| findUnique(oauthRefreshToken, { token_hash }) | unknown | Not exercised. Introspect bypassed the token lookup by rejecting at the client-auth layer (HTTP 401 `invalid_client`). Confirm when the auth-code→token exchange is implemented and can be driven end-to-end. |
| delete(oauthRefreshToken, { token_hash }) | unknown | Not exercised. Same gate as above — depends on a real refresh-token issuance, so revisit alongside the refresh/rotate flow. |
| findUnique(oauthConsent, { userId_clientId }) | unknown | Not exercised. Requires an authenticated authorize call that lands on the consent page; revisit when the consent page is wired. |
| create(oauthConsent) inside transaction | unknown | Same as above. `better-auth-firestore` docs claim transaction support; confirm by driving an end-to-end consent grant once `/consent` is wired. |
| findMany(oauthAccessToken, { userId }) | unknown | Not exercised. Admin revocation listing is a separate endpoint not hit by this script. Revisit if/when an admin UI exposes token revocation. |

For any "no" that blocks the rollout, either contribute the hook upstream,
rename the affected collection via the plugin's
`schema: { <table>: { modelName } }` override to route it through a
different adapter code path, or fall back to a hand-rolled endpoint for
the specific hook and document why.

**Bottom line for gating the plugin rollout:** the adapter survives plugin
boot, the plugin registers routes, DCR round-trips cleanly to Firestore,
and the introspect endpoint fails at the HTTP layer rather than crashing
the adapter. No red flag blocks wiring `oauthProvider()` into
`lib/auth.ts` or exposing the AS-metadata route. The `unknown` rows are
all token-/consent-lifecycle hooks that only get exercised by an actual
OAuth dance — pick those up with a second verification pass once the
authorize + token-exchange + consent flows are wired end-to-end, rather
than trying to synthesize them here.

## Script output

Raw stdout from `GOOGLE_CLOUD_PROJECT=commcare-nova BETTER_AUTH_SECRET=… npx tsx scripts/verify-oauth-adapter.mts`:

```
WARN [Better Auth]: Please ensure '/.well-known/oauth-authorization-server/api/auth' exists. Upon completion, clear with silenceWarnings.oauthAuthServerConfig.

[AS metadata (bare path — 404 expected, see RFC 8414 path insertion)] HTTP 404


[DCR (public client)] HTTP 200
{"client_id":"eEhrfKDAPiTfprreSylRWrbjGjbBzrqp","scope":"openid nova.read nova.write","client_id_issued_at":null,"client_name":"verify","redirect_uris":["http://localhost:9999/cb"],"token_endpoint_auth_method":"none","grant_types":["authorization_code","refresh_token"],"response_types":["code"],"public":true,"disabled":false}

[Introspect bogus token] HTTP 401
{"error_description":"missing required credentials","error":"invalid_client"}

[cleanup] Deleted 1 oauthClient doc(s) for clientId=eEhrfKDAPiTfprreSylRWrbjGjbBzrqp.

Done. Inspect output, then fill the audit table.
```
