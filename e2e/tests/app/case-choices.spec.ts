import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder } from "../../lib/pageLoads";

test("case choice sources stage atomically and Preview filters choices when an earlier answer changes", {
	tag: "@seed:case-choices",
}, async ({ scenario, page }) => {
	const { caseChoices } = seedFor(scenario, "case-choices");
	const main = page.locator("main");
	await openBuilder(page, caseChoices.routes.clinic);
	const source = page.getByRole("combobox", {
		name: "Where the choices come from",
	});
	await expect(source).toHaveText("Cases available to the worker", {
		timeout: 20_000,
	});
	await source.click();
	await page
		.getByRole("option", { name: "Options in this question", exact: true })
		.click();
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(source).toHaveText("Cases available to the worker");
	await source.click();
	await page
		.getByRole("option", { name: "Options in this question", exact: true })
		.click();
	await page
		.getByRole("button", { name: "Use these options", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Use these options", exact: true }),
	).toBeHidden();
	await source.click();
	await page
		.getByRole("option", { name: "Cases available to the worker", exact: true })
		.click();
	await expect(
		page.getByRole("combobox", { name: "Record type", exact: true }),
	).toHaveText("clinic");
	await page
		.getByRole("button", { name: "Use these cases", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Use these cases", exact: true }),
	).toBeHidden();
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	await expect(
		main.getByRole("radio", { name: "East clinic", exact: true }),
	).toBeVisible({ timeout: 20_000 });
	await main
		.locator("label")
		.filter({ hasText: /^East clinic$/ })
		.click();
	await expect(main.getByRole("checkbox")).toHaveCount(30);
	const alex = main.getByRole("checkbox", { name: "Alex", exact: true });
	await expect(alex).toHaveCount(2);
	await main
		.locator("label")
		.filter({ hasText: /^Alex$/ })
		.nth(0)
		.click();
	await main
		.locator("label")
		.filter({ hasText: /^Alex$/ })
		.nth(1)
		.click();
	await main
		.locator("label")
		.filter({ hasText: /^West clinic$/ })
		.click();
	await expect(main.getByRole("checkbox")).toHaveCount(1);
	await expect(
		main.getByRole("checkbox", { name: "West member", exact: true }),
	).not.toBeChecked();
});

test(
	"a 30-member attendance checklist shows its final selections on one screen and submits",
	{ tag: "@seed:case-choices" },
	async ({ scenario, page }, info) => {
		const { caseChoices } = seedFor(scenario, "case-choices");
		const main = page.locator("main");
		await openBuilder(page, caseChoices.routes.attendance);
		await expect(
			page.getByRole("button", { name: "Preview", exact: true }),
		).toBeVisible({ timeout: 20_000 });
		await page.getByRole("button", { name: "Preview", exact: true }).click();
		await main
			.getByRole("button", { name: /^View details for East clinic/ })
			.click();
		await main.getByRole("button", { name: "Continue", exact: true }).click();
		await expect(main.getByRole("checkbox")).toHaveCount(30);
		/* Preview runs as Web Apps, which shows the sectioned form on one
		 * screen: the second section's line is there beside the checklist, and
		 * no pager. */
		await expect(
			main.getByText("Your attendance is ready to save", { exact: true }),
		).toBeVisible();
		await expect(
			main.getByRole("button", { name: "Next", exact: true }),
		).toHaveCount(0);
		const alex = main.getByRole("checkbox", { name: "Alex", exact: true });
		await main
			.locator("label")
			.filter({ hasText: /^Alex$/ })
			.nth(0)
			.click();
		await main
			.locator("label")
			.filter({ hasText: /^Alex$/ })
			.nth(1)
			.click();
		await expect(alex.nth(0)).toBeChecked();
		await expect(alex.nth(1)).toBeChecked();
		await main
			.locator("label")
			.filter({ hasText: /^Alex$/ })
			.nth(0)
			.click();
		await main
			.locator("label")
			.filter({ hasText: /^Member 30$/ })
			.click();
		await expect(alex.nth(0)).not.toBeChecked();
		await expect(alex.nth(1)).toBeChecked();
		await expect(
			main.getByRole("checkbox", { name: "Member 30", exact: true }),
		).toBeChecked();
		await expect(main.getByRole("checkbox")).toHaveCount(30);
		await expect(main.getByRole("button", { name: /Add.*row/ })).toHaveCount(0);
		await expect(main.getByText("roster", { exact: true })).toHaveCount(0);
		await expect(main.getByText("30 instances", { exact: true })).toHaveCount(
			0,
		);
		await page.screenshot({
			path: info.outputPath("attendance-checklist.png"),
			fullPage: true,
		});
		await main.getByRole("button", { name: "Submit", exact: true }).click();
		await expect(
			main.getByRole("button", { name: "Attendance", exact: true }),
		).toBeVisible({ timeout: 20_000 });
	},
);
