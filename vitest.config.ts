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
		exclude: [...vitestConfigDefaults.exclude, "**/.claude/worktrees/**"],
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
