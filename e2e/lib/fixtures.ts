import { test as base, expect } from "@playwright/test";
import { attachErrorGuard } from "./errorGuard";

/**
 * Shared Playwright `test` with a strict error guard wired into the `page`
 * fixture: every page-driving test FAILS if the browser logs an app
 * `console.error`, throws an uncaught exception (`pageerror`), or gets a
 * same-origin 5xx — even when the test's own assertions would otherwise pass.
 * This catches breakage the explicit assertions don't name (a route 500ing, a
 * client crash, a React error).
 *
 * The guard itself lives in `errorGuard.ts` (`attachErrorGuard`) so a test that
 * opens its OWN pages via `browser.newContext()` — the two-user
 * `multiplayer.spec.ts`, which the single-`page` fixture can't cover — applies
 * the identical strict guard to each page.
 *
 * No benign-error allowlist by design — the suite avoids generating benign
 * errors at the source (e.g. the sign-in test stubs Google's page with a 200
 * rather than aborting). See `errorGuard.ts` for the one structural exclusion.
 *
 * Caveat: this covers BROWSER events on the page, not the `request` fixture's
 * traffic (the get-session tests assert their status directly). Server stdout
 * (e.g. a `MetadataLookupWarning`) is not a browser error and is out of scope.
 */
export const test = base.extend({
	page: async ({ page, baseURL }, use) => {
		const guard = attachErrorGuard(page, baseURL);
		await use(page);
		guard.assertNoErrors();
	},
});

export { expect };
