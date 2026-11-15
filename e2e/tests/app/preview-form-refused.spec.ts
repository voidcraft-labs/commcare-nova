import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder } from "../../lib/pageLoads";
import { FORM_REFUSED_SEED } from "../../lib/previewRuntimeSeeds";

/**
 * A record whose saved value CommCare's cast refuses: the follow-up form's
 * date question preloads `due_date`, and the imported record holds text that
 * is no date. CommCare will not open the form for it, so Preview shows the
 * refusal in place of the form, with both routes back to the list, and the
 * other record still opens the form.
 */
test("a form whose preload CommCare refuses names the record and routes back to the list", {
	tag: "@seed:form-refused",
}, async ({ scenario, page }) => {
	const { formRefused } = seedFor(scenario, "form-refused");
	const { refused, opens, propertyLabel } = FORM_REFUSED_SEED;
	test.setTimeout(90_000);
	const main = page.locator("main");
	const cases = main.getByRole("list", { name: "Cases", exact: true });
	const refusal = main.locator('[data-form-refusal="preload"]');
	const submit = main.getByRole("button", { name: "Submit", exact: true });
	const form = main.getByRole("button", {
		name: FORM_REFUSED_SEED.formName,
		exact: true,
	});
	/* Every choice of a record lists the menu's one form, as CommCare does,
	 * and the worker chooses it. The worker chose the form after the record,
	 * so the session holds the form above the record: each route back to the
	 * list goes past both (`CommCareSession.stepBack`), and the next choice
	 * lists the menu again rather than opening the form. */
	const openWith = async (caseName: string) => {
		await main
			.getByRole("button", {
				name: new RegExp(`^View details for ${caseName}`),
			})
			.click();
		await main.getByRole("button", { name: "Continue", exact: true }).click();
		await expect(form).toBeVisible({ timeout: 20_000 });
		await expect(submit).toHaveCount(0);
		await expect(refusal).toHaveCount(0);
		await form.click();
	};
	const expectRefusal = async () => {
		await expect(refusal).toBeVisible({ timeout: 20_000 });
		await expect(refusal).toHaveAttribute("role", "alert");
		await expect(
			refusal.getByRole("heading", {
				name: `This form can't open for ${refused.caseName}`,
				exact: true,
			}),
		).toBeVisible();
		await expect(refusal).toContainText(
			`${refused.caseName}'s ${propertyLabel} is “${refused.value}”, which isn't a date, so CommCare won't open this form for it. You can choose another record.`,
		);
		await expect(submit).toHaveCount(0);
	};

	await openBuilder(page, formRefused.route);
	await expect(
		page.getByRole("button", { name: "Preview", exact: true }),
	).toBeVisible({ timeout: 20_000 });
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	await expect(cases).toBeVisible({ timeout: 20_000 });

	await test.step("choosing the imported record shows the refusal, and Back to the list returns", async () => {
		await openWith(refused.caseName);
		await expectRefusal();
		await refusal
			.getByRole("button", { name: "Back to the list", exact: true })
			.click();
		await expect(refusal).toHaveCount(0);
		await expect(cases).toBeVisible({ timeout: 20_000 });
	});

	await test.step("Choose another record returns to the list, and the other record opens the form", async () => {
		await openWith(refused.caseName);
		await expectRefusal();
		await refusal
			.getByRole("button", { name: "Choose another record", exact: true })
			.click();
		await expect(refusal).toHaveCount(0);
		await expect(cases).toBeVisible({ timeout: 20_000 });
		await openWith(opens.caseName);
		await expect(submit).toBeVisible({ timeout: 20_000 });
		await expect(refusal).toHaveCount(0);
	});

	await test.step("Back from the form lands on the menu with the record held, again after a step forward", async () => {
		/* The form sits above the record in the session, so one step back
		 * pops only the form's command and stops on the menu
		 * (`CommCareSession.stepBack`, `shouldPopNext`), where the record is
		 * still chosen; a second pops the record. A step forward reopens the
		 * form, which holds the record beneath it again. */
		const trail = page.getByRole("navigation", { name: "Page navigation" });
		const menuTitle = main.locator("[data-form-menu-case-title]");
		const expectHeldMenu = async () => {
			await expect(submit).toHaveCount(0);
			await expect(menuTitle).toHaveText(opens.caseName, { timeout: 20_000 });
			await expect(form).toBeVisible();
			await expect(trail).toContainText(opens.caseName);
			await expect(trail).not.toContainText(FORM_REFUSED_SEED.formName);
		};
		const expectForm = async () => {
			await expect(submit).toBeVisible({ timeout: 20_000 });
			/* Web Apps' trail follows the session's steps: the menu, the
			 * record chosen there, then the form chosen after it. */
			await expect(trail).toContainText(
				new RegExp(
					`${FORM_REFUSED_SEED.moduleName}.*${opens.caseName}.*${FORM_REFUSED_SEED.formName}`,
				),
			);
		};
		await expectForm();
		await trail.getByRole("button", { name: "Go back", exact: true }).click();
		await expectHeldMenu();
		await page.goForward();
		await expectForm();
		await page.goBack();
		await expectHeldMenu();

		/* The menu's Back pops the record, past the detail the choice went
		 * through, and the list holds nothing. */
		await main
			.getByRole("button", { name: "Back to results", exact: true })
			.click();
		await expect(menuTitle).toHaveCount(0);
		await expect(cases).toBeVisible({ timeout: 20_000 });
		await expect(trail).not.toContainText(opens.caseName);
	});

	await test.step("the record's crumb reaches the menu holding it, and the menu's crumb asks for a record again", async () => {
		const trail = page.getByRole("navigation", { name: "Page navigation" });
		const menuTitle = main.locator("[data-form-menu-case-title]");
		await openWith(opens.caseName);
		await expect(submit).toBeVisible({ timeout: 20_000 });
		await trail
			.getByRole("button", { name: opens.caseName, exact: true })
			.click();
		await expect(submit).toHaveCount(0);
		await expect(menuTitle).toHaveText(opens.caseName, { timeout: 20_000 });
		await expect(form).toBeVisible();

		await form.click();
		await expect(submit).toBeVisible({ timeout: 20_000 });
		await trail
			.getByRole("button", { name: FORM_REFUSED_SEED.moduleName, exact: true })
			.click();
		await expect(submit).toHaveCount(0);
		await expect(menuTitle).toHaveCount(0);
		await expect(cases).toBeVisible({ timeout: 20_000 });
		await expect(trail).not.toContainText(opens.caseName);
	});
});
