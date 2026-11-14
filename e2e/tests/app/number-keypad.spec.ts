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

/** Open the insertion menu at the last gap of the form that offers questions
 *  (the root gaps of a sectioned form offer a new section alone). */
async function openQuestionMenu(page: Page) {
	const gaps = page.locator("[data-insertion-point] > button");
	await expect(gaps.first()).toBeAttached();
	const input = page.getByRole("menuitem", { name: "Input", exact: true });
	for (let index = (await gaps.count()) - 1; index >= 0; index--) {
		await gaps.nth(index).click();
		await expect(page.getByRole("menu").first()).toBeVisible();
		if ((await input.count()) > 0) return input;
		await page.keyboard.press("Escape");
		await expect(page.getByRole("menu")).toHaveCount(0);
	}
	throw new Error("No insertion gap in the form offers questions.");
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
