import { randomUUID } from "node:crypto";
import { expect, seedFor, test } from "../../lib/appFixtures";
import { DEEP_LINKS_SEED } from "../../lib/deepLinksSeed";
import { attachErrorGuard, closePageWithUnload } from "../../lib/errorGuard";
import {
	expectBuilderDataLoaded,
	openBuilder,
	reloadBuilder,
} from "../../lib/pageLoads";
import { removableRoutes } from "../../lib/routes";
import { createSmokeContext } from "../../lib/smokeNetwork";

test(
	"deep links are authored, renamed, launched on the selected real case, and removed",
	{ tag: "@seed:deep-links" },
	async ({ scenario, page, browser, baseURL }, testInfo) => {
		const seed = seedFor(scenario, "deep-links");

		test.setTimeout(120_000);
		const fixture = seed.deepLinks;
		if (!fixture)
			throw new Error(
				`Deep-link fixture missing for attempt ${testInfo.retry}`,
			);
		const target = DEEP_LINKS_SEED.target;
		const savedMutation = async (kind: string, mutate: () => Promise<void>) => {
			const saved = page.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === `/api/apps/${fixture.appId}` &&
					response.request().method() === "PUT" &&
					(response.request().postData() ?? "").includes(`"kind":"${kind}"`),
			);
			const [response] = await Promise.all([saved, mutate()]);
			expect(response.ok()).toBe(true);
		};
		let detailRoute = "";
		await test.step("create the exact form destination through App setup", async () => {
			await openBuilder(page, fixture.route);
			await expect(
				page.getByRole("heading", { name: "Deep links", exact: true }),
			).toBeVisible({ timeout: 20_000 });
			await page
				.getByRole("button", { name: "Add deep link", exact: true })
				.click();
			await savedMutation("addEntryPoint", () =>
				page
					.getByRole("button", {
						name: `${DEEP_LINKS_SEED.moduleName} · ${target.formName}`,
						exact: true,
					})
					.click(),
			);
			await expect(page.getByLabel("Link ID", { exact: true })).toBeVisible();
			detailRoute = new URL(page.url()).pathname;
			expect(detailRoute).toMatch(
				new RegExp(`^${fixture.route}/[0-9a-f-]{36}$`),
			);
			await expect(
				page.getByRole("button", { name: "Test in Preview", exact: true }),
			).toBeDisabled();
		});
		await test.step("external ID edits retain the authoring UUID through reload", async () => {
			const id = page.getByLabel("Link ID", { exact: true });
			await savedMutation("updateEntryPoint", async () => {
				await id.fill(DEEP_LINKS_SEED.renamedId);
				await id.press("Enter");
			});
			expect(new URL(page.url()).pathname).toBe(detailRoute);
			await reloadBuilder(page);
			await expect(page.getByLabel("Link ID", { exact: true })).toHaveValue(
				DEEP_LINKS_SEED.renamedId,
				{ timeout: 20_000 },
			);
			expect(new URL(page.url()).pathname).toBe(detailRoute);
			await page.getByLabel("Link ID", { exact: true }).click({ trial: true });
			await testInfo.attach("deep-link-detail", {
				body: await page.screenshot({ fullPage: true, animations: "disabled" }),
				contentType: "image/png",
			});
		});
		await test.step("keyboard navigation and narrow layout retain the exact destination", async () => {
			await expect(
				page.getByRole("heading", { name: "Deep links", exact: true }),
			).toBeFocused();
			await page.keyboard.press("Tab");
			await expect(
				page.getByRole("button", { name: "All deep links", exact: true }),
			).toBeFocused();
			await page.keyboard.press("Tab");
			await expect(page.getByLabel("Link ID", { exact: true })).toBeFocused();
			await page.setViewportSize({ width: 390, height: 844 });
			await expect(page.getByLabel("Link ID", { exact: true })).toBeVisible();
			expect(
				await page.evaluate(() => document.documentElement.scrollWidth),
			).toBeLessThanOrEqual(390);
			await page.getByLabel("Link ID", { exact: true }).click({ trial: true });
			await testInfo.attach("deep-link-narrow", {
				body: await page.screenshot({ fullPage: true, animations: "disabled" }),
				contentType: "image/png",
			});
			await page.setViewportSize({ width: 1280, height: 900 });
		});
		await test.step("a viewer can inspect the link without authoring controls", async () => {
			const viewerContext = await createSmokeContext(browser, {
				baseURL,
				storageState: seed.viewerStorageState,
			});
			try {
				const viewerPage = await viewerContext.newPage();
				const guard = await attachErrorGuard(viewerPage, baseURL);
				try {
					await openBuilder(viewerPage, detailRoute);
					await expect(
						viewerPage.getByLabel("Link ID", { exact: true }),
					).toHaveValue(DEEP_LINKS_SEED.renamedId, { timeout: 20_000 });
					await expect(
						viewerPage.getByLabel("Link ID", { exact: true }),
					).toBeDisabled();
					await expect(
						viewerPage.getByRole("button", {
							name: "Remove deep link",
							exact: true,
						}),
					).toHaveCount(0);
					await viewerPage
						.getByRole("button", { name: "All deep links", exact: true })
						.click();
					await expect(
						viewerPage.getByRole("button", {
							name: "Add deep link",
							exact: true,
						}),
					).toHaveCount(0);
				} finally {
					await closePageWithUnload(viewerPage);
					await guard.assertNoErrors();
				}
			} finally {
				await viewerContext.close();
			}
		});
		await test.step("launch selects the requested case rather than the first available row", async () => {
			await page
				.getByRole("combobox", {
					name: `${DEEP_LINKS_SEED.moduleName} cases`,
					exact: true,
				})
				.click();
			await expect(
				page.getByRole("option", {
					name: DEEP_LINKS_SEED.distractorName,
					exact: true,
				}),
			).toBeVisible();
			await page
				.getByRole("option", {
					name: DEEP_LINKS_SEED.selectedName,
					exact: true,
				})
				.click();
			const launch = page.getByRole("button", {
				name: "Test in Preview",
				exact: true,
			});
			await expect(launch).toBeEnabled();
			await launch.click();
			await expect(
				page
					.locator("main")
					.getByRole("textbox", { name: target.noteFieldLabel }),
			).toBeVisible({ timeout: 20_000 });
			const trail = page.getByRole("navigation", { name: "Page navigation" });
			await expect(trail).toContainText(DEEP_LINKS_SEED.selectedName);
			await expect(trail).toContainText(target.formName);
			await expect(trail).not.toContainText(DEEP_LINKS_SEED.distractorName);
			expect(new URL(page.url()).pathname).toBe(
				`/build/${fixture.appId}/${target.formUuid}`,
			);
			await testInfo.attach("deep-link-selected-case-preview", {
				body: await page.screenshot({ fullPage: true, animations: "disabled" }),
				contentType: "image/png",
			});
		});
		await test.step("removal recovers the selected UUID route to the overview", async () => {
			await page
				.getByRole("button", { name: "Back to edit", exact: true })
				.click();
			// Hold the real initial Server Action reads to make catalog readiness
			// deterministic. A fast click must wait for admission, never be lost.
			let releaseReads: () => void = () => {};
			const readsHeld = new Promise<void>((resolve) => {
				releaseReads = resolve;
			});
			let heldActions = 0;
			const actionRoute = `**/build/${fixture.appId}/**`;
			const actionRoutes = removableRoutes(page);
			await actionRoutes.route(actionRoute, async (route) => {
				if (
					route.request().method() === "POST" &&
					route.request().headers()["next-action"]
				) {
					heldActions++;
					await readsHeld;
				}
				await route.continue();
			});
			try {
				// biome-ignore lint/plugin/builderPageLoads: this step holds the Project data read to see the builder while it loads.
				await page.goto(detailRoute);
				await expect(page.getByLabel("Link ID", { exact: true })).toHaveValue(
					DEEP_LINKS_SEED.renamedId,
				);
				await expect.poll(() => heldActions).toBeGreaterThan(0);
				await expect(
					page.getByLabel("Link ID", { exact: true }),
				).toBeDisabled();
				await expect(
					page.getByRole("button", { name: "Remove deep link", exact: true }),
				).toBeDisabled();
			} finally {
				releaseReads();
				await actionRoutes.removeAll();
			}
			await expectBuilderDataLoaded(page);
			await savedMutation("removeEntryPoint", () =>
				page
					.getByRole("button", { name: "Remove deep link", exact: true })
					.click(),
			);
			await expect(page).toHaveURL(new RegExp(`${fixture.route}$`));
			await expect(
				page.getByText("No deep links yet.", { exact: false }),
			).toBeVisible();
			await openBuilder(page, detailRoute);
			await expect(page).toHaveURL(new RegExp(`${fixture.route}$`));
			await expect(
				page.getByRole("heading", { name: "Deep links", exact: true }),
			).toBeVisible();
		});
	},
);

test("a deep link creates its case at the supplied ID and refuses reuse", {
	tag: "@seed:deep-links",
}, async ({ scenario, page }) => {
	const { deepLinks: fixture } = seedFor(scenario, "deep-links");
	if (!fixture) throw new Error("Deep-link fixture missing");
	const { registration, caseType } = DEEP_LINKS_SEED;
	await openBuilder(page, fixture.route);
	await page
		.getByRole("button", { name: "Add deep link", exact: true })
		.click();
	await page
		.getByRole("button", {
			name: `${registration.moduleName} · ${registration.formName}`,
			exact: true,
		})
		.click();
	await expect(page.getByLabel("Link ID", { exact: true })).toBeVisible();
	const detailRoute = new URL(page.url()).pathname;

	const supply = page.getByRole("checkbox", {
		name: `Supply the new ${caseType} ID`,
		exact: true,
	});
	const input = page.getByRole("textbox", {
		name: `New ${caseType} case ID`,
		exact: true,
	});
	const launch = page.getByRole("button", {
		name: "Test in Preview",
		exact: true,
	});
	await expect(supply).not.toBeChecked();
	await expect(input).toHaveCount(0);
	await expect(launch).toBeEnabled();
	const saved = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname === `/api/apps/${fixture.appId}` &&
			response.request().method() === "PUT" &&
			(response.request().postData() ?? "").includes('"entryCaseCreations"'),
	);
	const [response] = await Promise.all([saved, supply.click()]);
	expect(response.ok()).toBe(true);

	await reloadBuilder(page);
	await expect(supply).toBeChecked();
	await expect(input).toBeVisible();
	await expect(launch).toBeDisabled();

	const collision = page
		.getByRole("alert")
		.filter({ hasText: "A new case ID is already in use." });
	await input.fill(fixture.selectedCaseId);
	await launch.click();
	await expect(collision).toBeVisible();
	await expect(page).toHaveURL(new RegExp(`${detailRoute}$`));

	const newId = randomUUID();
	await input.fill(newId);
	await launch.click();
	const registrationPath = `/build/${fixture.appId}/${registration.formUuid}`;
	await expect
		.poll(async () => ({
			path: new URL(page.url()).pathname,
			alerts: (await page.getByRole("alert").allTextContents())
				.map((text) => text.trim())
				.filter(Boolean),
		}))
		.toEqual({ path: registrationPath, alerts: [] });
	const form = page.locator("main");
	const name = form.getByRole("textbox", { name: registration.fieldLabel });
	await expect(name).toBeVisible();
	await name.fill("Patient from the deep link");
	const submit = form.getByRole("button", { name: "Submit", exact: true });
	await expect(submit).toBeEnabled();
	await submit.click();
	await expect(name).toHaveCount(0);
	await expect(page).toHaveURL(new RegExp(`/build/${fixture.appId}$`));

	await openBuilder(page, detailRoute);
	await input.fill(newId);
	await launch.click();
	await expect(collision).toBeVisible();
	await expect(page).toHaveURL(new RegExp(`${detailRoute}$`));
});
