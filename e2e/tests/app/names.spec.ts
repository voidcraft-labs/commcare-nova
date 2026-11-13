import type { Page } from "@playwright/test";
import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder, reloadBuilder } from "../../lib/pageLoads";

/** Wait for the save of a batch whose body holds every one of `parts`. */
function savedWith(page: Page, appId: string, parts: readonly string[]) {
	return page.waitForResponse((response) => {
		const request = response.request();
		const body = request.postData() ?? "";
		return (
			new URL(response.url()).pathname === `/api/apps/${appId}` &&
			request.method() === "PUT" &&
			parts.every((part) => body.includes(part))
		);
	});
}

/** Open the starter form, whose canvas holds the insertion gaps. */
async function openStarterForm(page: Page) {
	await page
		.getByRole("list", { name: "Survey forms" })
		.getByRole("button", { name: "Survey", exact: true })
		.click();
	await expect(page.locator("[data-insertion-point]").first()).toBeAttached();
}

/** Add a Single Select at the form's last gap and wait for its save. */
async function addSingleSelect(page: Page, appId: string) {
	await page.locator("[data-insertion-point] > button").last().click();
	await page.getByRole("menuitem", { name: "Choice", exact: true }).hover();
	const added = savedWith(page, appId, ['"kind":"addField"']);
	await page
		.getByRole("menuitem", { name: "Single Select", exact: true })
		.click();
	expect((await added).ok()).toBe(true);
}

test("a question ID takes a hyphen, and a choice holds a quote mark and stands alone", {
	tag: "@seed:open",
}, async ({ scenario, page }) => {
	const { openAppId } = seedFor(scenario, "open");
	await openBuilder(page, `/build/${openAppId}`);
	await openStarterForm(page);
	await addSingleSelect(page, openAppId);

	// The ID HQ's form builder writes for a duplicated question's family:
	// hyphens are part of the grammar, so the rename saves as typed.
	const idInput = page.locator('[data-field-id="id"] input').visible();
	await expect(idInput).toBeVisible();
	const renamed = savedWith(page, openAppId, ['"id":"first-name"']);
	await idInput.fill("first-name");
	await idInput.press("Enter");
	expect((await renamed).ok()).toBe(true);
	await expect(idInput).toHaveValue("first-name");
	await expect(page.locator('[data-tree-field="first-name"]')).toBeVisible();

	// A value keeps its apostrophe as typed: the editor no longer drops it.
	const values = page.getByPlaceholder("value", { exact: true });
	await expect(values.first()).toBeVisible();
	const quoted = savedWith(page, openAppId, [`"value":"it's"`]);
	await values.first().fill("it's");
	await values.first().press("Tab");
	expect((await quoted).ok()).toBe(true);
	await expect(values.first()).toHaveValue("it's");

	// Choices come off until one is left, and the last one stays.
	const removals = page.getByRole("button", { name: /^Remove / });
	while ((await values.count()) > 1) {
		const before = await values.count();
		const removed = savedWith(page, openAppId, ['"kind":"removeOption"']);
		await removals.last().click();
		expect((await removed).ok()).toBe(true);
		await expect(values).toHaveCount(before - 1);
	}
	await expect(values).toHaveCount(1);
	await expect(removals).toHaveCount(1);
	await expect(removals.first()).toBeDisabled();
	await expect(values.first()).toHaveValue("it's");

	await reloadBuilder(page);
	await expect(page.locator('[data-tree-field="first-name"]')).toBeVisible();
	await expect(idInput).toHaveValue("first-name");
	await expect(values).toHaveCount(1);
	await expect(values.first()).toHaveValue("it's");
});

test("a case type typed with a space and a leading digit is created as HQ's menu page takes it", {
	tag: "@seed:open",
}, async ({ scenario, page }) => {
	const { openAppId } = seedFor(scenario, "open");
	await openBuilder(page, `/build/${openAppId}`);
	// The starter's module row opens its module screen, which holds its settings.
	await page
		.getByRole("heading", { name: "Survey", exact: true, level: 3 })
		.first()
		.click();
	await page
		.getByRole("button", { name: "Module settings", exact: true })
		.click();
	await page
		.getByRole("button", { name: /^Case type: / })
		.first()
		.click();
	const draft = page.getByPlaceholder("For example, Follow-up visit");
	await draft.fill("1st visit");
	const created = savedWith(page, openAppId, ['"1st_visit"']);
	await page.getByRole("button", { name: "Create", exact: true }).click();
	expect((await created).ok()).toBe(true);
	await expect(
		page.getByRole("button", { name: "Case type: 1st_visit" }),
	).toBeVisible();
	await expect(page.getByRole("alert")).toHaveCount(0);
});
