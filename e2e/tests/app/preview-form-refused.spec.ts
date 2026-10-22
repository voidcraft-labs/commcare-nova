import { expect, seedFor, test } from "../../lib/appFixtures";
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
	const openWith = async (caseName: string) => {
		await main
			.getByRole("button", {
				name: new RegExp(`^View details for ${caseName}`),
			})
			.click();
		await main.getByRole("button", { name: "Continue", exact: true }).click();
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

	await page.goto(formRefused.route);
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
});
