import { expect, seedFor, test } from "../../lib/appFixtures";

test("case choice sources stage atomically and Preview filters choices when an earlier answer changes", {
	tag: "@seed:case-choices",
}, async ({ scenario, page }) => {
	const { caseChoices } = seedFor(scenario, "case-choices");
	const main = page.locator("main");
	await page.goto(caseChoices.routes.clinic);
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
	await main.getByText("East clinic", { exact: true }).click();
	await expect(main.getByRole("checkbox")).toHaveCount(30);
	const alex = main.getByRole("checkbox", { name: "Alex", exact: true });
	await expect(alex).toHaveCount(2);
	await main.getByText("Alex", { exact: true }).nth(0).click();
	await main.getByText("Alex", { exact: true }).nth(1).click();
	await main.getByText("West clinic", { exact: true }).click();
	await expect(main.getByRole("checkbox")).toHaveCount(1);
	await expect(
		main.getByRole("checkbox", { name: "West member", exact: true }),
	).not.toBeChecked();
});

test(
	"a 30-member attendance checklist retains final selections across Back and submits",
	{ tag: "@seed:case-choices" },
	async ({ scenario, page }, info) => {
		const { caseChoices } = seedFor(scenario, "case-choices");
		const main = page.locator("main");
		await page.goto(caseChoices.routes.attendance);
		await expect(
			page.getByRole("button", { name: "Preview", exact: true }),
		).toBeVisible({ timeout: 20_000 });
		await page.getByRole("button", { name: "Preview", exact: true }).click();
		await main
			.getByRole("button", { name: /^View details for East clinic/ })
			.click();
		await main.getByRole("button", { name: "Continue", exact: true }).click();
		await expect(main.getByRole("checkbox")).toHaveCount(30);
		const alex = main.getByRole("checkbox", { name: "Alex", exact: true });
		await main.getByText("Alex", { exact: true }).nth(0).click();
		await main.getByText("Alex", { exact: true }).nth(1).click();
		await main.getByRole("button", { name: "Next", exact: true }).click();
		await expect(
			main.getByText("Your attendance is ready to save", { exact: true }),
		).toBeVisible();
		await main.getByRole("button", { name: "Back", exact: true }).click();
		await expect(alex.nth(0)).toBeChecked();
		await main.getByText("Alex", { exact: true }).nth(0).click();
		await main.getByText("Member 30", { exact: true }).click();
		await expect(main.getByRole("checkbox")).toHaveCount(30);
		await expect(main.getByRole("button", { name: /Add.*row/ })).toHaveCount(0);
		await page.screenshot({
			path: info.outputPath("attendance-checklist.png"),
			fullPage: true,
		});
		await main.getByRole("button", { name: "Next", exact: true }).click();
		await main.getByRole("button", { name: "Submit", exact: true }).click();
		await expect(
			main.getByRole("button", { name: /^View details for East clinic/ }),
		).toBeVisible({ timeout: 20_000 });
	},
);
