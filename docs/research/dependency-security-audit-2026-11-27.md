# Transitive dependency security audit, 2026-11-27

The November 27 routine update left ten alerts on `main`. This change updates
every lockfile path affected by those advisories, using the first parent
releases that adopt the fixes where available.
[Dependabot alerts](https://github.com/voidcraft-labs/commcare-nova/security/dependabot)

| Dependency path | Change and Nova usage |
| --- | --- |
| `@ai-sdk/workflow → @ai-sdk/provider-utils → undici` | Resolve the nested `^7.28.0` requirement to `7.30.2`. This clears the eight alerts for `7.29.1`. The Workflow package stays on 1.0.70 and the existing `ai` override still shares Nova's installed SDK. Nova's chat transport continues to use the same send and reconnect APIs. [Undici release](https://github.com/nodejs/undici/releases/tag/v7.30.2) |
| `@sentry/nextjs → @sentry/bundler-plugins → glob → minimatch` | Move Sentry 11.9.0 to 11.11.0, the first release with the Glob 14 range. The existing Next integration still owns request instrumentation and the same-origin tunnel. Nova's build still manages deferred source map upload and stripping. The release adds a warning for missing Next instrumentation and changes tunnel tracing. Nova supplies its instrumentation and uses `tunnelRoute`, so the deprecated standalone tunnel helper has no caller here. [11.10.0 release](https://github.com/getsentry/sentry-javascript/releases/tag/11.10.0), [11.11.0 release](https://github.com/getsentry/sentry-javascript/releases/tag/11.11.0), [Glob upgrade](https://github.com/getsentry/sentry-javascript/pull/26014) |
| `@google-cloud/cloud-sql-connector → @google-cloud/sql → google-gax → rimraf` | Move the connector from 1.12.1 to 1.13.0. Its new SQL Admin and HTTP client ranges remove the old `rimraf → glob` paths. The connector's IAM Postgres refresh probe now uses a Postgres startup message. Nova uses the public `Connector.getOptions` stream and keeps its existing IAM, IP type and pool lifecycle configuration. [Connector release](https://github.com/GoogleCloudPlatform/cloud-sql-nodejs-connector/releases/tag/v1.13.0), [IAM probe change](https://github.com/GoogleCloudPlatform/cloud-sql-nodejs-connector/pull/631) |
| `shadcn → ts-morph → @ts-morph/common → minimatch` | Apply shadcn's 4.23.1 security patch, which moves `ts-morph` to 28. Nova imports `shadcn/tailwind.css`, whose published bytes match 4.23.0. [shadcn security patch](https://github.com/shadcn-ui/ui/pull/12845) |
| `testcontainers@12.2.2 → archiver-utils@5.0.2 → glob` | Scope a Glob 14.0.6 override to this versioned test dependency path. Its CommonJS `glob.sync` call still works and resolves Minimatch 11.0.9. Archiver 7 remains on the callable factory that Testcontainers expects. Remove the override when Testcontainers ships a release that removes this path. [Upstream report](https://github.com/testcontainers/testcontainers-node/issues/1641), [Upstream replacement PR](https://github.com/testcontainers/testcontainers-node/pull/1652) |

The [Glob advisory](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) requires
14.0.2 or later and the
[Minimatch advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249) requires
11.0.1 or later for the affected major lines. The test-only Minimatch 5.1.9
used by `readdir-glob` is outside the affected range.

Strict `npm ci` exercised the existing postinstall checks. Local compatibility
checks compared the old and new archive helper's glob expansion and checked
tar entries and bytes on the updated tree. Focused tests cover Workflow chat
transport, the case-store connection, the bootstrap entrypoint, and Nova's
error reporting. PR CI exercises the complete built image, the installed
Sentry instrumentation, the production-pinned credential stack, Testcontainers
Postgres, browser smoke and the static proof lane.

The lockfile audit no longer reports Undici, Glob, or Minimatch. The separate
high-severity Zod finding and its parent entry remain in the development-only
pinned React profiler dependency tree.
