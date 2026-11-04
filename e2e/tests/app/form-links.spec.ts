import { expect, seedFor, test } from "../../lib/appFixtures";
import { FORM_LINKS_SEED } from "../../lib/formLinksSeed";
import { openBuilder } from "../../lib/pageLoads";

/**
 * Every destination whose condition holds runs, in the author's order. The
 * journey gives "Visit" two: "Follow-up" every time, then "Start this form
 * again" when the note the form saves reads "Visited". The list shows both in
 * that order, the Otherwise row appears only once a destination has a
 * condition, and Preview running as Android opens "Follow-up" first and
 * "Visit" again once "Follow-up" is finished, since a phone runs each
 * destination after the one before it.
 */
test("two destinations are authored in order and run one after the other on Android", {
	tag: "@seed:form-links",
}, async ({ scenario, page }) => {
	const { formLinks: fixture } = seedFor(scenario, "form-links");
	test.setTimeout(120_000);
	const { visit, followUp } = FORM_LINKS_SEED;
	const condition = `#${FORM_LINKS_SEED.caseType}/${FORM_LINKS_SEED.property} = '${FORM_LINKS_SEED.linkingNote}'`;
	const main = page.locator("main");
	const otherwise = page.locator("[data-form-link-otherwise]");
	const addDestination = page.getByRole("button", {
		name: "Add a destination",
	});
	const rows = page
		.getByRole("list", { name: "After this form, these run in order" })
		.getByRole("listitem");

	await test.step("the first destination runs every time and replaces the form's own after-submit", async () => {
		await openBuilder(page, fixture.route);
		await expect(
			page.getByRole("heading", { name: "After submit", level: 1 }),
		).toBeVisible({ timeout: 20_000 });
		await expect(otherwise).toContainText(
			"After submit, the form goes to the app home",
		);
		await addDestination.click();
		await page
			.getByRole("button", { name: /^Go somewhere every time/ })
			.click();
		// The target picker offers this form itself, first.
		await expect(
			page.getByRole("button", { name: /^Start this form again/ }),
		).toBeEnabled();
		/* The next step loads the page again, which aborts a save still in
		 * flight: wait for the server to accept this destination's write
		 * first (a retried attempt counts once it succeeds). */
		const destinationSaved = page.waitForResponse((response) => {
			const request = response.request();
			return (
				request.method() === "PUT" &&
				response.ok() &&
				new URL(response.url()).pathname === `/api/apps/${fixture.appId}` &&
				(request.postData() ?? "").includes(followUp.formUuid)
			);
		});
		await page
			.getByRole("button", { name: `Go to “${followUp.formName}”` })
			.click();
		await destinationSaved;
		await expect(page).toHaveURL(
			new RegExp(`/${visit.formUuid}/links/[0-9a-f-]{36}$`),
		);
		await expect(
			page.getByRole("heading", {
				name: `Go to “${followUp.formName}”`,
				level: 1,
			}),
		).toBeVisible();
	});

	await test.step("a destination that runs every time leaves nothing for an Otherwise", async () => {
		await openBuilder(page, fixture.route);
		await expect(rows).toHaveCount(1);
		await expect(rows.first()).toContainText(`Go to “${followUp.formName}”`);
		await expect(rows.first()).toContainText("Every time");
		await expect(otherwise).toHaveCount(0);
	});

	await test.step("a second destination with a condition starts this form again", async () => {
		await addDestination.click();
		await page
			.getByRole("button", { name: /^Go somewhere when a condition is true/ })
			.click();
		await page.getByRole("button", { name: /^Start this form again/ }).click();
		await expect(
			page.getByRole("heading", { name: "Start this form again", level: 1 }),
		).toBeVisible();
		/* The condition editor is CodeMirror, opened on the seeded condition:
		 * replace its text, save with Cmd/Ctrl+Enter, and wait for this exact
		 * write's server receipt before the next page load reads it. */
		const conditionEditor = main.locator('.cm-content[contenteditable="true"]');
		await expect(conditionEditor).toBeVisible();
		const conditionSaved = page.waitForResponse((response) => {
			const request = response.request();
			return (
				request.method() === "PUT" &&
				new URL(response.url()).pathname === `/api/apps/${fixture.appId}` &&
				(request.postData() ?? "").includes(FORM_LINKS_SEED.linkingNote)
			);
		});
		await conditionEditor.click();
		await page.keyboard.press("ControlOrMeta+a");
		await page.keyboard.press("Backspace");
		await expect(conditionEditor).toHaveText("");
		await page.keyboard.type(condition);
		await page.keyboard.press("ControlOrMeta+Enter");
		expect((await conditionSaved).ok()).toBe(true);
		await expect(conditionEditor).toHaveCount(0);
	});

	await test.step("the list shows both destinations in order, then the Otherwise", async () => {
		await openBuilder(page, fixture.route);
		// Two destinations, then the Otherwise row, the list's last item.
		await expect(rows).toHaveCount(3);
		await expect(rows.nth(0)).toContainText(`Go to “${followUp.formName}”`);
		await expect(rows.nth(0)).toContainText("Every time");
		await expect(rows.nth(1)).toContainText("Start this form again");
		await expect(rows.nth(1)).toContainText("When ");
		await expect(rows.nth(1)).toContainText("last_note = 'Visited'");
		await expect(otherwise).toContainText("Otherwise, back to the app home");
	});

	await test.step("Preview as Android opens Follow-up, then this form again", async () => {
		await page.getByRole("button", { name: "Preview", exact: true }).click();
		const identity = page.getByRole("button", { name: /^Running as / });
		await expect(identity).toHaveAccessibleName(/ in Web Apps\. /, {
			timeout: 20_000,
		});
		await identity.click();
		await page.getByRole("menuitemradio", { name: /^Android/ }).click();
		await expect(identity).toHaveAccessibleName(/ on Android\. /);
		await main
			.getByRole("button", { name: "Start", exact: true })
			.click({ timeout: 20_000 });
		await main
			.getByRole("button", {
				name: new RegExp(`^${FORM_LINKS_SEED.moduleName}\\b`),
			})
			.click();
		await main
			.getByRole("button", {
				name: new RegExp(`^View details for ${FORM_LINKS_SEED.caseName}`),
			})
			.click();
		await main.getByRole("button", { name: "Continue", exact: true }).click();
		await main
			.getByRole("button", { name: visit.formName, exact: true })
			.click();
		const visitNote = main.getByRole("textbox", { name: visit.noteFieldLabel });
		const finish = main.getByRole("button", { name: "Finish", exact: true });
		await expect(visitNote).toBeVisible({ timeout: 20_000 });
		await expect(finish).toBeEnabled();
		await visitNote.fill(FORM_LINKS_SEED.linkingNote);
		await expect(visitNote).toHaveValue(FORM_LINKS_SEED.linkingNote);
		await finish.click();

		// The first destination opens first, on the same patient.
		const followUpNote = main.getByRole("textbox", {
			name: followUp.noteFieldLabel,
		});
		await expect(followUpNote).toBeVisible({ timeout: 20_000 });
		const trail = page.getByRole("navigation", { name: "Page navigation" });
		await expect(trail).toContainText(FORM_LINKS_SEED.caseName);
		await expect(trail).toContainText(followUp.formName);
		await followUpNote.fill("Checked in");
		await main.getByRole("button", { name: "Next", exact: true }).click();
		await expect(finish).toBeEnabled();
		await finish.click();

		// Follow-up goes to the app home, which pushes nothing, so the second
		// destination, waiting beneath it, opens next.
		await expect(visitNote).toBeVisible({ timeout: 20_000 });
		await expect(trail).toContainText(FORM_LINKS_SEED.caseName);
		await expect(trail).toContainText(visit.formName);
		await expect(followUpNote).toHaveCount(0);
	});
});
