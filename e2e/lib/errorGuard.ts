/**
 * Strict browser-error evidence for one page, including its departing document.
 * Browser events cover live documents. Chromium can deliver an unload beacon
 * to the server without emitting any Playwright request/console event, so a
 * forwarding transport observer also records report attempts in localStorage.
 * That synchronous record survives reload and page close; the context owns it.
 */
import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { urlOrigin } from "./url";

export interface ErrorGuard {
	/** Live browser events; persisted transport evidence is added on assertion. */
	readonly errors: string[];
	/** Call after page close when possible, and before closing its context. */
	assertNoErrors(): Promise<void>;
}

/** Run the app's pagehide cleanup before checking its departing error evidence.
 * Playwright's default close can destroy the target without that lifecycle. */
export async function closePageWithUnload(page: Page): Promise<void> {
	if (page.isClosed()) return;
	await Promise.all([
		page.waitForEvent("close"),
		page.close({ runBeforeUnload: true }),
	]);
}

export async function attachErrorGuard(
	page: Page,
	baseURL: string | undefined,
): Promise<ErrorGuard> {
	const errors: string[] = [];
	const baseOrigin = baseURL ? urlOrigin(baseURL) : undefined;
	const evidenceKey = `__nova_e2e_error_guard_${randomUUID()}`;
	page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
	page.on("console", (msg) => {
		if (msg.type() !== "error") return;
		const text = msg.text();
		// Chromium resource noise is covered by the independent HTTP observer.
		if (!text.startsWith("Failed to load resource")) {
			errors.push(`console.error: ${text}`);
		}
	});
	page.on("response", (res) => {
		if (res.status() >= 500 && urlOrigin(res.url()) === baseOrigin) {
			errors.push(`HTTP ${res.status()} ${new URL(res.url()).pathname}`);
		}
	});
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (
			request.method() === "POST" &&
			url.origin === baseOrigin &&
			url.pathname === "/api/log/error"
		) {
			errors.push(`client report: ${request.postData() ?? "empty payload"}`);
		}
	});

	function observeReportTransport({
		origin,
		key,
	}: {
		origin: string | undefined;
		key: string;
	}): void {
		// Installing in the current document and before every later app script
		// must not wrap the same transport twice.
		const installed = Symbol.for(key);
		if (Reflect.get(window, installed)) return;
		Reflect.set(window, installed, true);
		function record(urlValue: string | URL, method: string): void {
			let url: URL;
			try {
				url = new URL(urlValue, location.href);
			} catch {
				// Let the native transport retain its own invalid-URL behavior.
				return;
			}
			if (
				method.toUpperCase() === "POST" &&
				url.origin === origin &&
				url.pathname === "/api/log/error"
			) {
				// Do not await Blob.text() or a Node binding: the document can die
				// before either runs. One marker is sufficient to fail the guard.
				localStorage.setItem(key, `client report attempted: ${url.pathname}`);
			}
		}
		const sendBeacon = navigator.sendBeacon;
		navigator.sendBeacon = function (url, data) {
			record(url, "POST");
			return Reflect.apply(sendBeacon, this, [url, data]);
		};
		const fetch = window.fetch;
		window.fetch = function (input, init) {
			record(
				input instanceof Request ? input.url : input,
				init?.method ?? (input instanceof Request ? input.method : "GET"),
			);
			return Reflect.apply(fetch, this, [input, init]);
		};
	}
	const observer = { origin: baseOrigin, key: evidenceKey };
	await page.addInitScript(observeReportTransport, observer);
	await page.evaluate(observeReportTransport, observer);

	return {
		errors,
		async assertNoErrors() {
			const storage = await page.context().storageState();
			for (const origin of storage.origins) {
				const evidence = origin.localStorage.find(
					(entry) => entry.name === evidenceKey,
				);
				if (evidence && !errors.includes(evidence.value)) {
					errors.push(evidence.value);
				}
			}
			expect(
				errors,
				`Unexpected browser errors / 5xx during this test:\n  ${errors.join("\n  ")}`,
			).toEqual([]);
		},
	};
}
