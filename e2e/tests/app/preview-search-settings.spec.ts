import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder } from "../../lib/pageLoads";

test("shares a confirmed local search profile across signed-in tabs and lets a stale editor recover", {
	tag: "@seed:app-tests",
}, async ({ scenario, page, context }) => {
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
	try {
		const first = await openSettings(page);
		const second = await openSettings(peer);
		await expect(second.getByLabel("Project space time zone")).toHaveValue(
			"UTC",
		);
		await first.getByLabel("Project space time zone").fill("Europe/Paris");
		await first.getByRole("button", { name: "Save settings" }).click();
		await expect(first).toBeHidden();
		await second.getByLabel("Project space time zone").fill("Asia/Kolkata");
		await second.getByRole("button", { name: "Save settings" }).click();
		await expect(second).toContainText("A teammate updated these settings");
		await second
			.getByRole("button", { name: "Review latest settings" })
			.click();
		await expect(second.getByLabel("Project space time zone")).toHaveValue(
			"Europe/Paris",
		);
		await expect(second).toContainText("Supplied by your team");
	} finally {
		await peer.close();
	}
});
