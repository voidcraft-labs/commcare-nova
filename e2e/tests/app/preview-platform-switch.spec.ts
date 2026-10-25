import { expect, seedFor, test } from "../../lib/appFixtures";
import { FORM_SECTIONS_SEED } from "../../lib/formSectionsSeed";
import { openBuilder } from "../../lib/pageLoads";

/**
 * Preview plays one platform the app runs on at a time. The sections seed
 * runs on both, so Preview starts as Web Apps, which shows a sectioned form
 * on one screen as titled groups. Choosing Android under Runs on starts the
 * app again on the phone's home screen, where Start opens the module list
 * and the form pages one section at a time with Finish on the last; choosing
 * Web Apps again starts it again from the app's first screen.
 */
test("Preview runs a sectioned form as Web Apps, then as Android under Runs on", {
	tag: "@seed:sections",
}, async ({ scenario, page }) => {
	const seed = seedFor(scenario, "sections");
	test.setTimeout(120_000);
	const { aboutYou, yourVisit } = FORM_SECTIONS_SEED;
	const main = page.locator("main");
	const identity = page.getByRole("button", { name: /^Running as / });
	const stepper = page.getByRole("navigation", { name: "Sections" });

	await test.step("Preview starts as Web Apps, with the whole form on one screen", async () => {
		await openBuilder(page, seed.formSections.route);
		await page.getByRole("button", { name: "Preview", exact: true }).click();
		await expect(identity).toHaveAccessibleName(/ in Web Apps\. /, {
			timeout: 20_000,
		});
		await expect(
			main.getByRole("textbox", { name: aboutYou.nameLabel }),
		).toBeVisible({ timeout: 20_000 });
		await expect(
			main.getByRole("textbox", { name: yourVisit.noteLabel }),
		).toBeVisible();
		await expect(
			main.getByRole("heading", { name: aboutYou.title, level: 2 }),
		).toBeVisible();
		await expect(
			main.getByRole("heading", { name: yourVisit.title, level: 2 }),
		).toBeVisible();
		await expect(stepper).toHaveCount(0);
		await expect(
			main.getByRole("button", { name: "Next", exact: true }),
		).toHaveCount(0);
		await expect(
			main.getByRole("button", { name: "Submit", exact: true }),
		).toBeVisible();
	});

	await test.step("Runs on offers both platforms, the current one checked", async () => {
		await identity.click();
		const webApps = page.getByRole("menuitemradio", { name: /^Web Apps/ });
		const android = page.getByRole("menuitemradio", { name: /^Android/ });
		await expect(webApps).toHaveAttribute("aria-checked", "true");
		await expect(webApps).toContainText("The browser app on CommCare HQ");
		await expect(android).toContainText(
			"The CommCare app on a phone or tablet",
		);
		await expect(android).toBeEnabled();
		await android.click();
	});

	await test.step("Android starts on the phone's home screen, and the form pages by section", async () => {
		await expect(identity).toHaveAccessibleName(/ on Android\. /);
		const start = main.getByRole("button", { name: "Start", exact: true });
		await expect(start).toBeVisible({ timeout: 20_000 });
		await expect(
			main.getByRole("button", { name: "Sync with server", exact: true }),
		).toBeVisible();
		await expect(
			main.getByRole("button", { name: "Log out of CommCare", exact: true }),
		).toBeDisabled();
		await start.click();
		await main
			.getByRole("button", {
				name: new RegExp(`^${FORM_SECTIONS_SEED.moduleName}`),
			})
			.click();
		await main
			.getByRole("button", { name: FORM_SECTIONS_SEED.formName, exact: true })
			.click();
		await expect(stepper).toBeVisible({ timeout: 20_000 });
		await expect(stepper.getByRole("button")).toHaveCount(2);
		await expect(
			main.getByRole("textbox", { name: yourVisit.noteLabel }),
		).toHaveCount(0);
		await main.getByRole("textbox", { name: aboutYou.nameLabel }).fill("Ada");
		await main.getByRole("button", { name: "Next", exact: true }).click();
		await expect(
			main.getByRole("textbox", { name: yourVisit.noteLabel }),
		).toBeVisible();
		await expect(
			main.getByRole("button", { name: "Finish", exact: true }),
		).toBeVisible();
	});

	await test.step("Web Apps again starts the app from its first screen", async () => {
		await identity.click();
		await page.getByRole("menuitemradio", { name: /^Web Apps/ }).click();
		await expect(identity).toHaveAccessibleName(/ in Web Apps\. /);
		await expect(
			main.getByRole("button", {
				name: new RegExp(`^${FORM_SECTIONS_SEED.moduleName}`),
			}),
		).toBeVisible({ timeout: 20_000 });
		await expect(
			main.getByRole("button", { name: "Start", exact: true }),
		).toHaveCount(0);
	});
});
