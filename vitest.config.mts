import path from "node:path";
import {
	defineConfig,
	configDefaults as vitestConfigDefaults,
} from "vitest/config";

// `import.meta.dirname`, not `__dirname`: vite accepts three config
// loaders (bundle / runner / native) and only the bundle loader shims CJS
// globals — this file stays strict-ESM-clean so it loads identically under
// all three, whichever any tool or future default picks. The `.mts` extension
// is part of that: package.json declares no module type, so the native loader
// would read a `.ts` config as CommonJS.
const configDir = import.meta.dirname;

export default defineConfig({
	test: {
		globals: true,
		// Intercept `@/lib/logger` once for the whole suite — see
		// `vitest.setup.ts` for the rationale and the escape hatch for
		// tests that want to assert on log calls.
		setupFiles: ["./vitest.setup.ts"],
		// Only the Postgres project owns Docker. A selected ordinary test never
		// imports the migration graph or provisions an unused database. Projects
		// share the default sequence group and worker pool; no extra concurrency.
		// Inline projects inherit this root config (setup file, aliases, timeouts).
		projects: [
			{
				test: {
					name: "unit",
					exclude: ["**/*.postgres.test.{ts,tsx}"],
				},
			},
			{
				test: {
					name: "postgres",
					include: ["**/*.postgres.test.{ts,tsx}"],
					globalSetup: ["./lib/case-store/sql/__tests__/globalSetup.ts"],
				},
			},
		],
		// Files whose change must force a `--changed` run (the fast local
		// loop, `npm run test:changed`) to re-run the WHOLE suite: they sit
		// OUTSIDE every test's import graph yet change how all tests execute.
		// Vitest's defaults cover package.json and this config, and it adds the
		// setup files itself. Nova adds a lockfile-only bump that leaves
		// package.json untouched, and shared database preparation. Vitest exposes
		// this option only at the root, so migration/template changes
		// conservatively force the whole selected run. CI never scopes: its test
		// jobs run every test file, sharded. Patterns match the absolute paths
		// `vitest --changed` feeds picomatch.
		forceRerunTriggers: [
			...vitestConfigDefaults.forceRerunTriggers,
			"**/package-lock.json",
			"**/lib/case-store/sql/__tests__/{globalSetup,applyMigrations}.ts",
			"**/lib/case-store/migrations/**",
		],
		// Vitest's defaults choose the console reporter (a quieter one under a
		// coding agent) and add GitHub's annotations and job summary inside
		// Actions. A `--reporter` flag would replace that whole list, so the CI
		// timing report joins it here instead.
		reporters: [
			...vitestConfigDefaults.reporters,
			...(process.env.CI ? ["./scripts/ci/test-timings.ts"] : []),
		],
		// Keep transformed modules on disk between runs. The key covers each
		// file's content, this config and the resolve aliases, and the cache sits
		// under node_modules, so a reinstall clears it. `vitest --clearCache`
		// clears it by hand.
		fsModuleCache: true,
		// Test code is ESM like the app: a stray `__dirname` or `require` fails
		// here as it would in production.
		injectCjsGlobals: false,
		// A failing `test.each` row names itself in full.
		taskTitleValueFormatTruncate: 0,
		// Fixtures that touch the Postgres container get longer than the 10 s
		// hook default. Test bodies keep Vitest's 5 s default.
		hookTimeout: 30_000,
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
		// `e2e/tests/**` and the separate `e2e/react-profile/**` harness are
		// Playwright specs (`*.spec.ts`), not Vitest tests. They import
		// `@playwright/test` and would throw under Vitest, so exclude them. The
		// `e2e/lib/**` helpers stay in (Vitest runs tests there, for example
		// e2e/lib/caseWorkspaceSeed.test.ts covers its sibling seed module).
		exclude: [
			...vitestConfigDefaults.exclude,
			"**/.claude/worktrees/**",
			"e2e/tests/**",
			"e2e/react-profile/**",
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
