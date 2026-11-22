import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder } from "../../lib/pageLoads";
import { createSmokeContext } from "../../lib/smokeNetwork";

test("shares a confirmed local search profile across signed-in tabs and lets a stale editor recover", {
	tag: "@seed:app-tests",
}, async ({ scenario, page, context, browser, baseURL }) => {
	const { appId } = seedFor(scenario, "app-tests");
	async function openSettings(tab: typeof page) {
		await openBuilder(tab, `/build/${appId}`);
		await tab.getByRole("button", { name: "Preview", exact: true }).click();
		await tab.getByRole("button", { name: /Running as/ }).click();
		await tab
			.getByRole("menuitem", { name: "Preview search settings", exact: true })
			.click();
		const dialog = tab.getByRole("dialog", { name: "Preview search settings" });
		await expect(dialog).toContainText("500-record limit.");
		await dialog.getByRole("combobox", { name: "Search destination" }).click();
		await tab.getByRole("option", { name: "Local Preview" }).click();
		return dialog;
	}
	const peer = await context.newPage();
	const viewer = await createSmokeContext(browser, {
		baseURL,
		storageState: scenario.common.viewerStorageState,
	});
	try {
		const first = await openSettings(page);
		const second = await openSettings(peer);
		const viewing = await openSettings(await viewer.newPage());
		await expect(viewing.getByLabel("Project space time zone")).toBeDisabled();
		await expect(viewing.getByLabel("Project space time zone")).toHaveValue(
			"UTC",
		);
		await expect(
			viewing.getByRole("button", { name: "Save settings" }),
		).toHaveCount(0);
		await expect(second.getByLabel("Project space time zone")).toHaveValue(
			"UTC",
		);
		// The viewer and the untouched editor both follow this revision.
		await first.getByLabel("Project space time zone").fill("Europe/Paris");
		await first.getByRole("button", { name: "Save settings" }).click();
		await expect(first).toBeHidden();
		await expect(viewing.getByLabel("Project space time zone")).toHaveValue(
			"Europe/Paris",
		);
		await expect(second.getByLabel("Project space time zone")).toHaveValue(
			"Europe/Paris",
		);
		await second.getByLabel("Project space time zone").fill("Asia/Kolkata");
		await page.getByRole("button", { name: /Running as/ }).click();
		await page
			.getByRole("menuitem", { name: "Preview search settings", exact: true })
			.click();
		await first.getByLabel("Project space time zone").fill("Europe/Berlin");
		await first.getByRole("button", { name: "Save settings" }).click();
		await expect(first).toBeHidden();
		await expect(viewing.getByLabel("Project space time zone")).toHaveValue(
			"Europe/Berlin",
		);
		await expect(second).toContainText("A teammate updated these settings");
		await expect(second.getByLabel("Project space time zone")).toHaveValue(
			"Asia/Kolkata",
		);
		await expect(
			second.getByRole("button", { name: "Save settings" }),
		).toBeDisabled();
		await second.getByText("Review team settings").click();
		await expect(second.getByRole("status")).toContainText("Europe/Berlin");
		await second.getByRole("button", { name: "Use latest settings" }).click();
		await expect(second.getByLabel("Project space time zone")).toHaveValue(
			"Europe/Berlin",
		);
		await expect(second).toContainText("Supplied by your team");
	} finally {
		await viewer.close();
		await peer.close();
	}
});
