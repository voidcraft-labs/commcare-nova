/**
 * Global test setup — runs once per test file, before the tests themselves.
 *
 * It gates React `act(...)` discipline, then replaces three modules at the
 * boundary. First of those: intercept the structured logger so
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
import { afterEach, vi } from "vitest";

/**
 * Fail any test that lets a React state update land outside `act(...)`.
 *
 * React reports those as a console warning, and vitest's reporter drops
 * console output on a passing test in a non-TTY (CI, or any piped run), so
 * the warnings were invisible to every automated check while the tests they
 * came from silently asserted a pre-update render. They are never cosmetic:
 * an update outside `act` means the work escaped the test — the assertions
 * ran against DOM that React had not committed yet, and the commit landed
 * during a later test or after teardown.
 *
 * Attribution is best-effort: the warning fails whichever test was running
 * when the escaped update finally committed, which is usually — but not
 * always — the test that started it. The message says so.
 */
const escapedActUpdates: string[] = [];
const reportConsoleError = console.error;

console.error = (...args: unknown[]): void => {
	if (typeof args[0] === "string" && args[0].includes("not wrapped in act(")) {
		escapedActUpdates.push(String(args[1] ?? "an unnamed component"));
		return;
	}
	reportConsoleError(...args);
};

afterEach(() => {
	if (escapedActUpdates.length === 0) return;
	const components = [...new Set(escapedActUpdates)].join(", ");
	escapedActUpdates.length = 0;
	throw new Error(
		`React committed an update to ${components} outside act(...) while this test ran.\n\n` +
			"The update escaped the test, so the assertions above it ran against a render " +
			"React had not committed. The usual causes are a bare `element.focus()` (it " +
			"dispatches focus synchronously and Base UI menus and tooltips react to it), a " +
			"bare `await new Promise(resolve => setTimeout(resolve, 0))` used to settle a " +
			"popup, and a mounted component whose async load was never awaited.\n\n" +
			"Wrap the interaction in `act(...)`, or await the settled UI with " +
			"`findBy*` / `waitFor`. `@/__tests__/helpers/baseUiInteractions` has " +
			"act-wrapped helpers for the focus, keyboard-activation, and popup-settle " +
			"cases.\n\n" +
			"If the named component is not one this test renders, the update was started " +
			"by an earlier test that returned before its work committed — fix it there.",
	);
});

vi.mock("@/lib/logger", () => ({
	log: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		critical: vi.fn(),
	},
}));

/** Reporting is an external boundary. Keep the methods observable so reporter
 * tests can assert payloads without initializing the SDK or sending events.
 * Production instrumentation loads through Next and is verified separately;
 * this substitute does not establish SDK initialization or delivery. */
vi.mock("@sentry/nextjs", () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
	setTag: vi.fn(),
	setUser: vi.fn(),
}));

/** A React lifecycle test must not start an unowned session fetch merely by
 * importing application chrome. Supply a settled browser-session boundary;
 * tests needing a particular identity replace the auth hook explicitly.
 * Native browser journeys own actual client/session wiring, while PostgreSQL
 * contracts keep the real server auth adapter. Missing client methods fail
 * rather than silently issuing requests outside the test's owned transport. */
vi.mock("@/lib/auth-client", () => ({
	authClient: {
		useSession: () => ({ data: null, isPending: false, error: null }),
	},
}));

/** Keep Motion's real components, presence ownership and completion callbacks.
 * Ordinary DOM tests select the library's public instant-animation mode; native
 * browser tests own interpolated layout, focus and exit timing. Instant mode
 * still schedules real frame/completion work, which each test must await in act.
 * Import the actual module so a test's explicit adapter spy cannot replace this
 * configuration object during setup. */
const { MotionGlobalConfig } =
	await vi.importActual<typeof import("motion/react")>("motion/react");
MotionGlobalConfig.skipAnimations = true;
