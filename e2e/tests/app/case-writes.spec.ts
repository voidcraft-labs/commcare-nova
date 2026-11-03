import type { Page } from "@playwright/test";
import { expect, seedFor, test } from "../../lib/appFixtures";
import { CASE_CHANGES_SEED } from "../../lib/caseChangesSeed";
import { openBuilder } from "../../lib/pageLoads";

/**
 * Where a question's answer is saved, authored from both of its screens:
 * the case changes list keeps this form's own case first and unmovable, a
 * follow-up's question can save to the case above the one it opened, and
 * a registration's question can't save only changed answers, since its new
 * case has nothing earlier to compare with.
 */

/** The next save of the app whose body carries `needle`. */
function savedWith(page: Page, appId: string, needle: string) {
	return page.waitForResponse((response) => {
		const request = response.request();
		return (
			request.method() === "PUT" &&
			new URL(response.url()).pathname === `/api/apps/${appId}` &&
			(request.postData() ?? "").includes(needle)
		);
	});
}

test("this form's case is the first change and has no handle", {
	tag: "@seed:case-changes",
}, async ({ scenario, page }) => {
	const { caseChanges } = seedFor(scenario, "case-changes");
	await openBuilder(page, caseChanges.route);

	const rows = page
		.getByRole("list", { name: "Case changes in the order they happen" })
		.getByRole("listitem");
	await expect(rows.first()).toContainText("Update this form's", {
		timeout: 20_000,
	});
	await expect(
		rows.first().locator(`[data-case-operation-row]`),
	).toHaveAttribute(
		"data-case-operation-row",
		CASE_CHANGES_SEED.operations.own,
	);
	// Every other change carries its handle, so the absence on the first row
	// is the own case's, not a list rendered without handles.
	await expect(
		rows.nth(1).getByRole("button", {
			name: new RegExp(`^Move ${CASE_CHANGES_SEED.ids.create}\\. Runs 2 of`),
		}),
	).toBeVisible();
	await expect(
		rows.first().getByRole("button", { name: /^Move / }),
	).toHaveCount(0);
});

test("a follow-up's question saves to the case above it", {
	tag: "@seed:case-changes",
}, async ({ scenario, page }) => {
	const { caseChanges } = seedFor(scenario, "case-changes");
	await openBuilder(page, caseChanges.followupWriteRoute);

	const inspector = page.locator("[data-inspector-rail]");
	const chooser = inspector.getByRole("combobox", {
		name: "Saves to: This form's case · Source note, #archived_referral/source_note",
		exact: true,
	});
	await expect(chooser).toBeVisible({ timeout: 20_000 });
	await chooser.click();

	await expect(page.getByText("Cases above it", { exact: true })).toBeVisible();
	const lastNote = page
		.locator('[data-case-write-ancestor="patient (parent)"]')
		.filter({ hasText: "#patient/last_note" });
	await expect(lastNote).toHaveCount(1);
	await expect(lastNote).toContainText("patient (parent) · Last note");

	const saved = savedWith(page, caseChanges.appId, '"via"');
	await lastNote.click();
	const response = await saved;
	expect(response.ok()).toBe(true);
	const body = response.request().postData() ?? "";
	expect(body).toContain('"identifier":"parent"');

	await expect(
		inspector.getByRole("combobox", {
			name: "Saves to: Patient it belongs to · Last note, #patient/last_note",
			exact: true,
		}),
	).toBeVisible();
});

test("a registration's question can't save only changed answers", {
	tag: "@seed:case-changes",
}, async ({ scenario, page }) => {
	const { caseChanges } = seedFor(scenario, "case-changes");
	await openBuilder(page, caseChanges.registrationWriteRoute);

	const inspector = page.locator("[data-inspector-rail]");
	await expect(
		inspector.getByRole("combobox", {
			name: "Saves to: The new archived referral · Source note, #archived_referral/source_note",
			exact: true,
		}),
	).toBeVisible({ timeout: 20_000 });

	const onlyIfChanged = inspector.locator('[data-only-if-changed="off"]');
	await expect(
		onlyIfChanged.getByRole("switch", { name: "Save only if changed" }),
	).toBeDisabled();
	await expect(onlyIfChanged).toContainText(
		"A new case has no earlier value to compare with.",
	);
});
