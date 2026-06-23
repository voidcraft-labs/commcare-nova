import { test as base, expect } from "@playwright/test";
import { urlOrigin } from "./url";

/**
 * Shared Playwright `test` with a strict error guard wired into the `page`
 * fixture: every page-driving test FAILS if the browser logs an app
 * `console.error`, throws an uncaught exception (`pageerror`), or gets a
 * same-origin 5xx — even when the test's own assertions would otherwise pass.
 * This catches breakage the explicit assertions don't name (a route 500ing, a
 * client crash, a React error).
 *
 * No benign-error allowlist by design — the suite avoids generating benign
 * errors at the source (e.g. the sign-in test stubs Google's page with a 200
 * rather than aborting). The one structural exclusion below is NOT an allowlist:
 * Chromium logs failed resource loads (a 404 favicon, a third-party font) as
 * `console.error`, but those are NETWORK failures, not app JS errors — and a
 * same-origin server 5xx is already caught by the response handler. Excluding
 * them scopes the guard to genuine app errors rather than browser network noise.
 *
 * Caveat: this covers BROWSER events on the page, not the `request` fixture's
 * traffic (the get-session tests assert their status directly). Server stdout
 * (e.g. a `MetadataLookupWarning`) is not a browser error and is out of scope.
 */

/** Chromium's prefix for a failed resource load — a network failure, not app JS. */
function isResourceLoadFailure(text: string): boolean {
	return text.startsWith("Failed to load resource");
}

export const test = base.extend({
	page: async ({ page, baseURL }, use) => {
		const errors: string[] = [];
		const baseOrigin = baseURL ? urlOrigin(baseURL) : undefined;

		page.on("pageerror", (err) => {
			errors.push(`pageerror: ${err.message}`);
		});
		page.on("console", (msg) => {
			if (msg.type() !== "error") return;
			const text = msg.text();
			if (isResourceLoadFailure(text)) return;
			errors.push(`console.error: ${text}`);
		});
		page.on("response", (res) => {
			if (res.status() < 500) return;
			if (baseOrigin && urlOrigin(res.url()) === baseOrigin) {
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
