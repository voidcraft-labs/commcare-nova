import { test as base, expect } from "@playwright/test";

/**
 * Shared Playwright `test` with a strict error guard wired into the `page`
 * fixture: every page-driving test FAILS if the browser logs a `console.error`,
 * throws an uncaught exception (`pageerror`), or gets a same-origin 5xx — even
 * when the test's own assertions would otherwise pass. This catches breakage the
 * explicit assertions don't name (a route 500ing, a client crash, a React error).
 *
 * Note this only covers BROWSER errors and our app's HTTP responses. Server
 * stdout noise (e.g. google-auth's `MetadataLookupWarning` when the
 * credential-free emulator env has no metadata server) is not an error and is
 * not in scope — the request still succeeds.
 */

/**
 * Known-benign, pre-existing browser errors. Keep this list TINY and documented
 * — each entry is a real thing to eventually fix, not a blanket mute.
 */
const ALLOWED_BROWSER_ERRORS: RegExp[] = [
	// The sign-in test intentionally aborts the navigation to accounts.google.com
	// (it only asserts the hand-off), which Chromium logs as a failed resource.
	/net::ERR_ABORTED/i,
	// AccountMenu renders a session-pending placeholder during SSR, but the
	// client resolves the session on first paint, so React discards that SSR
	// subtree. Pre-existing app hydration mismatch; recovers fine.
	// TODO(app): gate the placeholder on a mounted flag so SSR and the first
	// client render agree (components/ui/AccountMenu.tsx).
	/Hydration failed because the server rendered/i,
	/server rendered HTML didn't match the client/i,
	/hydration-mismatch/i,
];

function isAllowed(text: string): boolean {
	return ALLOWED_BROWSER_ERRORS.some((re) => re.test(text));
}

function safeOrigin(url: string): string | undefined {
	try {
		return new URL(url).origin;
	} catch {
		return undefined;
	}
}

export const test = base.extend({
	page: async ({ page, baseURL }, use) => {
		const errors: string[] = [];
		const baseOrigin = baseURL ? safeOrigin(baseURL) : undefined;

		page.on("pageerror", (err) => {
			if (!isAllowed(err.message)) errors.push(`pageerror: ${err.message}`);
		});
		page.on("console", (msg) => {
			if (msg.type() !== "error") return;
			const text = msg.text();
			if (!isAllowed(text)) errors.push(`console.error: ${text}`);
		});
		page.on("response", (res) => {
			if (res.status() < 500) return;
			if (baseOrigin && safeOrigin(res.url()) === baseOrigin) {
				errors.push(`HTTP ${res.status()} ${new URL(res.url()).pathname}`);
			}
		});

		await use(page);

		expect(
			errors,
			`Unexpected browser errors / 5xx during this test:\n  ${errors.join("\n  ")}`,
		).toEqual([]);
	},
});

export { expect };
