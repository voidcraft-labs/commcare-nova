/**
 * The strict browser-error guard, shared by the `page`-fixture (`fixtures.ts`)
 * and any test that opens its OWN pages via `browser.newContext()` (the
 * two-user `multiplayer.spec.ts`, which the single-`page` fixture can't cover).
 *
 * Attaches to a `Page` and collects every app `console.error`, uncaught
 * `pageerror`, and same-origin 5xx into an array; `assertNoErrors()` fails the
 * test if any were seen. No benign-error allowlist by design — the one
 * structural exclusion (Chromium's "Failed to load resource" network noise) is
 * not app JS, and a same-origin server 5xx is caught separately by the response
 * handler.
 */

import { expect, type Page } from "@playwright/test";
import { urlOrigin } from "./url";

/** Chromium's prefix for a failed resource load — a network failure, not app JS. */
function isResourceLoadFailure(text: string): boolean {
	return text.startsWith("Failed to load resource");
}

/** A live error collector for one page + the assertion that fails on any entry. */
export interface ErrorGuard {
	/** The accumulated errors (read for a scoped assertion or debugging). */
	readonly errors: string[];
	/** Fail the test if any error / 5xx was seen. Call at the end of the test. */
	assertNoErrors(): void;
}

/**
 * Wire the strict guard onto `page`. `baseURL` scopes the 5xx check to the
 * app's own origin (a third-party 5xx is out of scope, same as the fixture).
 */
export function attachErrorGuard(
	page: Page,
	baseURL: string | undefined,
): ErrorGuard {
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

	return {
		errors,
		assertNoErrors() {
			expect(
				errors,
				`Unexpected browser errors / 5xx during this test:\n  ${errors.join("\n  ")}`,
			).toEqual([]);
		},
	};
}
