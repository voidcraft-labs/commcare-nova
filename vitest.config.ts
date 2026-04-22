import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		// Intercept `@/lib/logger` once for the whole suite — see
		// `vitest.setup.ts` for the rationale and the escape hatch for
		// tests that want to assert on log calls.
		setupFiles: ["./vitest.setup.ts"],
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
