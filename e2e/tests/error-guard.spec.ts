// This test deliberately generates a report and therefore uses Playwright's
// base fixture; the guard under test is attached and asserted explicitly.
import { expect, test } from "@playwright/test";
import { attachErrorGuard } from "../lib/errorGuard";

test("a handled client report fails the guard even when the browser emits no exception or console error", async ({
	page,
	baseURL,
}) => {
	if (!baseURL) throw new Error("The guard needs its app origin");
	await page.route("**/__error_guard__", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><title>Error guard</title><main>Ready</main>",
		}),
	);
	await page.route("**/api/log/error", (route) =>
		route.fulfill({ status: 204 }),
	);
	await page.goto("/__error_guard__");
	const guard = attachErrorGuard(page, baseURL);
	guard.assertNoErrors();
	const sent = page.waitForResponse(
		(response) => new URL(response.url()).pathname === "/api/log/error",
	);
	expect(
		await page.evaluate(() =>
			navigator.sendBeacon(
				"/api/log/error",
				new Blob(
					[
						JSON.stringify({
							message: "Handled operation failed",
							source: "manual",
						}),
					],
					{ type: "application/json" },
				),
			),
		),
	).toBe(true);
	expect((await sent).status()).toBe(204);
	expect(guard.errors).toHaveLength(1);
	expect(guard.errors[0]).toContain("Handled operation failed");
	expect(() => guard.assertNoErrors()).toThrow(/Unexpected browser errors/);
});
