import path from "node:path";
import {
	defineConfig,
	configDefaults as vitestConfigDefaults,
} from "vitest/config";

// `import.meta.dirname`, not `__dirname`: vite accepts three config
// loaders (bundle / runner / native) and only the bundle loader shims CJS
// globals — this file stays strict-ESM-clean so it loads identically under
// all three, whichever any tool or future default picks.
const configDir = import.meta.dirname;

export default defineConfig({
	test: {
		globals: true,
		// Intercept `@/lib/logger` once for the whole suite — see
		// `vitest.setup.ts` for the rationale and the escape hatch for
		// tests that want to assert on log calls.
		setupFiles: ["./vitest.setup.ts"],
		// Boot one Postgres testcontainer per `vitest run` and seed
		// the case-store schema. Workers consume the connection URI
		// via `inject("postgresTestUrl")`. See
		// `lib/case-store/sql/__tests__/globalSetup.ts` for the
		// container-per-run + per-test BEGIN/ROLLBACK contract.
		globalSetup: ["./lib/case-store/sql/__tests__/globalSetup.ts"],
		// Files whose change must force the WHOLE suite to run under the
		// CI async-leak gate. That gate (`.github/workflows/ci.yml`) runs
		// `vitest --changed`, which otherwise restricts the run to test
		// files whose module import graph the PR touched — sound for leaks,
		// since the detector attributes every leaked resource to the single
		// test file that created it (no cross-file leak), so an unchanged
		// graph yields a byte-identical run. The inputs below sit OUTSIDE
		// every test's import graph yet change how all of them execute
		// (installed deps — including a lockfile-only bump that leaves
		// package.json untouched — this config, the global logger/motion
		// stubs, the shared Postgres container), so a change to any one
		// invalidates that optimization and must re-sweep everything.
		// Patterns match the absolute paths `vitest --changed` feeds
		// picomatch; note the no-trailing-`/**` form — vitest's own default
		// trigger appends `/**`, which silently fails to match a bare config
		// file there.
		forceRerunTriggers: [
			"**/package.json",
			"**/package-lock.json",
			"**/{vitest,vite}.config.*",
			"**/vitest.setup.ts",
			"**/lib/case-store/sql/__tests__/globalSetup.ts",
		],
		// Container boot is the long pole. 60 s default test timeout
		// applies to test bodies, not to globalSetup itself; raising
		// `hookTimeout` covers fixtures that touch the container.
		hookTimeout: 30_000,
		// Clear mock call history between tests so assertions like
		// `expect(log.warn).toHaveBeenCalledWith(...)` don't leak across
		// test boundaries. Implementations set via `.mockImplementation(...)`
		// inside a test persist (use `.mockRestore()` if that matters).
		clearMocks: true,
		// Vitest's `exclude` REPLACES the defaults rather than extending
		// them, so spread + append: node_modules / .git stay excluded,
		// plus we drop `.claude/worktrees/**` to stop the main checkout's
		// `npm test` from globbing into git worktrees, which the agent
		// harness mounts under `.claude/worktrees/`. Without this the main
		// run discovers every test twice (once per checkout), doubling the
		// run and stalling worker teardown.
		//
		// Why this stays safe inside future worktrees that inherit this
		// config: per the vitest docs, exclude patterns are matched
		// against paths *relative to* `root` (cwd-relative, not
		// absolute) via tinyglobby. From the main repo's vantage point,
		// a worktree test's root-relative path is
		// `.claude/worktrees/foo/lib/...` and matches the pattern. From
		// inside a worktree (root = `.claude/worktrees/foo/`) the same
		// test's root-relative path is `lib/...` — no `.claude/worktrees`
		// segment, no match, no surprise filtering.
		// `e2e/tests/**` are Playwright specs (`*.spec.ts`), not Vitest tests —
		// they import `@playwright/test` and would throw under Vitest, so exclude
		// them. The `e2e/lib/**` helpers stay in (Vitest imports them — e.g. the
		// session-cookie contract test at lib/db/__tests__ pulls e2e/lib/session).
		exclude: [
			...vitestConfigDefaults.exclude,
			"**/.claude/worktrees/**",
			"e2e/tests/**",
			// Under the async-leak gate ONLY, skip the transport-contract suite.
			// It drives the REAL `WorkflowChatTransport`, whose SSE parser calls
			// `response.body.pipeThrough(new TextDecoderStream())` — and Node's
			// web-streams `pipeThrough`/`pipeTo` machinery leaves internal
			// promises pending FOREVER even after the pipe is fully drained and
			// closed (reduced to a two-line repro with no app or SDK code:
			// drain `new Response("x").body.pipeThrough(new TextDecoderStream())`
			// → 3 flagged promises; a trailing settle delay does not clear them).
			// That is the same benign-but-unfixable class the global Sentry /
			// motion mocks in vitest.setup.ts handle at the module boundary —
			// but here the pipes are per-call inside the library under test, so
			// the boundary is the gate itself. The suite still runs in every
			// normal `vitest run` / CI test job; only `--detect-async-leaks`
			// skips it — and the exemption blinds the gate ONLY to the
			// third-party transport's internals: the resume ROUTE's own async
			// discipline (timers, LISTEN subscriptions, stream teardown) stays
			// fully leak-gated via streamResume.integration.test.ts, which
			// drives the same endpoint without the transport. Remove when
			// Node's pipe internals (or the detector) stop flagging a drained
			// pipe.
			...(process.argv.includes("--detect-async-leaks")
				? ["**/transportContract.integration.test.ts"]
				: []),
		],
	},
	resolve: {
		alias: {
			"@": path.resolve(configDir, "."),
			// Resolve `server-only` to its own no-op shim so tests of
			// server modules (which mark themselves with the import as
			// a build-time client-bundle defense) can load under
			// vitest's Node runner. The published `server-only` package
			// exports a thrower under its `default` condition (Next.js
			// resolves to `react-server` at build time and gets a
			// no-op); vitest doesn't honor the `react-server`
			// condition, so an explicit alias to the shipped empty
			// file keeps the marker import functional in production
			// builds while letting test-time imports pass through.
			"server-only": path.resolve(
				configDir,
				"node_modules/server-only/empty.js",
			),
		},
	},
});
