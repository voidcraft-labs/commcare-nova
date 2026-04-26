/**
 * Global test setup — runs once per test file, before the tests themselves.
 *
 * Responsibility: intercept the structured logger at the module boundary so
 * passing tests never print to stderr. Production code emits diagnostic
 * warnings and errors through `@/lib/logger` — replaying those emissions
 * during a green run adds noise that drowns real failure output. Mocking
 * the module here replaces every log method with a `vi.fn()` stub, so:
 *
 *   - Tests that don't care about logging see nothing.
 *   - Tests that DO care import `log` from `@/lib/logger` and assert on
 *     `expect(log.warn).toHaveBeenCalledWith(...)` directly — the stubs
 *     preserve full call-tracking semantics.
 *
 * `clearMocks: true` in `vitest.config.ts` wipes each stub's call history
 * between tests so one test's assertions can't leak into another's.
 */
import { vi } from "vitest";

vi.mock("@/lib/logger", () => ({
	log: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		critical: vi.fn(),
	},
}));
