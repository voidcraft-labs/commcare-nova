import type { Page, Route } from "@playwright/test";
import type { HqChangesReview } from "@/lib/deployment/hqChanges/types";
import {
	BRING_IN_CHANGES_ACTION,
	HQ_CHANGES_DIALOG_TITLE,
	HQ_CHANGES_HEADING,
	hqChangesLead,
	PUBLISH_OVER_HQ_ACTION,
	SEE_WHAT_CHANGED_IN_HQ_ACTION,
	sincePhrase,
} from "@/lib/publish/hqChangesCopy";
import {
	PROJECT_SPACE_COMPATIBILITY_DOCS_URL,
	PROJECT_SPACE_COMPATIBILITY_SUPPORT_EMAIL,
} from "@/lib/publish/projectSpaceCompatibility";
import { expect, seedFor, test } from "../../lib/appFixtures";
import type { BroughtInApp } from "../../lib/bringInSeed";
import { closePageWithUnload } from "../../lib/errorGuard";
import { openBuilder, reloadBuilder } from "../../lib/pageLoads";
import { type RemovableRoutes, removableRoutes } from "../../lib/routes";
import { createSmokeContext } from "../../lib/smokeNetwork";

/**
 * The check when the builder opens, on the real builder against the
 * production server, over an app brought in from CommCare HQ (so the app
 * has a record, and the member a CommCare HQ connection). The check's route
 * and every route that would read CommCare HQ are answered here from
 * `page.route`; everything else, the builder's Server Actions and its
 * autosave among them, reaches the server, because what this proves is that
 * nothing of the builder waits on the check.
 */

test.use({ actionTimeout: 10_000 });

const CHECK_PATH = "/api/commcare/changes/check";

/** The project space the seed's apps came from, as the review names it. */
function targetOf(app: BroughtInApp) {
	return { server: app.key.server, domain: app.key.domain };
}

/** The compatibility check reads CommCare HQ: answered here, as ready. */
async function answerCompatibility(
	routes: RemovableRoutes,
	domain: string,
): Promise<void> {
	await routes.route("**/api/commcare/project-space-compatibility", (route) =>
		route.fulfill({
			json: {
				project_space_compatibility: {
					status: "ready",
					target_domain: domain,
					required_capabilities: [],
					blockers: [],
					advisories: [],
					support_email: PROJECT_SPACE_COMPATIBILITY_SUPPORT_EMAIL,
					docs_url: PROJECT_SPACE_COMPATIBILITY_DOCS_URL,
					message: "This project space supports everything this app uses.",
				},
			},
		}),
	);
}

/** Each check's body, as posted, answered by `answer`. */
async function answerChecks(
	routes: RemovableRoutes,
	answer: (route: Route, index: number) => Promise<void>,
): Promise<unknown[]> {
	const bodies: unknown[] = [];
	await routes.route(`**${CHECK_PATH}`, async (route) => {
		const index = bodies.length;
		bodies.push(route.request().postDataJSON());
		await answer(route, index);
	});
	return bodies;
}

/** Renames the app on its home screen and waits until the autosave has landed. */
async function renameApp(page: Page, name: string): Promise<void> {
	const title = page.locator('[data-testid="editable-title"]').visible();
	await title.fill(name);
	await title.press("Enter");
	await expect(page.getByText(/^Saved just now$/)).toBeVisible();
	await expect(title).toHaveValue(name);
}

function seeWhatChanged(page: Page) {
	return page.getByRole("button", {
		name: SEE_WHAT_CHANGED_IN_HQ_ACTION,
		exact: true,
	});
}

test("while the check is unanswered, the builder's controls work, an edit saves, and the Publish dialog lists its records", {
	tag: "@seed:bring-in",
}, async ({ scenario, page }) => {
	const app = seedFor(scenario, "bring-in").bringIn.apps.a;
	const routes = removableRoutes(page);
	const release = Promise.withResolvers<void>();
	try {
		await answerCompatibility(routes, app.key.domain);
		const checks = await answerChecks(routes, async (route) => {
			await release.promise;
			await route.fulfill({ json: { changed: [] } });
		});
		await openBuilder(page, `/build/${app.appId}`);
		await expect.poll(() => checks.length).toBe(1);
		expect(checks).toEqual([{ appId: app.appId }]);

		const publish = page.getByRole("button", { name: "Publish", exact: true });
		await expect(
			page.getByRole("button", { name: "Preview", exact: true }),
		).toBeEnabled();
		await expect(publish).toBeEnabled();

		await renameApp(page, "Clinic visits, renamed while Nova checks");
		await expect(
			page.getByRole("button", { name: "Undo", exact: true }),
		).toBeEnabled();

		await publish.click();
		const dialog = page.getByRole("dialog", {
			name: "Publish app",
			exact: true,
		});
		await expect(dialog).toBeVisible();
		await dialog
			.getByRole("button", { name: "Published destinations (1)", exact: true })
			.click();
		/* The rows sit above Open Publishing, in the box that holds both. */
		const rows = dialog
			.getByRole("button", { name: "Open Publishing", exact: true })
			.locator("xpath=../..")
			.getByRole("listitem");
		await expect(rows).toHaveCount(1);
		await expect(rows).toContainText(app.key.domain);
		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);

		/* The check was unanswered throughout; its empty answer shows nothing. */
		expect(checks).toHaveLength(1);
		release.resolve();
		await renameApp(page, "Clinic visits, after the check");
		await expect(seeWhatChanged(page)).toHaveCount(0);
	} finally {
		release.resolve();
		await routes.removeAll();
	}
});

test("a check that is aborted, answers 500 or answers no JSON says nothing at all", {
	tag: "@seed:bring-in",
}, async ({ scenario, browser, baseURL }) => {
	const fixture = seedFor(scenario, "bring-in");
	const app = fixture.bringIn.apps.a;
	/* The 500 is provoked on purpose, so this page carries its own guard: every
	 * console error, uncaught exception and client error report fails it, and
	 * the server answer this test chose does not. */
	const context = await createSmokeContext(browser, {
		baseURL,
		storageState: fixture.storageState,
	});
	try {
		const page = await context.newPage();
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
		page.on("console", (message) => {
			if (
				message.type() === "error" &&
				!message.text().startsWith("Failed to load resource")
			)
				errors.push(`console.error: ${message.text()}`);
		});
		page.on("request", (request) => {
			if (new URL(request.url()).pathname === "/api/log/error")
				errors.push(`client report: ${request.postData() ?? ""}`);
		});
		const routes = removableRoutes(page);
		try {
			await answerCompatibility(routes, app.key.domain);
			const checks = await answerChecks(routes, async (route, index) => {
				if (index === 0) {
					await route.abort("failed");
					return;
				}
				if (index === 1) {
					await route.fulfill({
						status: 500,
						json: { error: "Nova couldn't check CommCare HQ." },
					});
					return;
				}
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: "{ changed: [",
				});
			});

			await openBuilder(page, `/build/${app.appId}`);
			for (const [index, name] of [
				"After an aborted check",
				"After a check that failed",
				"After a check that answered no JSON",
			].entries()) {
				if (index > 0) await reloadBuilder(page);
				await expect.poll(() => checks.length).toBe(index + 1);
				/* An edit that saves is work the builder commits after the
				 * check's answer arrived: anything the answer drew is drawn by
				 * then. */
				await renameApp(page, name);
				await expect(seeWhatChanged(page)).toHaveCount(0);
				await expect(
					page.getByRole("button", { name: "Dismiss", exact: true }),
				).toHaveCount(0);
			}
		} finally {
			await routes.removeAll();
			await closePageWithUnload(page);
		}
		expect(errors).toEqual([]);
	} finally {
		await context.close();
	}
});

test("a check that names one project space shows See what changed in CommCare HQ, which opens that project space's changes", {
	tag: "@seed:bring-in",
}, async ({ scenario, page }) => {
	const app = seedFor(scenario, "bring-in").bringIn.apps.a;
	const target = targetOf(app);
	const review: HqChangesReview = {
		kind: "changes",
		since: { kind: "published" },
		hqChanges: ["The question Weight in the form Visit"],
		novaChanges: [],
		madeBy: [],
		caseData: [],
		publishChanges: [],
		observedDigest: "digest-app",
		renamedInNova: [],
		tables: [],
		projectName: "Bring-in team",
		readingId: "01928c3e-5b7a-7cde-8f01-23456789abcd",
		reviewDigest: "review-digest",
	};
	const routes = removableRoutes(page);
	try {
		await answerChecks(routes, (route) =>
			route.fulfill({ json: { changed: [target] } }),
		);
		const reviews: unknown[] = [];
		await routes.route("**/api/commcare/changes/review", async (route) => {
			reviews.push(route.request().postDataJSON());
			await route.fulfill({
				status: 200,
				contentType: "application/x-ndjson",
				body: [
					{ type: "stage", stage: "reading-app" },
					{ type: "done", answer: review },
				]
					.map((line) => `${JSON.stringify(line)}\n`)
					.join(""),
			});
		});
		await openBuilder(page, `/build/${app.appId}`);
		await seeWhatChanged(page).click();

		const dialog = page.getByRole("dialog", {
			name: HQ_CHANGES_DIALOG_TITLE,
			exact: true,
		});
		await expect(
			dialog.getByRole("heading", { name: HQ_CHANGES_HEADING, exact: true }),
		).toBeVisible();
		await expect(
			dialog.getByText(
				hqChangesLead(sincePhrase(review.since, target.domain), false),
				{ exact: true },
			),
		).toBeVisible();
		await expect(
			dialog.getByText("The question Weight in the form Visit", {
				exact: true,
			}),
		).toBeVisible();
		await expect(
			dialog.getByRole("button", {
				name: BRING_IN_CHANGES_ACTION,
				exact: true,
			}),
		).toBeVisible();
		/* On the card, publishing over is the Publish dialog's to offer. */
		await expect(
			dialog.getByRole("button", { name: PUBLISH_OVER_HQ_ACTION, exact: true }),
		).toHaveCount(0);
		expect(reviews).toEqual([{ appId: app.appId, ...target }]);
	} finally {
		await routes.removeAll();
	}
});

test("leaving the builder aborts a check still unanswered", {
	tag: "@seed:bring-in",
}, async ({ scenario, page }) => {
	const app = seedFor(scenario, "bring-in").bringIn.apps.a;
	const routes = removableRoutes(page);
	const release = Promise.withResolvers<void>();
	let aborted = false;
	page.on("requestfailed", (request) => {
		if (new URL(request.url()).pathname === CHECK_PATH) aborted = true;
	});
	try {
		const checks = await answerChecks(routes, async (route) => {
			await release.promise;
			/* The page already ended the request; there is nothing to answer. */
			if (!aborted) await route.fulfill({ json: { changed: [] } });
		});
		await openBuilder(page, `/build/${app.appId}`);
		await expect.poll(() => checks.length).toBe(1);
		await page.locator('a[href="/"]').first().click();
		await expect(page).toHaveURL(/\/$/);
		await expect.poll(() => aborted).toBe(true);
	} finally {
		release.resolve();
		await routes.removeAll();
	}
});
