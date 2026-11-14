import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder } from "../../lib/pageLoads";
import { REGISTER_FROM_LIST_SEED } from "../../lib/previewRuntimeSeeds";

/**
 * Registration from the case list, always offered: Results' "Register from
 * this list" setting offers another menu's registration form on the list,
 * and Preview's Register button opens that form and, after submit, returns
 * to the list where the new case now shows.
 *
 * `Patients` lists one patient for a follow-up; `Registration` holds the one
 * registration form of patients. The journey offers it on the list, keeps
 * Back to this list, registers a second patient from the list's button, and
 * reads both on the list it returns to.
 */
test("a case list offers another menu's registration form and returns to the list with the new case", {
	tag: "@seed:register-from-list",
}, async ({ scenario, page }) => {
	const { registerFromList } = seedFor(scenario, "register-from-list");
	const seed = REGISTER_FROM_LIST_SEED;
	test.setTimeout(120_000);
	const main = page.locator("main");
	const setting = page.locator("[data-register-from-list-setting]");

	await test.step("the setting is on Results, offering the form with Back to this list", async () => {
		await openBuilder(page, registerFromList.route);
		await expect(
			page.getByRole("heading", { name: "Results", level: 1 }),
		).toBeVisible({ timeout: 20_000 });
		await expect(
			setting.getByRole("heading", { name: "Register from this list" }),
		).toBeVisible();
		await expect(setting).toHaveAttribute("data-register-from-list", "none");
		const saved = page.waitForResponse(
			(response) =>
				response.request().method() === "PUT" &&
				new URL(response.url()).pathname ===
					`/api/apps/${registerFromList.appId}` &&
				(response.request().postData() ?? "").includes(
					'"caseListRegistrationForm"',
				),
		);
		await setting.getByRole("combobox", { name: "Form" }).click();
		await page
			.getByRole("option", {
				name: `${seed.formName} in ${seed.registrationName}`,
			})
			.click();
		expect((await saved).ok()).toBe(true);
		await expect(setting).toHaveAttribute(
			"data-register-from-list",
			seed.formUuid,
		);
		await expect(
			setting.locator("[data-register-after-submit]"),
		).toHaveAttribute("data-register-after-submit", "case-list");
		await expect(
			setting.getByText(
				"The worker returns to the list, where the new case now shows.",
			),
		).toBeVisible();
	});

	await test.step("Preview's Register opens the form and returns to the list with the new case", async () => {
		await page.getByRole("button", { name: "Preview", exact: true }).click();
		await expect(main.getByText(seed.existing).first()).toBeVisible({
			timeout: 20_000,
		});
		const register = main.locator("[data-case-list-register]");
		await expect(register).toHaveText(seed.formName);
		await register.click();
		const name = main.getByRole("textbox", { name: /Name$/ });
		await expect(name).toBeVisible({ timeout: 20_000 });
		await name.fill(seed.registered);
		await main.getByRole("button", { name: "Submit", exact: true }).click();
		await expect(main.getByText(seed.registered).first()).toBeVisible({
			timeout: 20_000,
		});
		await expect(main.getByText(seed.existing).first()).toBeVisible();
		await expect(main.locator("[data-case-list-register]")).toBeVisible();
	});
});
