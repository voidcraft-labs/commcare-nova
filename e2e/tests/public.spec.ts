import { expect, test } from "../lib/fixtures";
import { urlHost } from "../lib/url";

/**
 * Public (unauthenticated) smoke checks — no seeded session, no seeded data.
 *
 * These are the credential-free checks that also run against a live deployment
 * (`SMOKE_BASE_URL=https://commcare.app`). Every production auth outage we've
 * shipped (e.g. the Node 22.23 undici regression) surfaced as exactly what
 * these assert: the home page failing to render its sign-in button, or
 * `/api/auth/*` returning 500 instead of a normal response — invisible to
 * Sentry, caught only by a real request.
 */

test.describe("public surface", () => {
	test("home page renders the Google sign-in button", async ({ page }) => {
		await page.goto("/");

		// The sign-in entry point. If the home page is broken (build failure,
		// auth shell throwing) this is the first thing to disappear.
		const signIn = page.getByRole("button", { name: "Sign in with Google" });
		await expect(signIn).toBeVisible();
		await expect(signIn).toBeEnabled();

		// The tagline is server-rendered into the landing markup — a cheap proof
		// the page rendered its content, not an error boundary.
		await expect(
			page.getByText("Build CommCare apps from conversation"),
		).toBeVisible();
	});

	test("GET /api/auth/get-session is healthy (200, not a 500)", async ({
		request,
	}) => {
		// THE regression net. With no cookie this must return 200 (a null
		// session), and it exercises the auth datastore + rate limiter over the
		// Cloud SQL connector's outbound credential stack — the exact path that
		// 500'd under the undici / node-fetch regressions, taking prod login down
		// with nothing in Sentry.
		const res = await request.get("/api/auth/get-session");
		expect(
			res.status(),
			`GET /api/auth/get-session returned ${res.status()} — the auth boundary is broken (this is how prod login outages have looked)`,
		).toBe(200);
	});

	test("clicking 'Sign in with Google' hands off to Google's OAuth screen", async ({
		page,
	}) => {
		// The real login flow, end-to-end, right up to the point Google takes
		// over: click → the client POSTs /api/auth/sign-in/social → the server
		// returns the consent URL → the browser navigates to accounts.google.com.
		// The ONLY step this can't cover is authenticating ON Google (which needs
		// a real account); everything our own code owns is exercised. If
		// sign-in/social 500s (the prod-outage signature), no redirect happens and
		// this fails.
		//
		// Stub Google's page with an empty 200 instead of loading it — the
		// assertion is purely "the click sends you to Google", so the test stays
		// hermetic and never depends on Google being reachable. (A stub rather than
		// an abort so it logs no console error, which the error guard would catch.)
		await page.goto("/");
		await page.route("**/accounts.google.com/**", (route) =>
			route.fulfill({ status: 200, contentType: "text/html", body: "" }),
		);
		// Match on the parsed hostname, not a substring (which would also match
		// `accounts.google.com.evil.test`).
		const googleHandoff = page.waitForRequest(
			(req) => urlHost(req.url()) === "accounts.google.com",
			{ timeout: 15_000 },
		);
		await page.getByRole("button", { name: "Sign in with Google" }).click();
		await googleHandoff;
	});
});
