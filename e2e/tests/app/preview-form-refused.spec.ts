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

	/* The form sits above the record in the session, so one step back pops
	 * only the form's command and stops on the menu (`CommCareSession.stepBack`,
	 * `shouldPopNext`), where the record is still chosen; a second pops the
	 * record. A step forward reopens the form, which holds the record beneath
	 * it again. */
	const trail = page.getByRole("navigation", { name: "Page navigation" });
	const goBack = trail.getByRole("button", { name: "Go back", exact: true });
	const menuTitle = main.locator("[data-form-menu-case-title]");
	const menuBack = main.getByRole("button", {
		name: "Back to results",
		exact: true,
	});
	const expectHeldMenu = async () => {
		await expect(submit).toHaveCount(0);
		await expect(menuTitle).toHaveText(opens.caseName, { timeout: 20_000 });
		await expect(form).toBeVisible();
		await expect(trail).toContainText(opens.caseName);
		await expect(trail).not.toContainText(FORM_REFUSED_SEED.formName);
	};
	const expectForm = async () => {
		await expect(submit).toBeVisible({ timeout: 20_000 });
		/* Web Apps' trail follows the session's steps: the menu, the record
		 * chosen there, then the form chosen after it. */
		await expect(trail).toContainText(
			new RegExp(
				`${FORM_REFUSED_SEED.moduleName}.*${opens.caseName}.*${FORM_REFUSED_SEED.formName}`,
			),
		);
	};
	/* The menu's Back pops the record, and the list holds nothing. */
	const expectList = async () => {
		await expect(menuTitle).toHaveCount(0);
		await expect(submit).toHaveCount(0);
		await expect(cases).toBeVisible({ timeout: 20_000 });
		await expect(trail).not.toContainText(opens.caseName);
	};

	await test.step("Back from the form lands on the menu with the record held, again after a step forward", async () => {
		await expectForm();
		await goBack.click();
		await expectHeldMenu();
		await page.goForward();
		await expectForm();
		await page.goBack();
		await expectHeldMenu();

		/* The menu's step replaced the detail the choice went through, which
		 * is no step of the session, so its Back reaches the list. */
		await menuBack.click();
		await expectList();

		/* Each step has its own place in history, so Forward walks them again
		 * and the strip's Go back walks them back as a device's Back does: the
		 * menu with the record held, then the list. */
		await page.goForward();
		await expectHeldMenu();
		await page.goForward();
		await expectForm();
		await goBack.click();
		await expectHeldMenu();
		await goBack.click();
		await expectList();
		await page.goForward();
		await expectHeldMenu();
		await page.goBack();
		await expectList();
	});

	await test.step("the record's crumb steps back onto the menu holding it, whose Back lets the record go", async () => {
		/* The form was opened from the menu, so the record's crumb reaches the
		 * menu as a device's Back off the form does, and the menu's own Back
		 * then reaches the list, never the form. */
		await openWith(opens.caseName);
		await expectForm();
		await trail
			.getByRole("button", { name: opens.caseName, exact: true })
			.click();
		await expectHeldMenu();
		await menuBack.click();
		await expectList();
		await page.goForward();
		await expectHeldMenu();
		await page.goForward();
		await expectForm();
	});

	await test.step("the menu's crumb asks for a record again", async () => {
		await trail
			.getByRole("button", { name: opens.caseName, exact: true })
			.click();
		await expectHeldMenu();
		await form.click();
		await expectForm();
		await trail
			.getByRole("button", { name: FORM_REFUSED_SEED.moduleName, exact: true })
			.click();
		await expect(submit).toHaveCount(0);
		await expect(menuTitle).toHaveCount(0);
		await expect(cases).toBeVisible({ timeout: 20_000 });
		await expect(trail).not.toContainText(opens.caseName);
	});

	await test.step("a menu another session held holds nothing: after Runs on changes, Back shows the list", async () => {
		/* A case the previous worker or platform chose has no standing in the
		 * next one's session, so stepping back onto the menu's entry after the
		 * platform changes shows the list with nothing chosen. */
		const identity = page.getByRole("button", { name: /^Running as / });
		await openWith(opens.caseName);
		await expectForm();
		await identity.click();
		await page.getByRole("menuitemradio", { name: /^Android/ }).click();
		await expect(identity).toHaveAccessibleName(/ on Android\. /);
		await identity.click();
		await page.getByRole("menuitemradio", { name: /^Web Apps/ }).click();
		await expect(identity).toHaveAccessibleName(/ in Web Apps\. /);
		await expect(submit).toHaveCount(0);
		await page.goBack();
		await expectList();
		await expect(form).toHaveCount(0);

		/* That entry shows the list in the session running now, so a record
		 * chosen there holds its menu one step after it: the menu's Back steps
		 * back to it, and Forward returns to the menu
		 * (`previewHeldMenu.ts::builderEntryState`). */
		await main
			.getByRole("button", {
				name: new RegExp(`^View details for ${opens.caseName}`),
			})
			.click();
		await main.getByRole("button", { name: "Continue", exact: true }).click();
		await expectHeldMenu();
		await menuBack.click();
		await expectList();
		await page.goForward();
		await expectHeldMenu();
	});
});

test("a menu held on a linked case's details shows the list in place when nothing is behind it", {
	tag: "@seed:form-refused",
}, async ({ scenario, page }) => {
	/* A case's details opened by link, in a tab with no list before them:
	 * Continue holds the menu in their place, and the menu's Back shows the
	 * list in that same entry, since there is no list entry to step back to. */
	const { formRefused } = seedFor(scenario, "form-refused");
	const { opens } = FORM_REFUSED_SEED;
	test.setTimeout(90_000);
	const main = page.locator("main");
	const cases = main.getByRole("list", { name: "Cases", exact: true });
	const menuTitle = main.locator("[data-form-menu-case-title]");
	const form = main.getByRole("button", {
		name: FORM_REFUSED_SEED.formName,
		exact: true,
	});
	const submit = main.getByRole("button", { name: "Submit", exact: true });
	const menuBack = main.getByRole("button", {
		name: "Back to results",
		exact: true,
	});
	const trail = page.getByRole("navigation", { name: "Page navigation" });
	await openBuilder(
		page,
		`${formRefused.route}/cases/${encodeURIComponent(formRefused.opensCaseId)}`,
	);
	/* A case record's link opens the running app on its details. */
	await expect(
		page.getByRole("button", { name: "Back to edit", exact: true }),
	).toBeVisible({ timeout: 20_000 });
	await main
		.getByRole("button", { name: "Continue", exact: true })
		.click({ timeout: 20_000 });
	await expect(menuTitle).toHaveText(opens.caseName, { timeout: 20_000 });
	/* A form opened from the menu, and Back onto the menu again. */
	await form.click();
	await expect(submit).toBeVisible({ timeout: 20_000 });
	await page.goBack();
	await expect(menuTitle).toHaveText(opens.caseName, { timeout: 20_000 });
	const entries = await page.evaluate(() => window.history.length);
	await menuBack.click();
	await expect(menuTitle).toHaveCount(0);
	await expect(cases).toBeVisible({ timeout: 20_000 });
	await expect(page).toHaveURL(/\/results$/);
	expect(await page.evaluate(() => window.history.length)).toBe(entries);

	/* Forward returns to the form, whose entry still names the menu as the
	 * one before it. That entry now shows the list, so the record's crumb
	 * holds the menu again on an entry of its own
	 * (`previewHeldMenu.ts::previewHeldMenuStands`), one step after that
	 * list, whose Back reaches the list. */
	await page.goForward();
	await expect(submit).toBeVisible({ timeout: 20_000 });
	await trail
		.getByRole("button", { name: opens.caseName, exact: true })
		.click();
	await expect(menuTitle).toHaveText(opens.caseName, { timeout: 20_000 });
	await expect(submit).toHaveCount(0);
	await menuBack.click();
	await expect(menuTitle).toHaveCount(0);
	await expect(cases).toBeVisible({ timeout: 20_000 });
});
