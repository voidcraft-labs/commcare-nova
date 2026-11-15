import { expect, seedFor, test } from "../../lib/appFixtures";
import {
	MENU_HELD_CASE_SEED,
	menuHeldCaseClinicRoute,
} from "../../lib/menuHeldCaseSeed";
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

	await test.step("a pregnancy chosen under a patient another menu's list chose names that patient after its menu, and the patient's crumb reaches the patient's pregnancies", async () => {
		/* Pregnancy visits asks Patients' list, off its trail, for the
		 * patient: Web Apps' trail grows one crumb per selection, the
		 * patient's after the menu whose command asked for it. */
		const { pregnancyVisits } = MENU_HELD_CASE_SEED;
		const pregnancyCheck = main.getByRole("button", {
			name: pregnancyVisits.formName,
			exact: true,
		});
		await crumb("Home").click();
		await main
			.getByRole("button", { name: new RegExp(`^${pregnancyVisits.name}`) })
			.click({ timeout: 20_000 });
		await choose(refused.caseName);
		await choose(pregnancies.caseName);
		await pregnancyCheck.click({ timeout: 20_000 });
		await expect(submit).toBeVisible({ timeout: 20_000 });
		await expect(trail).toContainText(
			new RegExp(
				`${pregnancyVisits.name}.*${refused.caseName}.*${pregnancies.caseName}.*${pregnancyVisits.formName}`,
			),
		);
		await expect(trail).not.toContainText(patients.name);
		// The pregnancy's crumb keeps the patient chosen before it: it steps
		// back onto the pregnancy's form menu, the patient still held.
		await crumb(pregnancies.caseName).click();
		await expect(main.locator("[data-form-menu-case-title]")).toHaveText(
			pregnancies.caseName,
			{ timeout: 20_000 },
		);
		await expect(trail).toContainText(
			new RegExp(
				`${pregnancyVisits.name}.*${refused.caseName}.*${pregnancies.caseName}$`,
			),
		);
		await pregnancyCheck.click();
		await expect(submit).toBeVisible({ timeout: 20_000 });
		// The patient's crumb cuts the session back to the screen after the
		// patient: Pregnancy visits' list of that patient's pregnancies.
		await crumb(refused.caseName).click();
		await expect(results).toBeVisible({ timeout: 20_000 });
		await expect(
			main.getByRole("button", {
				name: new RegExp(`^Continue with ${pregnancies.caseName}`),
			}),
		).toBeVisible();
		await expect(trail).toContainText(
			new RegExp(`${pregnancyVisits.name}.*${refused.caseName}$`),
		);
		await expect(trail).not.toContainText(pregnancies.caseName);
	});

	await test.step("the crumb of a form chosen before its cases lets go the patient asked for after it, and the list asks again holding the form", async () => {
		/* Pregnancy follow-ups lists its forms before its pregnancy, so Web
		 * Apps asks Patients' list for the patient after the form's command:
		 * the form's crumb cuts the patient away with the pregnancy. */
		const { pregnancyFollowUps } = MENU_HELD_CASE_SEED;
		await crumb("Home").click();
		await main
			.getByRole("button", {
				name: new RegExp(`^${pregnancyFollowUps.name}`),
			})
			.click({ timeout: 20_000 });
		await choose(refused.caseName);
		await main
			.getByRole("button", { name: pregnancyFollowUps.formName, exact: true })
			.click({ timeout: 20_000 });
		await choose(pregnancies.caseName);
		await expect(submit).toBeVisible({ timeout: 20_000 });
		await expect(trail).toContainText(
			new RegExp(
				`${pregnancyFollowUps.name}.*${pregnancyFollowUps.formName}.*${refused.caseName}.*${pregnancies.caseName}$`,
			),
		);
		await crumb(pregnancyFollowUps.formName).click();
		// Patients' list asks for the patient again.
		await expect(
			main.getByRole("button", {
				name: new RegExp(`^Continue with ${opens.caseName}`),
			}),
		).toBeVisible({ timeout: 20_000 });
		await expect(trail).not.toContainText(refused.caseName);
		await choose(refused.caseName);
		// Her pregnancies, on a list that still holds the form (its crumb
		// before hers), which opens once the pregnancy is chosen.
		await expect(trail).toContainText(new RegExp(`${refused.caseName}$`), {
			timeout: 20_000,
		});
		await expect(crumb(pregnancyFollowUps.formName)).toBeVisible();
		await choose(pregnancies.caseName);
		await expect(submit).toBeVisible({ timeout: 20_000 });
		await expect(trail).toContainText(
			new RegExp(
				`${pregnancyFollowUps.formName}.*${refused.caseName}.*${pregnancies.caseName}$`,
			),
		);
	});
});

/**
 * A case's details, where the session holds no case yet. Android's details
 * screen draws the case it shows as its tile where the list keeps its tile on
 * screen and is choosing its own case (`BreadcrumbBarHelper.loadTile` falling
 * back to `EntityDetailActivity.requestEntityContext`), and none for a search
 * action's result, whose datum names no persistent detail; Formplayer's
 * details answer carries none, so Web Apps' details show no tile
 * (`lib/preview/pinnedCaseTile.ts`).
 */
test("Android's case details draw the case they show as its tile, except a search's result, and Web Apps' draw none", {
	tag: "@seed:menu-held-case",
}, async ({ scenario, page }) => {
	const { menuHeldCase } = seedFor(scenario, "menu-held-case");
	const { clinic, opens } = MENU_HELD_CASE_SEED;
	test.setTimeout(120_000);
	const main = page.locator("main");
	const results = main.locator("[data-case-results]");
	const tile = page.locator("[data-persistent-case-tile]:visible");
	const viewDetails = main.getByRole("button", {
		name: new RegExp(`^View details for ${opens.caseName}`),
	});
	const continueOnDetails = main.getByRole("button", {
		name: "Continue",
		exact: true,
	});
	const identity = page.getByRole("button", { name: /^Running as / });

	await openBuilder(page, menuHeldCaseClinicRoute(menuHeldCase.appId));
	await page.getByRole("button", { name: "Preview", exact: true }).click();

	await test.step("Web Apps' details show no tile", async () => {
		await expect(identity).toHaveAccessibleName(/ in Web Apps\. /, {
			timeout: 20_000,
		});
		await expect(results).toBeVisible({ timeout: 20_000 });
		await viewDetails.click();
		await expect(continueOnDetails).toBeVisible({ timeout: 20_000 });
		await expect(tile).toHaveCount(0);
	});

	await test.step("Android's details draw the patient they show above them", async () => {
		await identity.click();
		await page.getByRole("menuitemradio", { name: /^Android/ }).click();
		await expect(identity).toHaveAccessibleName(/ on Android\. /);
		await main
			.getByRole("button", { name: "Start", exact: true })
			.click({ timeout: 20_000 });
		await main
			.getByRole("button", { name: new RegExp(`^${clinic.name}`) })
			.click();
		await expect(results).toBeVisible({ timeout: 20_000 });
		await expect(tile).toHaveCount(0);
		await viewDetails.click();
		await expect(continueOnDetails).toBeVisible({ timeout: 20_000 });
		await expect(tile).toHaveCount(1);
		await expect(tile).toContainText(opens.caseName, { timeout: 20_000 });
	});

	await test.step("the patient, once chosen, keeps the tile on the form", async () => {
		await continueOnDetails.click();
		await main
			.getByRole("button", { name: clinic.formName, exact: true })
			.click({ timeout: 20_000 });
		await expect(
			main.getByRole("button", { name: "Finish", exact: true }),
		).toBeVisible({ timeout: 20_000 });
		await expect(tile).toHaveCount(1);
		await expect(tile).toContainText(opens.caseName, { timeout: 20_000 });
	});

	await test.step("Android's details of a search's result draw no tile, and the patient chosen there pins it", async () => {
		/* The search's results are chosen for its own datum, which names no
		 * persistent detail (`searchSession.ts::buildSearchSession`), so
		 * Android's details hold no case to draw. */
		const { clinicSearch } = MENU_HELD_CASE_SEED;
		const searchScreen = main.getByRole("search", { name: "Search" });
		await page
			.getByRole("navigation", { name: "Page navigation" })
			.getByRole("button", { name: "Home", exact: true })
			.click();
		await main
			.getByRole("button", { name: new RegExp(`^${clinicSearch.name}`) })
			.click({ timeout: 20_000 });
		// Android opens the list first, with Search from it.
		await expect(results).toBeVisible({ timeout: 20_000 });
		await main
			.getByRole("button", { name: "Search All Cases", exact: true })
			.click();
		await expect(searchScreen).toBeVisible({ timeout: 20_000 });
		await searchScreen
			.getByRole("button", { name: "Search All Cases", exact: true })
			.click();
		await expect(results).toBeVisible({ timeout: 20_000 });
		await viewDetails.click();
		await expect(continueOnDetails).toBeVisible({ timeout: 20_000 });
		await expect(main.getByText(opens.caseName).first()).toBeVisible();
		await expect(tile).toHaveCount(0);
		await continueOnDetails.click();
		await expect(
			main.getByRole("button", { name: clinicSearch.formName, exact: true }),
		).toBeVisible({ timeout: 20_000 });
		await expect(tile).toHaveCount(1);
		await expect(tile).toContainText(opens.caseName, { timeout: 20_000 });
	});
});
