import type { APIRequestContext, Page, Route } from "@playwright/test";
import type {
	CreateAnswer,
	HqAppPicker,
	ReadingAnswer,
	ReadingEvent,
	ReadingKey,
} from "@/lib/deployment";
import {
	BRING_IN_ACTIONS,
	BRING_IN_EMPTY_STATE_LINK,
	BRING_IN_HOME_ENTRY,
	BRING_IN_NOT_CONNECTED_TITLE,
	BRING_IN_START_BUTTON,
	BROUGHT_IN_TOAST_TITLE,
	CREATING_STATUS,
	PICKER_HEADING,
	PICKER_PROJECT_LABEL,
	reviewHeading,
} from "@/lib/publish/bringInCopy";
import {
	ENDED_HQ_APP_LINK,
	STOP_PUBLISHING_ACTION,
	STOP_PUBLISHING_CONFIRM,
	stopPublishingConfirmTitle,
} from "@/lib/publish/stopPublishing";
import { bringInHref } from "@/lib/routing/bringInLocation";
import { buildUrl } from "@/lib/routing/location";
import { expect, seedFor, test } from "../../lib/appFixtures";
import type { BroughtInApp } from "../../lib/bringInSeed";
import { attachErrorGuard, closePageWithUnload } from "../../lib/errorGuard";
import {
	expectBuilderDataLoaded,
	openBuilder,
	openPage,
	reloadBuilder,
} from "../../lib/pageLoads";
import { type RemovableRoutes, removableRoutes } from "../../lib/routes";
import { createSmokeContext } from "../../lib/smokeNetwork";

/**
 * Bringing an app in from CommCare HQ on the real builder, signed in, against
 * the production server. The three routes that would read CommCare HQ (the
 * picker's list, a read and a create) are answered here from `page.route`
 * with what the seed's own births answered; every other request reaches the
 * server, and Check connection reads Nova's own row.
 */

test.use({ actionTimeout: 10_000 });

const CHOOSE_ADDRESS = bringInHref({ kind: "choose" });
const NEW_APP = "/build/new";

function ndjson(events: readonly ReadingEvent[]): string {
	return events.map((event) => `${JSON.stringify(event)}\n`).join("");
}

async function answer(
	route: Route,
	last: ReadingAnswer | CreateAnswer,
): Promise<void> {
	await route.fulfill({
		status: 200,
		contentType: "application/x-ndjson",
		body: ndjson([
			{ type: "stage", stage: "connecting" },
			{ type: "stage", stage: "reading-app" },
			{ type: "done", answer: last },
		]),
	});
}

/** The address of one seeded app's read, as the picker writes it. */
function addressOf(app: BroughtInApp): string {
	return bringInHref({ kind: "app", key: app.key });
}

/** The picker's list for the owner's one project space: the seeded apps, both already in Nova. */
async function answerApps(
	routes: RemovableRoutes,
	apps: readonly BroughtInApp[],
): Promise<void> {
	await routes.route("**/api/commcare/hq-apps?*", async (route) => {
		const [first] = apps;
		const picker: HqAppPicker = {
			kind: "apps",
			server: "india",
			domain: first?.key.domain ?? "clinic",
			apps: apps.map((app) => ({
				remoteAppId: app.key.remoteAppId,
				name: app.appName,
				claim: { kind: "open", appId: app.appId, appName: app.appName },
			})),
		};
		await route.fulfill({ json: { picker } });
	});
}

/** Each read's key, as posted; every read answers `review`. */
async function answerReads(
	routes: RemovableRoutes,
	review: Extract<ReadingAnswer, { kind: "review" }>,
): Promise<ReadingKey[]> {
	const keys: ReadingKey[] = [];
	await routes.route("**/api/commcare/bring-in/read", async (route) => {
		keys.push(route.request().postDataJSON() as ReadingKey);
		await answer(route, review);
	});
	return keys;
}

async function setActiveProject(
	request: APIRequestContext,
	baseURL: string | undefined,
	organizationId: string,
): Promise<void> {
	const active = await request.post("/api/auth/organization/set-active", {
		headers: { Origin: baseURL ?? "http://localhost:3000" },
		data: { organizationId },
	});
	expect(active.status()).toBe(200);
	await active.json();
}

function path(page: Page): string {
	const url = new URL(page.url());
	return `${url.pathname}${url.search}`;
}

/** Stamps the document, so a later check can tell whether a page load replaced it. */
async function markDocument(page: Page): Promise<void> {
	await page.evaluate(() => {
		Reflect.set(window, "__bringInDocument", true);
	});
}

async function documentIsMarked(page: Page): Promise<boolean> {
	return await page.evaluate(
		() => Reflect.get(window, "__bringInDocument") === true,
	);
}

test("each of the three entries reaches the picker, and Back from the new-app page's returns to the composer with no page load", {
	tag: "@seed:bring-in",
}, async ({ scenario, page, baseURL }) => {
	const { bringIn } = seedFor(scenario, "bring-in");
	const routes = removableRoutes(page);
	try {
		await answerApps(routes, [bringIn.apps.a]);
		const picker = page.getByRole("heading", {
			level: 1,
			name: PICKER_HEADING,
			exact: true,
		});

		await test.step("the home's button", async () => {
			await openPage(page, "/");
			/* The shared Button draws the entry, so it is a button that opens a page. */
			await page
				.getByRole("button", { name: BRING_IN_HOME_ENTRY, exact: true })
				.click();
			await expect(page).toHaveURL(
				new RegExp(`${CHOOSE_ADDRESS.replace("?", "\\?")}$`),
			);
			await expect(picker).toBeVisible({ timeout: 20_000 });
		});

		await test.step("the button under the chat box, and Back", async () => {
			await openBuilder(page, NEW_APP);
			const composer = page.getByPlaceholder("Describe your app");
			await expect(composer).toBeVisible({ timeout: 20_000 });
			await markDocument(page);
			await page
				.getByRole("button", { name: BRING_IN_START_BUTTON, exact: true })
				.click();
			await expect(picker).toBeVisible();
			expect(path(page)).toBe(CHOOSE_ADDRESS);
			await page.goBack();
			await expect(composer).toBeVisible();
			await expect(picker).toHaveCount(0);
			expect(path(page)).toBe(NEW_APP);
			expect(await documentIsMarked(page)).toBe(true);
		});

		await test.step("the empty home's link", async () => {
			await setActiveProject(
				page.context().request,
				baseURL,
				bringIn.projects.c.id,
			);
			await openPage(page, "/");
			await page
				.getByRole("link", { name: BRING_IN_EMPTY_STATE_LINK, exact: true })
				.click();
			await expect(picker).toBeVisible({ timeout: 20_000 });
			expect(path(page)).toBe(CHOOSE_ADDRESS);
		});
	} finally {
		await routes.removeAll();
	}
});

test("the address survives a connection check", {
	tag: "@seed:bring-in",
}, async ({ scenario, browser, baseURL }) => {
	const fixture = seedFor(scenario, "bring-in");
	/* A's editor has no CommCare HQ connection, so the picker offers the check. */
	const editorContext = await createSmokeContext(browser, {
		baseURL,
		storageState: fixture.viewerStorageState,
	});
	try {
		const page = await editorContext.newPage();
		const guard = await attachErrorGuard(page, baseURL);
		try {
			await openBuilder(page, NEW_APP);
			await page
				.getByRole("button", { name: BRING_IN_START_BUTTON, exact: true })
				.click();
			expect(path(page)).toBe(CHOOSE_ADDRESS);
			const aside = page.getByRole("heading", {
				name: BRING_IN_NOT_CONNECTED_TITLE,
				exact: true,
			});
			await expect(aside).toBeVisible();
			const check = page.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === "/api/commcare/connection",
			);
			await page
				.getByRole("button", { name: "Check connection", exact: true })
				.click();
			expect((await check).status()).toBe(200);
			await expect(
				page.getByRole("button", { name: "Check connection", exact: true }),
			).toBeEnabled();
			expect(path(page)).toBe(CHOOSE_ADDRESS);
			await expect(
				page.getByRole("heading", { level: 1, name: PICKER_HEADING }),
			).toBeVisible();
			await expect(aside).toBeVisible();
		} finally {
			await closePageWithUnload(page);
			await guard.assertNoErrors();
		}
	} finally {
		await editorContext.close();
	}
});

test("a viewer who edits another Project is offered that Project, and the home offers no entry", {
	tag: "@seed:bring-in",
}, async ({ scenario, browser, baseURL }) => {
	const { bringIn } = seedFor(scenario, "bring-in");
	const thirdContext = await createSmokeContext(browser, {
		baseURL,
		storageState: bringIn.third.storageState,
	});
	try {
		const page = await thirdContext.newPage();
		const guard = await attachErrorGuard(page, baseURL);
		try {
			await openBuilder(page, CHOOSE_ADDRESS);
			await expect(
				page.getByRole("heading", { level: 1, name: PICKER_HEADING }),
			).toBeVisible({ timeout: 20_000 });
			await expect(
				page.getByText(PICKER_PROJECT_LABEL, { exact: true }),
			).toBeVisible();
			/* B is the one Project they may add an app to, so it is stated,
			 * not offered as a choice. */
			await expect(
				page.getByText(bringIn.projects.b.name, { exact: true }),
			).toBeVisible();
			await expect(
				page.getByRole("combobox", { name: PICKER_PROJECT_LABEL }),
			).toHaveCount(0);

			await openPage(page, "/");
			await expect(
				page.getByRole("heading", {
					level: 3,
					name: bringIn.apps.a.appName,
				}),
			).toBeVisible({ timeout: 20_000 });
			await expect(
				page.getByRole("button", { name: BRING_IN_HOME_ENTRY }),
			).toHaveCount(0);
		} finally {
			await closePageWithUnload(page);
			await guard.assertNoErrors();
		}
	} finally {
		await thirdContext.close();
	}
});

test("an app's address reads the app each time it is opened, and an address that names no app reads nothing", {
	tag: "@seed:bring-in",
}, async ({ scenario, page }) => {
	const { bringIn } = seedFor(scenario, "bring-in");
	const app = bringIn.apps.a;
	const routes = removableRoutes(page);
	try {
		const reads = await answerReads(routes, app.review);
		const review = page.getByRole("heading", {
			level: 1,
			name: reviewHeading(app.review.review.appName),
		});
		await openBuilder(page, addressOf(app));
		await expect(review).toBeVisible({ timeout: 20_000 });
		expect(reads).toEqual([app.key]);
		await reloadBuilder(page);
		await expect(review).toBeVisible({ timeout: 20_000 });
		expect(reads).toEqual([app.key, app.key]);

		const missing = new URL(addressOf(app), "http://nova.invalid");
		missing.searchParams.delete("app");
		for (const address of [
			`${NEW_APP}?hq=nonsense`,
			`${missing.pathname}${missing.search}`,
		]) {
			await openBuilder(page, address);
			await expect(page.getByPlaceholder("Describe your app")).toBeVisible({
				timeout: 20_000,
			});
			await expect(
				page.getByRole("heading", { level: 1, name: PICKER_HEADING }),
			).toHaveCount(0);
		}
		expect(reads).toHaveLength(2);
	} finally {
		await routes.removeAll();
	}
});

test("an app brought in to the tab's Project lands in the builder with no page load, and See what came in opens Publishing", {
	tag: "@seed:bring-in",
}, async ({ scenario, page }) => {
	const { bringIn } = seedFor(scenario, "bring-in");
	const app = bringIn.apps.a;
	const routes = removableRoutes(page);
	try {
		await page.addInitScript(() => {
			const written: string[] = [];
			Reflect.set(window, "__bringInWritten", written);
			const setItem = Storage.prototype.setItem;
			Storage.prototype.setItem = function (key: string, value: string) {
				written.push(key);
				return Reflect.apply(setItem, this, [key, value]);
			};
		});
		await answerReads(routes, app.review);
		await routes.route("**/api/commcare/bring-in/create", (route) =>
			answer(route, { kind: "created", receipt: app.receipt }),
		);
		await openBuilder(page, addressOf(app));
		await expect(
			page.getByRole("heading", {
				level: 1,
				name: reviewHeading(app.review.review.appName),
			}),
		).toBeVisible({ timeout: 20_000 });
		await markDocument(page);
		await page
			.getByRole("button", { name: BRING_IN_ACTIONS.bringItIn, exact: true })
			.click();
		await expect(page).toHaveURL(new RegExp(`/build/${app.appId}$`), {
			timeout: 30_000,
		});
		expect(await documentIsMarked(page)).toBe(true);
		await expect(
			page.getByText(app.menuName, { exact: true }).first(),
		).toBeVisible({ timeout: 20_000 });
		const toast = page.getByText(BROUGHT_IN_TOAST_TITLE, { exact: true });
		await expect(toast).toBeVisible();
		await expect(toast).toHaveCount(1);
		await page
			.getByRole("button", {
				name: BRING_IN_ACTIONS.seeWhatCameIn,
				exact: true,
			})
			.click();
		await expect(page).toHaveURL(
			new RegExp(`/build/${app.appId}/setup/publishing$`),
		);
		await expect(
			page.getByText(
				new RegExp(
					`^Brought in from “${app.key.domain}” on .+ by ${bringIn.ownerName}$`,
				),
			),
		).toBeVisible({ timeout: 20_000 });
		const written = await page.evaluate(
			() => Reflect.get(window, "__bringInWritten") as string[],
		);
		expect(written).not.toContain("nova:brought-in");
	} finally {
		await routes.removeAll();
	}
});

test("an app brought in to another Project loads its own page once, with the landing's toast and no other", {
	tag: "@seed:bring-in",
}, async ({ scenario, page }) => {
	const { bringIn } = seedFor(scenario, "bring-in");
	const app = bringIn.apps.b;
	const routes = removableRoutes(page);
	try {
		await answerReads(routes, app.review);
		await routes.route("**/api/commcare/bring-in/create", (route) =>
			answer(route, { kind: "created", receipt: app.receipt }),
		);
		await openBuilder(page, addressOf(app));
		await expect(
			page.getByRole("heading", {
				level: 1,
				name: reviewHeading(app.review.review.appName),
			}),
		).toBeVisible({ timeout: 20_000 });
		await markDocument(page);
		await page
			.getByRole("button", { name: BRING_IN_ACTIONS.bringItIn, exact: true })
			.click();
		await expect(page).toHaveURL(new RegExp(`/build/${app.appId}$`), {
			timeout: 30_000,
		});
		await expectBuilderDataLoaded(page);
		expect(await documentIsMarked(page)).toBe(false);
		await expect(
			page.getByText(app.menuName, { exact: true }).first(),
		).toBeVisible({ timeout: 20_000 });
		const toast = page.getByText(BROUGHT_IN_TOAST_TITLE, { exact: true });
		await expect(toast).toBeVisible({ timeout: 20_000 });
		await expect(toast).toHaveCount(1);
		await expect(page.getByText(/Reload/)).toHaveCount(0);
		expect(
			await page.evaluate(() =>
				window.sessionStorage.getItem("nova:brought-in"),
			),
		).toBeNull();
	} finally {
		await routes.removeAll();
	}
});

test("a reload while a create is held open shows the creating screen, and the create's answer opens the app once", {
	tag: "@seed:bring-in",
}, async ({ scenario, page }) => {
	const { bringIn } = seedFor(scenario, "bring-in");
	const app = bringIn.apps.a;
	const routes = removableRoutes(page);
	/* The first create is held until the page that sent it has gone, as a
	 * create still running when the person reloads is. */
	const released = Promise.withResolvers<void>();
	try {
		await answerReads(routes, app.review);
		let creates = 0;
		await routes.route("**/api/commcare/bring-in/create", async (route) => {
			creates++;
			if (creates === 1) {
				await released.promise;
				await route.abort("aborted");
				return;
			}
			await answer(route, { kind: "created", receipt: app.receipt });
		});
		await openBuilder(page, addressOf(app));
		await expect(
			page.getByRole("heading", {
				level: 1,
				name: reviewHeading(app.review.review.appName),
			}),
		).toBeVisible({ timeout: 20_000 });
		await page
			.getByRole("button", { name: BRING_IN_ACTIONS.bringItIn, exact: true })
			.click();
		await expect(
			page.getByRole("heading", { level: 1, name: CREATING_STATUS }),
		).toBeVisible();
		await expect.poll(() => creates).toBe(1);

		await reloadBuilder(page);
		released.resolve();
		await expect(page).toHaveURL(new RegExp(`/build/${app.appId}$`), {
			timeout: 30_000,
		});
		expect(creates).toBe(2);
		await expect(
			page.getByText(app.menuName, { exact: true }).first(),
		).toBeVisible({ timeout: 20_000 });

		await openPage(page, "/");
		await expect(
			page.getByRole("heading", { level: 3, name: app.appName }),
		).toHaveCount(1, { timeout: 20_000 });
	} finally {
		released.resolve();
		await routes.removeAll();
	}
});

test("Back to a home that was empty shows the app just created there", {
	tag: "@seed:bring-in",
}, async ({ scenario, page, baseURL }) => {
	const { bringIn } = seedFor(scenario, "bring-in");
	/* A model call is a send: a POST to the chat route. */
	const chats: string[] = [];
	page.on("request", (request) => {
		if (
			request.method() === "POST" &&
			new URL(request.url()).pathname === "/api/chat"
		)
			chats.push(request.url());
	});
	await setActiveProject(
		page.context().request,
		baseURL,
		bringIn.projects.c.id,
	);
	await openPage(page, "/");
	const empty = page.getByRole("heading", {
		name: "Build your first app",
		exact: true,
	});
	await expect(empty).toBeVisible({ timeout: 20_000 });
	await page.getByRole("button", { name: "Get started", exact: true }).click();
	await expect(page).toHaveURL(new RegExp(`${NEW_APP}$`));
	await expectBuilderDataLoaded(page);
	await page
		.getByRole("button", { name: "Start with a blank app", exact: true })
		.click();
	await page.waitForURL(/\/build\/(?!new)[\w-]+$/, { timeout: 30_000 });
	await page.goBack();
	await expect(page).toHaveURL(/\/$/);
	await expect(
		page.getByRole("heading", { level: 1, name: "Your apps" }),
	).toBeVisible({ timeout: 20_000 });
	await expect(empty).toHaveCount(0);
	expect(chats).toEqual([]);
});

test("the owner stops publishing a brought-in app from its card, and its editor is offered no stop", {
	tag: "@seed:bring-in",
}, async ({ scenario, page, browser, baseURL }) => {
	const fixture = seedFor(scenario, "bring-in");
	const { bringIn } = fixture;
	const app = bringIn.apps.a;
	const publishing = buildUrl(`/build/${app.appId}`, {
		kind: "app-setup",
		section: "publishing",
	});
	const broughtIn = new RegExp(
		`^Brought in from “${app.key.domain}” on .+ by ${bringIn.ownerName}$`,
	);

	await test.step("the editor sees the card and no stop", async () => {
		const editorContext = await createSmokeContext(browser, {
			baseURL,
			storageState: fixture.viewerStorageState,
		});
		try {
			const editorPage = await editorContext.newPage();
			const guard = await attachErrorGuard(editorPage, baseURL);
			try {
				await openBuilder(editorPage, publishing);
				await expect(editorPage.getByText(broughtIn)).toBeVisible({
					timeout: 20_000,
				});
				await expect(
					editorPage.getByRole("button", { name: STOP_PUBLISHING_ACTION }),
				).toHaveCount(0);
			} finally {
				await closePageWithUnload(editorPage);
				await guard.assertNoErrors();
			}
		} finally {
			await editorContext.close();
		}
	});

	await test.step("the owner stops, and the card ends", async () => {
		await openBuilder(page, publishing);
		await expect(page.getByText(broughtIn)).toBeVisible({ timeout: 20_000 });
		await page
			.getByRole("button", { name: STOP_PUBLISHING_ACTION, exact: true })
			.click();
		const dialog = page.getByRole("alertdialog", {
			name: stopPublishingConfirmTitle(app.key.domain),
		});
		await expect(dialog).toBeVisible();
		await dialog
			.getByRole("button", { name: STOP_PUBLISHING_CONFIRM, exact: true })
			.click();
		await expect(dialog).toHaveCount(0);
		await expect(
			page.getByText(
				new RegExp(`^${bringIn.ownerName} stopped publishing here on `),
			),
		).toBeVisible({ timeout: 20_000 });
		await expect(
			page.getByRole("link", { name: new RegExp(ENDED_HQ_APP_LINK) }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: STOP_PUBLISHING_ACTION }),
		).toHaveCount(0);
	});
});
