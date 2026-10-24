import { docsHostPeer } from "../../lib/docsHostPeer";
import { attachErrorGuard, closePageWithUnload } from "../../lib/errorGuard";
import { expect, test } from "../../lib/fixtures";
import { openPage, reloadPage } from "../../lib/pageLoads";
import { urlHost } from "../../lib/url";

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
		await openPage(page, "/");

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
		// This verifies the anonymous auth response over HTTP. A missing cookie
		// need not query the datastore; authenticated checks own that path.
		const res = await request.get("/api/auth/get-session");
		expect(
			res.status(),
			`GET /api/auth/get-session returned ${res.status()} — the auth boundary is broken (this is how prod login outages have looked)`,
		).toBe(200);
		expect(await res.json()).toBeNull();
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
		await openPage(page, "/");
		await page.route("**/accounts.google.com/**", (route) =>
			route.fulfill({ status: 200, contentType: "text/html", body: "" }),
		);
		// Match on the parsed hostname, not a substring (which would also match
		// `accounts.google.com.evil.test`).
		const googleHandoff = page.waitForRequest(
			(req) => urlHost(req.url()) === "accounts.google.com",
			{ timeout: 15_000 },
		);
		await Promise.all([
			googleHandoff,
			page.getByRole("button", { name: "Sign in with Google" }).click(),
		]);
	});
});

// The native peer changes only Host; the actual app serves every successful
// page, search index and navigation response.
test("docs search highlights real records, follows keyboard selection and recovers after refresh", async ({
	browser,
	baseURL,
}) => {
	test.skip(
		!baseURL ||
			!["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseURL).hostname),
		"This check owns the local docs-host forwarding peer.",
	);
	if (!baseURL) throw new Error("Missing docs peer URL");
	const peer = await docsHostPeer(baseURL);
	try {
		const context = await browser.newContext();
		try {
			const page = await context.newPage();
			const guard = await attachErrorGuard(page, peer.origin);
			try {
				await openPage(page, peer.origin);
				const heading = page.getByRole("heading", {
					name: "Documentation",
					exact: true,
				});
				await expect(heading).toBeVisible();
				const sidebar = page.locator("#nd-sidebar");
				const headingBox = await heading.boundingBox();
				const sidebarBox = await sidebar.boundingBox();
				expect(headingBox).not.toBeNull();
				expect(sidebarBox).not.toBeNull();
				if (!headingBox || !sidebarBox)
					throw new Error("Missing docs geometry");
				expect(headingBox.x).toBeGreaterThanOrEqual(
					sidebarBox.x + sidebarBox.width,
				);
				await sidebar.getByRole("button", { name: /^Search/ }).click();
				let search = page.getByRole("dialog", { name: "Search", exact: true });
				await search
					.getByRole("combobox", { name: "Search", exact: true })
					.fill("attachment questions");
				await expect(search.getByRole("status")).toContainText(
					"Couldn't search the docs. You can refresh the page to try again.",
				);
				await reloadPage(page);
				await sidebar.getByRole("button", { name: /^Search/ }).click();
				search = page.getByRole("dialog", { name: "Search", exact: true });
				const input = search.getByRole("combobox", {
					name: "Search",
					exact: true,
				});
				await input.fill("attachment questions");
				const results = search.getByRole("option");
				await expect(results.first()).toBeVisible();
				await expect(results.first()).toContainText("Attachment questions");
				await expect
					.poll(() =>
						page.evaluate(() => CSS.highlights.get("fd-search")?.size ?? 0),
					)
					.toBeGreaterThan(0);
				// The optimizer warned about this valid pseudo-element. Prove the
				// production stylesheet still styles actual browser highlights.
				await expect
					.poll(() =>
						results
							.first()
							.evaluate(
								(el) =>
									getComputedStyle(el, "::highlight(fd-search)")
										.textDecorationLine,
							),
					)
					.toBe("underline");
				await input.fill("WAV");
				const audioRow = search
					.getByRole("option")
					.filter({ hasText: "Attaches an audio file" })
					.first();
				await expect(audioRow).toBeVisible();
				await expect(audioRow).toContainText("MP3, WAV");
				await expect(
					search.getByRole("group", {
						name: "Question What the worker does Files it accepts",
						exact: true,
					}),
				).toContainText("Attaches an audio file");
				await input.press("ArrowDown");
				await input.press("ArrowUp");
				await input.press("Enter");
				await expect(search).toHaveCount(0);
				await expect(page).toHaveURL(/\/attachments(?:#.*)?$/);
				await expect(
					page.getByRole("heading", {
						name: "Attachment questions",
						exact: true,
					}),
				).toBeVisible();
				await openPage(page, `${peer.origin}/page-that-does-not-exist`);
				await expect(
					page.getByRole("heading", {
						name: "I couldn't find that page",
						exact: true,
					}),
				).toBeVisible();
				await page
					.getByRole("button", { name: "Back to docs", exact: true })
					.click();
				await expect(heading).toBeVisible();
				await page.setViewportSize({ width: 375, height: 812 });
				const mobileSearch = page
					.locator("#nd-subnav")
					.getByRole("button", { name: "Open search", exact: true });
				await expect(mobileSearch).toBeVisible();
				await mobileSearch.click();
				await expect(
					page.getByRole("dialog", { name: "Search", exact: true }),
				).toBeVisible();
				await page.keyboard.press("Escape");
				expect(
					await page.evaluate(
						() => document.documentElement.scrollWidth <= innerWidth,
					),
				).toBe(true);
			} finally {
				await closePageWithUnload(page);
				await guard.assertNoErrors();
			}
		} finally {
			await context.close();
		}
	} finally {
		await peer.close();
	}
});
