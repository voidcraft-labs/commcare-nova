import type { Page } from "@playwright/test";
import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder, reloadBuilder } from "../../lib/pageLoads";

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

	await openBuilder(page, `/build/${openAppId}`);
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

	await reloadBuilder(page);
	await openAppSettings(page);
	await expect(saved).toBeChecked();
	await expect(incomplete).toBeChecked();
});

// ── Where workers use the app ───────────────────────────────────────────

/** The picker lines the platform table writes (`platformPickerLine`). */
const DATETIME_PICKER_LINE =
	"Not available in Web Apps. You can ask for a date and a time as two questions, or change where this app runs in App settings.";

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

/** Open the insertion menu at the form's last gap and a submenu of it. */
async function openInsertionSubmenu(page: Page, category: string) {
	await page.locator("[data-insertion-point] > button").last().click();
	await page.getByRole("menuitem", { name: category, exact: true }).hover();
}

async function choosePlatforms(
	page: Page,
	choice: "both" | "web-apps" | "android",
) {
	await page.locator(`[data-platform-choice="${choice}"]`).click();
}

test("where workers use the app can be changed, and a question it can't run is named and split", {
	tag: "@seed:open",
}, async ({ scenario, page }) => {
	const { openAppId } = seedFor(scenario, "open");
	await openBuilder(page, `/build/${openAppId}`);
	await openStarterForm(page);

	// A new app runs on both, so Date/Time is offered disabled with its line,
	// and the two-question insertion follows it.
	await openInsertionSubmenu(page, "Date & Time");
	const datetimeItem = page.getByRole("menuitem", { name: /^Date\/Time/ });
	await expect(datetimeItem).toBeDisabled();
	await expect(datetimeItem).toContainText(DATETIME_PICKER_LINE);
	await expect(
		page.getByRole("menuitem", { name: /^Date and time \(as two questions\)/ }),
	).toBeVisible();
	await page.keyboard.press("Escape");
	await page.keyboard.press("Escape");

	// Android only commits through the client gate.
	await openAppSettings(page);
	const narrowed = savedWith(page, openAppId, [
		'"kind":"setAppSettings"',
		'"runsOnlyOn":"android"',
	]);
	await choosePlatforms(page, "android");
	expect((await narrowed).ok()).toBe(true);
	await expect(
		page.getByRole("radio", { name: /^Android only/ }),
	).toBeChecked();
	await page.keyboard.press("Escape");

	// Date/Time is then offered, and inserts.
	await openInsertionSubmenu(page, "Date & Time");
	const inserted = savedWith(page, openAppId, ['"kind":"addField"']);
	await page.getByRole("menuitem", { name: "Date/Time", exact: true }).click();
	expect((await inserted).ok()).toBe(true);

	// Adding Web Apps back names the question in the way.
	await openAppSettings(page);
	await choosePlatforms(page, "both");
	const block = page.locator("[data-platform-refusal]");
	await expect(block).toContainText(
		"Web Apps can't run one thing this app uses",
	);
	await block.getByRole("button", { name: "Open new_datetime" }).click();
	await expect(
		page.locator('[data-field-id="id"] input').visible(),
	).toHaveValue("new_datetime");
	await expect(block).toBeVisible();

	// Its split leaves nothing in the way, and the block closes.
	const split = savedWith(page, openAppId, ['"kind":"convertField"']);
	await block
		.getByRole("button", { name: "Ask for the date and the time separately" })
		.click();
	expect((await split).ok()).toBe(true);
	await expect(block).toHaveCount(0);

	const widened = savedWith(page, openAppId, [
		'"kind":"setAppSettings"',
		'"runsOnlyOn":null',
	]);
	await choosePlatforms(page, "both");
	expect((await widened).ok()).toBe(true);

	await reloadBuilder(page);
	await openAppSettings(page);
	await expect(
		page.getByRole("radio", { name: /^Web Apps and Android/ }),
	).toBeChecked();
	await page.keyboard.press("Escape");
	for (const id of ["new_datetime_date", "new_datetime_time", "new_datetime"])
		await expect(page.locator(`[data-tree-field="${id}"]`)).toBeVisible();
});

test("a date and a time can be asked for in an app that runs in Web Apps", {
	tag: "@seed:open",
}, async ({ scenario, page }) => {
	const { openAppId } = seedFor(scenario, "open");
	await openBuilder(page, `/build/${openAppId}`);
	await openStarterForm(page);

	await openInsertionSubmenu(page, "Date & Time");
	const added = savedWith(page, openAppId, ['"kind":"addField"']);
	await page
		.getByRole("menuitem", { name: /^Date and time \(as two questions\)/ })
		.click();
	expect((await added).ok()).toBe(true);
	const ids = ["new_datetime_date", "new_datetime_time", "new_datetime"];
	for (const id of ids)
		await expect(page.locator(`[data-tree-field="${id}"]`)).toBeVisible();
	await expect(
		page.locator('[data-field-id="id"] input').visible(),
	).toHaveValue("new_datetime_date");

	// One undo removes all three.
	const undone = savedWith(page, openAppId, ['"kind":"removeField"']);
	await page.getByRole("button", { name: "Undo", exact: true }).click();
	expect((await undone).ok()).toBe(true);
	for (const id of ids)
		await expect(page.locator(`[data-tree-field="${id}"]`)).toHaveCount(0);
});

test("a stated difference shows where the author works", {
	tag: "@seed:open",
}, async ({ scenario, page }) => {
	const { openAppId } = seedFor(scenario, "open");
	await openBuilder(page, `/build/${openAppId}`);
	await openStarterForm(page);

	await openInsertionSubmenu(page, "Attachments and scanning");
	const added = savedWith(page, openAppId, ['"kind":"addField"']);
	await page.getByRole("menuitem", { name: "Image", exact: true }).click();
	expect((await added).ok()).toBe(true);
	const note = page.locator('[data-platform-note="image-question"]');
	await expect(note).toContainText("In Web Apps,");
	await expect(note).toContainText("On Android,");

	await openAppSettings(page);
	const narrowed = savedWith(page, openAppId, ['"runsOnlyOn":"android"']);
	await choosePlatforms(page, "android");
	expect((await narrowed).ok()).toBe(true);
	await expect(note).toHaveCount(0);
});

test("turning on Connect says it sets the app to Android only", {
	tag: "@seed:open",
}, async ({ scenario, page }) => {
	const { openAppId } = seedFor(scenario, "open");
	await openBuilder(page, `/build/${openAppId}`);
	await openAppSettings(page);
	await page.getByRole("button", { name: "Set up", exact: true }).click();
	await expect(page.getByRole("dialog")).toContainText(
		"Connect workers open this app in the Connect app on Android, so turning on Connect sets it to run on Android only.",
	);
});

test("turning off Connect keeps the app on Android only", {
	tag: "@seed:connect-learn",
}, async ({ scenario, page }) => {
	const { connectLearn } = seedFor(scenario, "connect-learn");
	await openBuilder(page, `/build/${connectLearn.appId}`);
	await openAppSettings(page);
	await page.getByRole("button", { name: "Manage", exact: true }).click();
	const manager = page.getByRole("dialog").filter({
		hasText: "CommCare Connect",
	});
	await expect(manager).toContainText(
		"Turning off Connect keeps this app running on Android only. You can change where it runs in App settings.",
	);
	const turnedOff = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname === `/api/apps/${connectLearn.appId}` &&
			response.request().method() === "PUT",
	);
	await manager.getByRole("button", { name: "Turn off Connect" }).click();
	expect((await turnedOff).ok()).toBe(true);
	await expect(manager).toHaveCount(0);
	const androidOnly = page.getByRole("radio", { name: /^Android only/ });
	// The dialog may have taken App settings with it as it opened.
	if (!(await androidOnly.isVisible())) await openAppSettings(page);
	await expect(androidOnly).toBeChecked();
});
