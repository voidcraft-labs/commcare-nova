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
		},
	},
});
