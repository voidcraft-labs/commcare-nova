import type { Page } from "@playwright/test";
import { expect, seedFor, test } from "../../lib/appFixtures";
import { FORM_SECTIONS_SEED } from "../../lib/formSectionsSeed";
import { openBuilder } from "../../lib/pageLoads";

/**
 * The Phone Number question is a Text question with a number keypad. The
 * question picker's Phone number row inserts one, the Text inspector's
 * Number keypad switch turns it off and on again (one save each), and
 * Preview plays each platform's keypad: Web Apps refuses `12 34` with its
 * message, and Android's keypad has no letters, so `a1` leaves `1`.
 */

const REFUSAL =
	"This answer takes digits, with an optional + or - in front and an optional decimal part.";
const KEYPAD_LINE =
	"Workers type on a number keypad. The answer is kept as text, so a leading zero or a + stays.";

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

/** Open the insertion menu at the end of the form's last section. The form's
 *  last gap is the root's, after every section, and offers a new section
 *  alone; the gap before it closes the last section and offers questions. */
async function openQuestionMenu(page: Page) {
	const gaps = page.locator("[data-insertion-point] > button");
	await expect(gaps.first()).toBeAttached();
	await gaps.nth((await gaps.count()) - 2).click();
	const input = page.getByRole("menuitem", { name: "Input", exact: true });
	await expect(input).toBeVisible();
	return input;
}

test("the Phone number entry, its keypad switch, and each platform's keypad in Preview", {
	tag: "@seed:sections",
}, async ({ scenario, page }) => {
	const seed = seedFor(scenario, "sections");
	test.setTimeout(120_000);
	const appId = seed.formSections.appId;
	const main = page.locator("main");
	const keypad = page.getByRole("switch", { name: "Number keypad" });

	await test.step("the picker's Phone number row inserts a Text question with a number keypad", async () => {
		await openBuilder(page, seed.formSections.route);
		const input = await openQuestionMenu(page);
		await input.hover();
		const added = savedWith(page, appId, [
			'"kind":"addField"',
			'"keypad":"numbers"',
			'"id":"new_phone_number"',
		]);
		await page
			.getByRole("menuitem", { name: "Phone number", exact: true })
			.click();
		expect((await added).ok()).toBe(true);
		await expect(keypad).toBeVisible();
		await expect(keypad).toBeChecked();
		await expect(page.getByText(KEYPAD_LINE)).toBeVisible();
	});

	await test.step("the Number keypad switch turns the keypad off and on, one save each", async () => {
		const off = savedWith(page, appId, ['"keypad":null']);
		await keypad.click();
		expect((await off).ok()).toBe(true);
		await expect(keypad).not.toBeChecked();
		const on = savedWith(page, appId, ['"keypad":"numbers"']);
		await keypad.click();
		expect((await on).ok()).toBe(true);
		await expect(keypad).toBeChecked();
	});

	const phone = main.getByRole("textbox", { name: "New Phone Number" });

	await test.step("Preview in Web Apps refuses 12 34 with its message", async () => {
		await page.getByRole("button", { name: "Preview", exact: true }).click();
		const identity = page.getByRole("button", { name: /^Running as / });
		await expect(identity).toHaveAccessibleName(/ in Web Apps\. /, {
			timeout: 20_000,
		});
		await expect(phone).toBeVisible({ timeout: 20_000 });
		await expect(phone).toHaveAttribute("inputmode", "tel");
		await phone.fill("+254712");
		await phone.blur();
		await expect(main.getByText(REFUSAL)).toHaveCount(0);
		await phone.fill("12 34");
		await phone.blur();
		await expect(main.getByText(REFUSAL)).toBeVisible();
		await expect(phone).toHaveValue("12 34");
	});

	await test.step("Preview on Android drops a letter the keypad lacks", async () => {
		const identity = page.getByRole("button", { name: /^Running as / });
		await identity.click();
		await page.getByRole("menuitemradio", { name: /^Android/ }).click();
		await expect(identity).toHaveAccessibleName(/ on Android\. /);
		await main
			.getByRole("button", { name: "Start", exact: true })
			.click({ timeout: 20_000 });
		await main
			.getByRole("button", {
				name: new RegExp(`^${FORM_SECTIONS_SEED.moduleName}`),
			})
			.click();
		await main
			.getByRole("button", { name: FORM_SECTIONS_SEED.formName, exact: true })
			.click();
		const next = main.getByRole("button", { name: "Next", exact: true });
		await expect(
			main.getByRole("navigation", { name: "Sections" }),
		).toBeVisible({ timeout: 20_000 });
		if ((await phone.count()) === 0) {
			await main
				.getByRole("textbox", { name: FORM_SECTIONS_SEED.aboutYou.nameLabel })
				.fill("Ada");
			await next.click();
		}
		await expect(phone).toBeVisible();
		await phone.fill("a1");
		await expect(phone).toHaveValue("1");
		await phone.blur();
		await expect(main.getByText(REFUSAL)).toHaveCount(0);
	});
});

test("a date keeps its calendar through a keyboard edit, undo and an Android preview", {
	tag: "@seed:sections",
}, async ({ scenario, page }) => {
	test.setTimeout(120_000);
	const seed = seedFor(scenario, "sections");
	const appId = seed.formSections.appId;
	const main = page.locator("main");
	await openBuilder(page, seed.formSections.route);
	await openQuestionMenu(page);
	await page
		.getByRole("menuitem", { name: "Date & Time", exact: true })
		.hover();
	const added = savedWith(page, appId, [
		'"kind":"addField"',
		'"id":"new_date"',
	]);
	await page.getByRole("menuitem", { name: "Date", exact: true }).click();
	expect((await added).ok()).toBe(true);

	await page.getByRole("button", { name: "Calendar", exact: true }).click();
	const calendar = page.getByRole("combobox", {
		name: "Calendar",
		exact: true,
	});
	const selected = savedWith(page, appId, ['"calendar":"ethiopian"']);
	await calendar.focus();
	await calendar.press("Enter");
	await page
		.getByRole("option", { name: "Ethiopian", exact: true })
		.press("Enter");
	expect((await selected).ok()).toBe(true);
	await expect(calendar).toContainText("Ethiopian");

	await page
		.getByRole("button", { name: "Items per row", exact: true })
		.click();
	const count = page.getByRole("textbox", {
		name: "Items per row",
		exact: true,
	});
	const two = savedWith(page, appId, ['"itemsPerRow":"2"']);
	await count.fill("2");
	await count.press("Tab");
	expect((await two).ok()).toBe(true);
	await expect(calendar).toContainText("Ethiopian");

	await page.getByRole("button", { name: "Preview", exact: true }).click();
	const date = main.locator('[data-instance-path$="/new_date"]');
	const picker = date.getByRole("button").first();
	await picker.click();
	const firstDay = page
		.getByRole("button", { pressed: false })
		.filter({ hasText: /^1$/ })
		.first();
	const dayLabel = await firstDay.getAttribute("aria-label");
	if (!dayLabel)
		throw new Error("The first calendar day needs its displayed date.");
	await firstDay.click();
	await expect(picker).toHaveText(dayLabel);

	await page.getByRole("button", { name: "Back to edit", exact: true }).click();
	const undone = savedWith(page, appId, ['"itemsPerRow":null']);
	await page.getByRole("button", { name: "Undo", exact: true }).click();
	expect((await undone).ok()).toBe(true);
	await expect(calendar).toContainText("Ethiopian");
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	const identity = page.getByRole("button", { name: /^Running as / });
	await identity.click();
	await page.getByRole("menuitemradio", { name: /^Android/ }).click();
	await main.getByRole("button", { name: "Start", exact: true }).click();
	await main
		.getByRole("button", {
			name: new RegExp(`^${FORM_SECTIONS_SEED.moduleName}`),
		})
		.click();
	await main
		.getByRole("button", { name: FORM_SECTIONS_SEED.formName, exact: true })
		.click();
	await expect(
		main.getByRole("navigation", { name: "Sections" }),
	).toBeVisible();
	if (!(await date.count())) {
		await main
			.getByRole("textbox", { name: FORM_SECTIONS_SEED.aboutYou.nameLabel })
			.fill("Ada");
		await main.getByRole("button", { name: "Next", exact: true }).click();
	}
	await page.setViewportSize({ width: 390, height: 844 });
	await picker.click();
	await expect(
		page.getByRole("button", { name: dayLabel, exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: dayLabel, exact: true }).click();
	await expect(picker).toHaveText(dayLabel);
});

test("a worker gets a dropdown in Web Apps and an editable picture grid on Android", {
	tag: "@seed:sections",
}, async ({ scenario, page }) => {
	const seed = seedFor(scenario, "sections");
	const appId = seed.formSections.appId;
	await openBuilder(page, seed.formSections.route);
	await openQuestionMenu(page);
	await page.getByRole("menuitem", { name: "Choice", exact: true }).hover();
	const added = savedWith(page, appId, [
		'"kind":"addField"',
		'"kind":"single_select"',
	]);
	await page
		.getByRole("menuitem", { name: "Single Select", exact: true })
		.click();
	expect((await added).ok()).toBe(true);
	await page
		.getByRole("button", { name: "Choice layout", exact: true })
		.click();
	const layout = page.getByRole("combobox", {
		name: "Choice layout",
		exact: true,
	});
	await layout.click();
	const split = savedWith(page, appId, ['"kind":"platforms"']);
	await page
		.getByRole("option", { name: "Different layouts by platform", exact: true })
		.click();
	expect((await split).ok()).toBe(true);
	const platforms = page.getByRole("combobox", {
		name: "Platform layouts",
		exact: true,
	});
	await platforms.click();
	const pair = savedWith(page, appId, [
		'"web":{"kind":"dropdown"}',
		'"android":{"kind":"grid"}',
	]);
	await page
		.getByRole("option", {
			name: "Dropdown in Web Apps, grid on Android",
			exact: true,
		})
		.click();
	expect((await pair).ok()).toBe(true);
	const columns = page.getByRole("textbox", { name: "Columns", exact: true });
	const three = savedWith(page, appId, ['"kind":"platforms"', '"columns":3']);
	await columns.fill("3");
	await columns.press("Tab");
	expect((await three).ok()).toBe(true);
	const advance = savedWith(page, appId, [
		'"columns":3',
		'"advanceOnChoice":true',
	]);
	await page
		.getByRole("switch", { name: "Advance after a choice", exact: true })
		.click();
	expect((await advance).ok()).toBe(true);
	await expect(platforms).toHaveText("Dropdown in Web Apps, grid on Android");
	await expect(columns).toHaveValue("3");
});
