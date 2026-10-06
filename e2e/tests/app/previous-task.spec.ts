import { expect, seedFor, test } from "../../lib/appFixtures";
import { PREVIOUS_TASK_SEED } from "../../lib/previousTaskSeed";

test("Previous resumes the source task and retains its saved record world", {
	tag: "@seed:previous-task",
}, async ({ scenario, page }) => {
	const { previousTask } = seedFor(scenario, "previous-task");
	const { formsFirst, caseFirst } = PREVIOUS_TASK_SEED;
	const main = page.locator("main");
	test.setTimeout(90_000);
	await page.goto(previousTask.routes.formsFirst);
	await expect(
		main.getByRole("button", { name: formsFirst.formName, exact: true }),
	).toBeVisible({ timeout: 20_000 });
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	await main
		.getByRole("button", { name: formsFirst.formName, exact: true })
		.click();
	await main
		.getByRole("button", {
			name: new RegExp(`^View details for ${formsFirst.caseName}`),
		})
		.click();
	await main.getByRole("button", { name: "Continue", exact: true }).click();
	const repairState = main.getByRole("textbox", {
		name: formsFirst.fieldLabel,
	});
	await expect(repairState).toHaveValue("Before submission");
	await repairState.fill("Saved repair");
	await main.getByRole("button", { name: "Submit", exact: true }).click();
	// The conditional link is false after this save. Previous drops the source
	// selection and resumes the same form's selector, independent of Details.
	const repairedRow = main.getByRole("button", {
		name: new RegExp(`^View details for ${formsFirst.caseName}, Saved repair`),
	});
	await expect(repairedRow).toBeVisible({ timeout: 20_000 });
	await expect(
		main.getByRole("button", { name: "Continue", exact: true }),
	).toHaveCount(0);
	await repairedRow.click();
	await main.getByRole("button", { name: "Continue", exact: true }).click();
	await expect(repairState).toHaveValue("Saved repair");
	await expect(
		main.getByRole("button", { name: "Submit", exact: true }),
	).toBeEnabled();

	await page.goto(previousTask.routes.caseFirst);
	await expect(
		page.getByRole("button", { name: "Preview", exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	await main
		.getByRole("button", {
			name: new RegExp(`^View details for ${caseFirst.caseName}`),
		})
		.click();
	await main.getByRole("button", { name: "Continue", exact: true }).click();
	await main
		.getByRole("button", { name: caseFirst.closeFormName, exact: true })
		.click();
	const ticketState = main.getByRole("textbox", { name: caseFirst.fieldLabel });
	await expect(ticketState).toHaveValue("Before submission");
	await ticketState.fill("Closed with note");
	await main.getByRole("button", { name: "Submit", exact: true }).click();
	await expect(
		main.getByRole("button", { name: caseFirst.inspectFormName, exact: true }),
	).toBeVisible({ timeout: 20_000 });
	await expect(
		main.getByRole("button", { name: "Continue", exact: true }),
	).toHaveCount(0);
	await main
		.getByRole("button", { name: caseFirst.inspectFormName, exact: true })
		.click();
	await expect(ticketState).toHaveValue("Closed with note");
	await expect(
		main.getByRole("button", { name: "Submit", exact: true }),
	).toBeEnabled();
	await expect(
		page.getByRole("navigation", { name: "Page navigation" }),
	).toContainText(caseFirst.caseName);
	await page
		.getByRole("navigation", { name: "Page navigation" })
		.getByRole("button", { name: "Go back", exact: true })
		.click();
	await main
		.getByRole("button", { name: caseFirst.inspectFormName, exact: true })
		.click();
	await expect(ticketState).toHaveValue("Closed with note");
	await expect(
		main.getByRole("button", { name: "Submit", exact: true }),
	).toBeEnabled();
	await ticketState.fill("Inspection saved");
	await main.getByRole("button", { name: "Submit", exact: true }).click();
	// The next form's explicit module return retires the leaf selection and
	// the prior receipt. Fresh Results no longer offer the closed ticket.
	await expect(main.locator("[data-case-list-empty-notice]")).toBeVisible();
	await expect(
		main.getByRole("button", { name: caseFirst.inspectFormName, exact: true }),
	).toHaveCount(0);
	await expect(
		main.getByRole("button", {
			name: new RegExp(`^View details for ${caseFirst.caseName}`),
		}),
	).toHaveCount(0);
});
