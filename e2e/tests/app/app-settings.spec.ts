import type { Page } from "@playwright/test";
import { expect, seedFor, test } from "../../lib/appFixtures";

async function openAppSettings(page: Page) {
	await page.getByRole("button", { name: "App settings", exact: true }).click();
}

test("the saved and incomplete forms switches commit and survive a reload", {
	tag: "@seed:open",
}, async ({ scenario, page }) => {
	const { openAppId } = seedFor(scenario, "open");
	const saved = page.getByRole("switch", { name: /^Show saved forms/ });
	const incomplete = page.getByRole("switch", {
		name: /^Show incomplete forms/,
	});

	/** Toggle one switch and wait for the save that carries its one key, so
	 *  the reload reads the intended final state rather than racing it. */
	const toggleAndSave = async (
		control: typeof saved,
		key: "showSavedForms" | "showIncompleteForms",
	) => {
		const saveResponse = page.waitForResponse((response) => {
			const request = response.request();
			const body = request.postData() ?? "";
			return (
				new URL(response.url()).pathname === `/api/apps/${openAppId}` &&
				request.method() === "PUT" &&
				body.includes('"kind":"setAppSettings"') &&
				body.includes(`"${key}":true`)
			);
		});
		const [response] = await Promise.all([saveResponse, control.click()]);
		expect(response.ok()).toBe(true);
	};

	await page.goto(`/build/${openAppId}`);
	await openAppSettings(page);
	await expect(
		page.getByText("Saved and incomplete forms", { exact: true }),
	).toBeVisible();
	await expect(saved).not.toBeChecked();
	await expect(incomplete).not.toBeChecked();

	await toggleAndSave(saved, "showSavedForms");
	await expect(saved).toBeChecked();
	await expect(incomplete).not.toBeChecked();

	await toggleAndSave(incomplete, "showIncompleteForms");
	await expect(incomplete).toBeChecked();

	await page.reload();
	await openAppSettings(page);
	await expect(saved).toBeChecked();
	await expect(incomplete).toBeChecked();
});
