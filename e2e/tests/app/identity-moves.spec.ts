import type { Request } from "@playwright/test";
import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder } from "../../lib/pageLoads";

/**
 * A follow-up form's own case change, which a publish recorded in Case
 * Management, moves to Save to Case only once the person has seen where its
 * answers go: the move waits in the identity-move dialog, Cancel leaves the
 * app as it was, Make the change saves once, and undo puts the value and the
 * recorded place back without asking.
 */
test("a change that moves published answers waits for the person, and its undo restores the recorded place", {
	tag: "@seed:identity-moves",
}, async ({ scenario, page }) => {
	const { identityMoves } = seedFor(scenario, "identity-moves");
	test.setTimeout(90_000);

	const appPath = `/api/apps/${identityMoves.appId}`;
	const puts: Request[] = [];
	page.on("request", (request) => {
		if (
			request.method() === "PUT" &&
			new URL(request.url()).pathname === appPath
		)
			puts.push(request);
	});
	const nextSave = () =>
		page.waitForResponse(
			(response) =>
				response.request().method() === "PUT" &&
				new URL(response.url()).pathname === appPath,
		);

	await openBuilder(page, identityMoves.route);
	const main = page.locator("main");
	const stopSaving = main.getByRole("button", { name: "Stop saving village" });
	await expect(stopSaving).toBeVisible({ timeout: 20_000 });
	// The innermost box holding the write's own controls is its row. A `has`
	// locator is queried inside each box, so it starts from the page.
	const write = main
		.locator("div")
		.filter({
			has: page.getByRole("button", { name: "Stop saving village" }),
		})
		.filter({ has: page.getByRole("button", { name: /^Value source:/ }) })
		.last();
	const combineText = write.getByText("Combine text", { exact: true });
	await expect(combineText).toHaveCount(0);

	const dialog = page.getByRole("dialog", {
		name: "This changes where CommCare HQ keeps some answers",
	});
	const turnIntoCalculation = async () => {
		await write.getByRole("button", { name: /^Value source:/ }).click();
		await page.getByRole("menuitem", { name: /^Combine text/ }).click();
		await expect(dialog).toBeVisible();
	};

	await turnIntoCalculation();
	await expect(dialog).toContainText(
		"Your published app keeps these answers in one place. After this change it keeps them in another, so from your next publish CommCare HQ's exports show them under new columns.",
	);
	await expect(dialog).toContainText("from Case Management to Save to Case");
	await expect(dialog).toContainText(
		"One of its values is now a calculation, which Case Management can't save.",
	);

	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect(combineText).toHaveCount(0);

	await turnIntoCalculation();
	const moveSaved = nextSave();
	await dialog
		.getByRole("button", { name: "Make the change", exact: true })
		.click();
	await expect(dialog).toBeHidden();
	expect((await moveSaved).ok()).toBe(true);
	await expect(combineText).toBeVisible();
	// The first save is the move itself: Cancel sent nothing before it.
	expect(puts).toHaveLength(1);
	const moveBody = puts[0]?.postData() ?? "";
	expect(moveBody).toContain('"kind":"holdPlacements"');
	expect(moveBody).toContain('"kind":"save-to-case"');

	const undoSaved = nextSave();
	await page.getByRole("button", { name: "Undo", exact: true }).click();
	const undoResponse = await undoSaved;
	expect(undoResponse.ok()).toBe(true);
	await expect(dialog).toBeHidden();
	await expect(combineText).toHaveCount(0);
	// The undo puts the hold back where the published app keeps it.
	expect(puts).toHaveLength(2);
	const undoBody = puts[1]?.postData() ?? "";
	expect(undoBody).toContain('"kind":"holdPlacements"');
	expect(undoBody).toContain('"slot":"own"');
	await expect(
		page.getByRole("status").filter({
			hasText: "These answers are back where your published app keeps them.",
		}),
	).toBeVisible();
});
