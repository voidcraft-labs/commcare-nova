import path from "node:path";
import { defineConfig } from "vitest/config";

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
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "."),
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
				__dirname,
				"node_modules/server-only/empty.js",
			),
		},
	},
});
