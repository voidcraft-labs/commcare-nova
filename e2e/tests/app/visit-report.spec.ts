import type { Page } from "@playwright/test";
import { expect, seedFor, test } from "../../lib/appFixtures";
import { attachErrorGuard, closePageWithUnload } from "../../lib/errorGuard";
import { openBuilder } from "../../lib/pageLoads";
import { replaceRichText } from "../../lib/richText";
import { createSmokeContext } from "../../lib/smokeNetwork";
import { visitReport, visitReportRoute } from "../../lib/visitReportSeed";

function saved(page: Page, appId: string, key: string) {
	return page.waitForResponse((response) => {
		const request = response.request();
		return (
			request.method() === "PUT" &&
			new URL(response.url()).pathname === `/api/apps/${appId}` &&
			request.postData()?.includes(JSON.stringify(key)) === true
		);
	});
}

test("a visit report keeps its receiving details and presents each worker's instructions", {
	tag: "@seed:visit-report",
}, async ({ scenario, page, request, browser, baseURL }) => {
	test.setTimeout(150_000);
	const { appId, viewerStorageState } = seedFor(scenario, "visit-report");
	const main = page.getByRole("main");
	await openBuilder(page, visitReportRoute(appId));
	await page
		.getByRole("button", { name: "Form settings", exact: true })
		.click();
	const settings = page
		.getByRole("dialog")
		.filter({ hasText: "Form settings" });
	await settings
		.getByText("Submitted answer addresses", { exact: true })
		.click();
	const root = settings.getByRole("textbox", { name: "Submitted answer root" });
	await root.fill("visit_report");
	const rootSaved = saved(page, appId, "dataRootName");
	await root.press("Enter");
	expect((await rootSaved).ok()).toBe(true);
	await settings.getByRole("button", { name: "Close form settings" }).click();

	await openBuilder(page, visitReportRoute(appId, visitReport.source));
	await page.getByText("Receiving service", { exact: true }).click();
	const namespace = page.getByRole("textbox", { name: "Receiving namespace" });
	await namespace.fill("urn:outreach:source");
	const namespaceSaved = saved(page, appId, "answerNamespace");
	await namespace.press("Enter");
	expect((await namespaceSaved).ok()).toBe(true);
	const lockSaved = saved(page, appId, "lockedInHq");
	await page
		.getByRole("switch", { name: /^Lock this question in CommCare HQ/ })
		.click();
	const lockReceipt = await lockSaved;
	expect(lockReceipt.ok()).toBe(true);

	await openBuilder(page, visitReportRoute(appId, visitReport.message));
	const checkedSaved = saved(page, appId, "askForConfirmation");
	await page.getByRole("switch", { name: /^Ask for confirmation/ }).click();
	expect((await checkedSaved).ok()).toBe(true);
	const requiredSaved = saved(page, appId, "required");
	await page.getByRole("button", { name: "Required", exact: true }).click();
	expect((await requiredSaved).ok()).toBe(true);

	await openBuilder(page, visitReportRoute(appId, visitReport.repeat));
	for (const [title, slot, words] of [
		["First entry button", "addFirstLabel", "Record a place"],
		["Another entry button", "addLabel", "Record another place"],
	]) {
		await page.getByRole("button", { name: title, exact: true }).click();
		const input = page.getByRole("textbox", { name: title, exact: true });
		await replaceRichText(input, words);
		const wordsSaved = saved(page, appId, slot);
		await input.press("Enter");
		expect((await wordsSaved).ok()).toBe(true);
	}

	const snapshot = await request.get(`/api/apps/${appId}`);
	expect(snapshot.ok()).toBe(true);
	const { blueprint } = await snapshot.json();
	expect(blueprint.forms[visitReport.form].dataRootName).toBe("visit_report");
	expect(blueprint.fields[visitReport.source]).toMatchObject({
		answerNamespace: "urn:outreach:source",
		lockedInHq: true,
	});

	await test.step("a viewer can inspect the receiving details", async () => {
		const context = await createSmokeContext(browser, {
			baseURL,
			storageState: viewerStorageState,
		});
		try {
			const viewer = await context.newPage();
			const guard = await attachErrorGuard(viewer, baseURL);
			try {
				await openBuilder(viewer, visitReportRoute(appId, visitReport.source));
				await expect(
					viewer.getByText("urn:outreach:source", { exact: true }),
				).toBeVisible();
				await expect(
					viewer.getByRole("textbox", { name: "Receiving namespace" }),
				).toHaveCount(0);
				const lock = viewer.getByRole("switch", {
					name: /^Lock this question in CommCare HQ/,
				});
				await expect(lock).toBeChecked();
				await expect(lock).toBeDisabled();
				const attemptedEdit = await context.request.put(`/api/apps/${appId}`, {
					data: lockReceipt.request().postDataJSON(),
				});
				expect(attemptedEdit.status()).toBe(403);
				await openBuilder(viewer, visitReportRoute(appId, visitReport.message));
				const confirmation = viewer.getByRole("switch", {
					name: /^Ask for confirmation/,
				});
				await expect(confirmation).toBeChecked();
				await expect(confirmation).toBeDisabled();
				await expect(
					viewer.getByRole("button", { name: "Form settings", exact: true }),
				).toHaveCount(0);
				const snapshot = await context.request.get(`/api/apps/${appId}`);
				expect(snapshot.ok()).toBe(true);
				const { blueprint } = await snapshot.json();
				expect(blueprint.forms[visitReport.form].dataRootName).toBe(
					"visit_report",
				);
			} finally {
				await closePageWithUnload(viewer);
				await guard.assertNoErrors();
			}
		} finally {
			await context.close();
		}
	});

	await openBuilder(page, visitReportRoute(appId));
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	await expect(main.getByRole("checkbox")).toHaveCount(0);
	const first = main.getByRole("button", { name: /^Record a place/ });
	await expect(first).toBeVisible();
	await expect(main.getByRole("textbox", { name: /Village/ })).toHaveCount(0);
	await first.click();
	await main.getByRole("textbox", { name: /Village/ }).fill("Oak Hill");
	await expect(
		main.getByRole("button", { name: /^Record another place/ }),
	).toBeVisible();
	await main.getByRole("button", { name: "Submit", exact: true }).click();
	await expect(first).toHaveCount(0);
	await expect(
		main.getByRole("button", { name: "Visit report", exact: true }),
	).toBeVisible();

	await page.getByRole("button", { name: /^Running as / }).click();
	await page.getByRole("menuitemradio", { name: /^Android/ }).click();
	await main.getByRole("button", { name: "Start", exact: true }).click();
	await main.getByRole("button", { name: /^Outreach/ }).click();
	await main.getByRole("button", { name: "Visit report", exact: true }).click();
	const confirmation = main.getByRole("checkbox", {
		name: "OK. Please continue.",
	});
	await expect(confirmation).not.toBeChecked();
	const next = main.getByRole("button", { name: "Next", exact: true });
	await next.click();
	await expect(
		main.getByText("This field is required", { exact: true }),
	).toBeVisible();
	await confirmation.check();
	await next.click();
	const invitation = page.getByRole("alertdialog", { name: "Record a place" });
	await invitation
		.getByRole("button", { name: "Record a place", exact: true })
		.click();
	await main.getByRole("textbox", { name: /Village/ }).fill("Fern Valley");
	await next.click();
	await expect(
		page.getByRole("alertdialog", { name: "Record another place" }),
	).toBeVisible();
});
