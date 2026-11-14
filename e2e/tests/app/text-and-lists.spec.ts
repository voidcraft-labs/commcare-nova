import type { Page } from "@playwright/test";
import { expect, seedFor, test } from "../../lib/appFixtures";
import { FORM_SECTIONS_SEED } from "../../lib/formSectionsSeed";
import { openBuilder } from "../../lib/pageLoads";
import { replaceRichText } from "../../lib/richText";

/**
 * A search with no title, where a sort rule puts blank values, and text shown
 * as typed: the Search panel's Show a title switch, each Default order rule's
 * Blank values control, a help text's Format text switch and a form's Format
 * text in this form switch, each with what it saves and what the canvas and
 * Preview then draw.
 */

/** The next autosave of the app whose body holds `fragment`. */
function savedWith(page: Page, appId: string, fragment: string) {
	return page.waitForResponse((response) => {
		const request = response.request();
		return (
			request.method() === "PUT" &&
			new URL(response.url()).pathname === `/api/apps/${appId}` &&
			(request.postData() ?? "").includes(fragment)
		);
	});
}

test("Show a title turns a search's title off and on again", {
	tag: "@seed:workspace",
}, async ({ scenario, page }) => {
	const seed = seedFor(scenario, "workspace");
	const appId = seed.caseWorkspace.appId;
	await openBuilder(page, seed.caseWorkspace.routes.search);
	await expect(
		page.getByRole("heading", { name: "Search", level: 1 }),
	).toBeVisible({ timeout: 20_000 });
	const panel = page.locator("[data-case-search-panel]").first();
	await expect(
		panel.getByRole("heading", { name: "Find a patient" }),
	).toBeVisible();
	await panel.click();

	const showTitle = page.locator("[data-search-show-title]");
	const toggle = showTitle.getByRole("switch", { name: /^Show a title/ });
	await expect(toggle).toBeChecked();
	await expect(showTitle).toContainText(
		"A heading above the search fields in Web Apps",
	);
	await expect(page.getByRole("textbox", { name: "Title" })).toBeVisible();

	const off = savedWith(page, appId, '"searchScreenTitle":{"kind":"none"}');
	await toggle.click();
	expect((await off).ok()).toBe(true);
	await expect(toggle).not.toBeChecked();
	await expect(showTitle).toHaveAttribute("data-search-show-title", "false");
	await expect(page.getByRole("textbox", { name: "Title" })).toHaveCount(0);
	// The canvas draws no title for a search with none.
	await expect(
		panel.getByRole("heading", { name: "Find a patient" }),
	).toHaveCount(0);

	const on = savedWith(page, appId, '"searchScreenTitle":null');
	await toggle.click();
	expect((await on).ok()).toBe(true);
	await expect(toggle).toBeChecked();
	await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue(
		"Search",
	);
	await expect(panel.getByRole("heading", { name: "Search" })).toBeVisible();
});

test("Blank values keeps the side a person picked through two turns of the direction", {
	tag: "@seed:workspace",
}, async ({ scenario, page }) => {
	const seed = seedFor(scenario, "workspace");
	const appId = seed.caseWorkspace.appId;
	await openBuilder(page, seed.caseWorkspace.routes.results);
	const composer = page.locator("[data-case-ordering-composer]");
	await expect(composer).toBeVisible({ timeout: 20_000 });
	await composer.getByRole("button", { name: "Change default order" }).click();

	// The first rule orders descending, whose own side is last.
	const rule = composer.locator("[data-case-ordering-rule]").first();
	const blanks = rule.locator("[data-case-ordering-blanks]");
	await expect(blanks).toHaveAttribute("data-case-ordering-blanks", "last");
	await expect(blanks).toContainText("Blank values");

	const picked = savedWith(page, appId, '"blanks":"first"');
	await blanks.click();
	await page.getByRole("menuitemradio", { name: "First" }).click();
	expect((await picked).ok()).toBe(true);
	await expect(blanks).toHaveAttribute("data-case-ordering-blanks", "first");
	await expect(composer).toContainText(", blanks first");

	// Ascending puts blanks first already, so the rule stores no blanks...
	const direction = rule.locator("[data-case-ordering-direction]");
	const ascending = savedWith(page, appId, '"direction":"asc"');
	await direction.click();
	await page.getByRole("menuitemradio").first().click();
	expect((await ascending).ok()).toBe(true);
	await expect(blanks).toHaveAttribute("data-case-ordering-blanks", "first");
	await expect(composer).not.toContainText(", blanks first");

	// ...and turned back, it keeps the side the person picked.
	const back = savedWith(page, appId, '"blanks":"first"');
	await direction.click();
	await page.getByRole("menuitemradio").last().click();
	expect((await back).ok()).toBe(true);
	await expect(blanks).toHaveAttribute("data-case-ordering-blanks", "first");
	await expect(composer).toContainText(", blanks first");
});

/* A help text whose Markdown reading differs from what was typed: the escape
 * reads as a bare asterisk, and typing it leaves no editor input rule to
 * turn it into a mark. */
const TYPED_HELP = "Count 5\\*3 rows";
const FORMATTED_HELP = "Count 5*3 rows";

test("Format text on a help text and Format text in this form, with what the canvas and Preview draw", {
	tag: "@seed:sections",
}, async ({ scenario, page }) => {
	test.setTimeout(120_000);
	const seed = seedFor(scenario, "sections");
	const appId = seed.formSections.appId;
	const main = page.locator("main");
	const properties = page.getByRole("dialog", {
		name: "Properties",
		exact: true,
	});
	const helpSwitch = properties.getByRole("switch", { name: "Format text" });

	await test.step("a help text is added with formatting on", async () => {
		await openBuilder(page, seed.formSections.route);
		await page
			.getByRole("button", {
				name: FORM_SECTIONS_SEED.yourVisit.noteLabel,
				exact: true,
			})
			.first()
			.click();
		await properties.getByRole("button", { name: "Help", exact: true }).click();
		const help = properties.getByRole("textbox", { name: "Help", exact: true });
		const saved = savedWith(page, appId, '"help"');
		await replaceRichText(help, TYPED_HELP);
		await help.press("Enter");
		expect((await saved).ok()).toBe(true);
		await expect(helpSwitch).toBeChecked();
		await expect(main.getByText(FORMATTED_HELP, { exact: true })).toBeVisible();
	});

	await test.step("turning the help's formatting off asks first, then saves plainHelp", async () => {
		await helpSwitch.click();
		const prompt = properties.locator("[data-format-text-prompt]");
		await expect(prompt).toContainText(
			"This text uses formatting. With Format text off, workers see its symbols as you typed them.",
		);
		const off = savedWith(page, appId, '"plainHelp":true');
		await prompt
			.getByRole("button", { name: "Turn it off", exact: true })
			.click();
		expect((await off).ok()).toBe(true);
		await expect(helpSwitch).not.toBeChecked();
		await expect(properties.locator("[data-format-text-line]")).toHaveText(
			"On Android, workers see this help as you typed it. Web Apps formats every help text.",
		);
		await expect(main.getByText(TYPED_HELP, { exact: true })).toBeVisible();

		const on = savedWith(page, appId, '"plainHelp":null');
		await helpSwitch.click();
		expect((await on).ok()).toBe(true);
		await expect(helpSwitch).toBeChecked();
		await expect(main.getByText(FORMATTED_HELP, { exact: true })).toBeVisible();
	});

	await test.step("Format text in this form asks first, then turns every text's formatting off", async () => {
		await page
			.getByRole("button", { name: "Form settings", exact: true })
			.click();
		const settings = page
			.getByRole("dialog")
			.filter({ hasText: "Form settings" });
		const formSwitch = settings.getByRole("switch", {
			name: /^Format text in this form/,
		});
		await expect(formSwitch).toBeChecked();
		await expect(settings).toContainText(
			"Off shows every label exactly as typed, and every choice and help text too on Android. Web Apps still formats those two. It also keeps CommCare HQ's form builder from adding formatting.",
		);
		await formSwitch.click();
		const prompt = settings.locator("[data-format-text-prompt]");
		await expect(prompt).toContainText(
			"Some text in this form uses formatting. With Format text off, workers see its symbols as you typed them.",
		);
		const off = savedWith(page, appId, '"plainText":true');
		await prompt
			.getByRole("button", { name: "Turn it off", exact: true })
			.click();
		expect((await off).ok()).toBe(true);
		await expect(formSwitch).not.toBeChecked();
		await page.keyboard.press("Escape");
		await expect(settings).toHaveCount(0);
	});

	await test.step("under the form's switch the help's toggle shows off and keeps its own setting", async () => {
		await expect(helpSwitch).not.toBeChecked();
		await expect(helpSwitch).toBeDisabled();
		await expect(properties.locator("[data-format-text-line]")).toHaveText(
			"Text formatting is off for this whole form",
		);
		await expect(main.getByText(TYPED_HELP, { exact: true })).toBeVisible();
	});

	await test.step("Preview in Web Apps still formats the help text", async () => {
		await page.getByRole("button", { name: "Preview", exact: true }).click();
		const identity = page.getByRole("button", { name: /^Running as / });
		await expect(identity).toHaveAccessibleName(/ in Web Apps\. /, {
			timeout: 20_000,
		});
		await main
			.getByRole("button", { name: "Show help", exact: true })
			.click({ timeout: 20_000 });
		const dialog = page.getByRole("dialog", {
			name: FORM_SECTIONS_SEED.yourVisit.noteLabel,
		});
		await expect(dialog).toContainText(FORMATTED_HELP);
		await expect(dialog).not.toContainText(TYPED_HELP);
		await dialog.getByRole("button", { name: "Close", exact: true }).click();
		await page
			.getByRole("button", { name: "Back to edit", exact: true })
			.click();
	});

	await test.step("turning the form's switch back on gives the help its own setting again", async () => {
		await page
			.getByRole("button", { name: "Form settings", exact: true })
			.click();
		const settings = page
			.getByRole("dialog")
			.filter({ hasText: "Form settings" });
		const formSwitch = settings.getByRole("switch", {
			name: /^Format text in this form/,
		});
		const on = savedWith(page, appId, '"plainText":null');
		await formSwitch.click();
		expect((await on).ok()).toBe(true);
		await expect(formSwitch).toBeChecked();
		await page.keyboard.press("Escape");
		await expect(settings).toHaveCount(0);
		await expect(helpSwitch).toBeChecked();
		await expect(helpSwitch).toBeEnabled();
		await expect(main.getByText(FORMATTED_HELP, { exact: true })).toBeVisible();
	});
});
