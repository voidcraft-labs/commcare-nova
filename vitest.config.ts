import path from "node:path";
import {
	defineConfig,
	configDefaults as vitestConfigDefaults,
} from "vitest/config";

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
		// Vitest's `exclude` REPLACES the defaults rather than extending
		// them, so spread + append: node_modules / .git stay excluded,
		// plus we drop `.worktrees/**` to stop the main checkout's
		// `npm test` from globbing into git worktrees mounted under
		// `.worktrees/`.
		//
		// Why this stays safe inside future worktrees that inherit this
		// config: per the vitest docs, exclude patterns are matched
		// against paths *relative to* `root` (cwd-relative, not
		// absolute) via tinyglobby. From the main repo's vantage point,
		// a worktree test's root-relative path is
		// `.worktrees/foo/lib/...` and matches the pattern. From inside
		// a worktree (root = `.worktrees/foo/`) the same test's root-
		// relative path is `lib/...` — no `.worktrees` segment, no
		// match, no surprise filtering. Verified via picomatch against
		// both relative shapes.
		exclude: [...vitestConfigDefaults.exclude, "**/.worktrees/**"],
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "."),
		},
	},
});
