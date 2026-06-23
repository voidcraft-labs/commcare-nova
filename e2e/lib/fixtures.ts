import { test as base, expect } from "@playwright/test";

/**
 * Shared Playwright `test` with a strict error guard wired into the `page`
 * fixture: every page-driving test FAILS if the browser logs a `console.error`,
 * throws an uncaught exception (`pageerror`), or gets a same-origin 5xx — even
 * when the test's own assertions would otherwise pass. This catches breakage the
 * explicit assertions don't name (a route 500ing, a client crash, a React error).
 *
 * There is no allowlist by design — the suite avoids generating benign errors at
 * the source (e.g. the sign-in test stubs Google's page with a 200 rather than
 * aborting). If a test legitimately needs to provoke an error, scope a
 * `page.removeListener`/local handler in that test rather than weakening this.
 *
 * Server stdout noise (e.g. google-auth's `MetadataLookupWarning` when the
 * credential-free emulator env has no metadata server) is not a browser error
 * and is out of scope — the request still succeeds.
 */

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
			errors.push(`pageerror: ${err.message}`);
		});
		page.on("console", (msg) => {
			if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
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
