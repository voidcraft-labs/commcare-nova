import { expect, seedFor, test } from "../../lib/appFixtures";
import { MENU_HELD_CASE_SEED } from "../../lib/menuHeldCaseSeed";
import { openBuilder } from "../../lib/pageLoads";

/**
 * A menu screen holding a case, and a submenu that goes on with it
 * (`e2e/lib/menuHeldCaseSeed.ts`). Web Apps' trail grows one crumb per
 * selection (`MenuSession`'s breadcrumbs), so a menu holding a patient reads
 * App / Patients / the patient; both platforms pin the tile of a list that
 * keeps it on screen above every screen holding its case
 * (`lib/preview/pinnedCaseTile.ts`); and a route back to a list from a
 * submenu's form reaches the list that chose its case
 * (`menuProjection.ts::previewCaseListReturn`).
 */
test("a menu holding a case names it, pins its tile, and a submenu's form returns to the list that chose it", {
	tag: "@seed:menu-held-case",
}, async ({ scenario, page }) => {
	const { menuHeldCase } = seedFor(scenario, "menu-held-case");
	const { patients, visits, pregnancies, refused, opens } = MENU_HELD_CASE_SEED;
	test.setTimeout(120_000);
	const main = page.locator("main");
	const trail = page.getByRole("navigation", { name: "Page navigation" });
	const results = main.locator("[data-case-results]");
	const tile = page.locator("[data-persistent-case-tile]:visible");
	const refusal = main.locator('[data-form-refusal="preload"]');
	const submit = main.getByRole("button", { name: "Submit", exact: true });
	const reviewForm = main.getByRole("button", {
		name: patients.formName,
		exact: true,
	});
	const visitsTile = main.getByRole("button", {
		name: visits.name,
		exact: true,
	});
	const dueForm = main.getByRole("button", {
		name: visits.formName,
		exact: true,
	});
	const crumb = (label: string) =>
		trail.getByRole("button", { name: label, exact: true });
	const choose = async (caseName: string) => {
		await expect(results).toBeVisible({ timeout: 20_000 });
		await main
			.getByRole("button", { name: new RegExp(`^Continue with ${caseName}`) })
			.click();
	};
	const expectPatientsMenu = async (caseName: string) => {
		await expect(reviewForm).toBeVisible({ timeout: 20_000 });
		await expect(visitsTile).toBeVisible();
		/* App / Patients / the patient: the patient is the screen's own
		 * crumb, the last one, which names where the worker is. */
		await expect(trail).toContainText(
			new RegExp(`${patients.name}.*${caseName}$`),
		);
		await expect(trail).not.toContainText(visits.name);
		await expect(tile).toHaveCount(1);
		await expect(tile).toContainText(caseName, { timeout: 20_000 });
	};
	const expectVisitsMenu = async (caseName: string) => {
		await expect(dueForm).toBeVisible({ timeout: 20_000 });
		await expect(
			main.getByRole("button", { name: visits.surveyName, exact: true }),
		).toBeVisible();
		await expect(trail).toContainText(
			new RegExp(`${patients.name}.*${caseName}.*${visits.name}`),
		);
		await expect(tile).toHaveCount(1);
		await expect(tile).toContainText(caseName, { timeout: 20_000 });
	};
	const expectPatientsList = async () => {
		await expect(results).toBeVisible({ timeout: 20_000 });
		await expect(reviewForm).toHaveCount(0);
		await expect(trail).toContainText(patients.name);
		await expect(trail).not.toContainText(visits.name);
		await expect(trail).not.toContainText(refused.caseName);
		await expect(trail).not.toContainText(opens.caseName);
		await expect(tile).toHaveCount(0);
	};

	await openBuilder(page, menuHeldCase.route);
	await expect(
		page.getByRole("button", { name: "Preview", exact: true }),
	).toBeVisible({ timeout: 20_000 });
	await page.getByRole("button", { name: "Preview", exact: true }).click();

	await test.step("choosing a patient lands on the menu holding them, named in the trail under its tile", async () => {
		await choose(refused.caseName);
		await expectPatientsMenu(refused.caseName);
	});

	await test.step("the submenu goes on with the patient, and its follow-up refuses the imported value", async () => {
		await visitsTile.click();
		await expectVisitsMenu(refused.caseName);
		await dueForm.click();
		await expect(refusal).toBeVisible({ timeout: 20_000 });
		await expect(submit).toHaveCount(0);
	});

	await test.step("Choose another record goes back to the list that chose the patient, Patients'", async () => {
		await refusal
			.getByRole("button", { name: "Choose another record", exact: true })
			.click();
		await expect(refusal).toHaveCount(0);
		await expectPatientsList();
	});

	await test.step("the other patient opens the submenu's form, under the tile of the list that chose them", async () => {
		await choose(opens.caseName);
		await expectPatientsMenu(opens.caseName);
		await visitsTile.click();
		await expectVisitsMenu(opens.caseName);
		await dueForm.click();
		await expect(submit).toBeVisible({ timeout: 20_000 });
		await expect(trail).toContainText(
			new RegExp(
				`${patients.name}.*${opens.caseName}.*${visits.name}.*${visits.formName}`,
			),
		);
		await expect(tile).toHaveCount(1);
		await expect(tile).toContainText(opens.caseName, { timeout: 20_000 });
	});

	await test.step("the patient's crumb reaches the menu holding them, and the menu's crumb asks for a patient again", async () => {
		await trail.getByRole("button", { name: "Go back", exact: true }).click();
		await expectVisitsMenu(opens.caseName);
		await crumb(opens.caseName).click();
		await expectPatientsMenu(opens.caseName);
		await crumb(patients.name).click();
		await expectPatientsList();
	});

	await test.step("after a form a list's own form menu opened, the patient's crumb on the submenu still reaches the menu holding the patient", async () => {
		/* Pregnancies chooses its pregnancy first and goes on into its own
		 * form menu, so the form chosen there leaves its target behind as the
		 * worker steps back to the Patients menu. A menu screen's case crumb
		 * reaches the menu screen whatever target the session holds. */
		const menuTitle = main.locator("[data-form-menu-case-title]");
		const pregnancyForm = main.getByRole("button", {
			name: pregnancies.formName,
			exact: true,
		});
		const goBack = trail.getByRole("button", { name: "Go back", exact: true });
		await choose(refused.caseName);
		await expectPatientsMenu(refused.caseName);
		await main
			.getByRole("button", { name: pregnancies.name, exact: true })
			.click();
		await choose(pregnancies.caseName);
		await expect(menuTitle).toHaveText(pregnancies.caseName, {
			timeout: 20_000,
		});
		await pregnancyForm.click();
		await expect(submit).toBeVisible({ timeout: 20_000 });
		await goBack.click();
		await expect(menuTitle).toHaveText(pregnancies.caseName, {
			timeout: 20_000,
		});
		await goBack.click();
		await expect(menuTitle).toHaveCount(0);
		await expect(results).toBeVisible({ timeout: 20_000 });
		await goBack.click();
		await expectPatientsMenu(refused.caseName);
		await visitsTile.click();
		await expectVisitsMenu(refused.caseName);
		await crumb(refused.caseName).click();
		await expectPatientsMenu(refused.caseName);
	});
});
