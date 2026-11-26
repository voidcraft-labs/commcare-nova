import type { Page } from "@playwright/test";
import { expect, seedFor, test } from "../../lib/appFixtures";
import { openBuilder, reloadBuilder } from "../../lib/pageLoads";

async function openAppSettings(page: Page) {
	await page.getByRole("button", { name: "App settings", exact: true }).click();
}

test("the saved and incomplete forms switches commit and survive a reload", {
	tag: "@seed:open",
}, async ({ scenario, page }) => {
	const { openAppId } = seedFor(scenario, "open");
	const saved = page.getByRole("switch", { name: /^Show saved forms/ });
	const incomplete = page.getByRole("switch", {
		name: /^Show incomplete forms/,
	});

	/** Toggle one switch and wait for the save that carries its one key, so
	 *  the reload reads the intended final state rather than racing it. */
	const toggleAndSave = async (
		control: typeof saved,
		key: "showSavedForms" | "showIncompleteForms",
	) => {
		const saveResponse = page.waitForResponse((response) => {
			const request = response.request();
			const body = request.postData() ?? "";
			return (
				new URL(response.url()).pathname === `/api/apps/${openAppId}` &&
				request.method() === "PUT" &&
				body.includes('"kind":"setAppSettings"') &&
				body.includes(`"${key}":true`)
			);
		});
		const [response] = await Promise.all([saveResponse, control.click()]);
		expect(response.ok()).toBe(true);
	};

	await openBuilder(page, `/build/${openAppId}`);
	await openAppSettings(page);
	await expect(
		page.getByText("Saved and incomplete forms", { exact: true }),
	).toBeVisible();
	await expect(saved).not.toBeChecked();
	await expect(incomplete).not.toBeChecked();

	await toggleAndSave(saved, "showSavedForms");
	await expect(saved).toBeChecked();
	await expect(incomplete).not.toBeChecked();

	await toggleAndSave(incomplete, "showIncompleteForms");
	await expect(incomplete).toBeChecked();

	await reloadBuilder(page);
	await openAppSettings(page);
	await expect(saved).toBeChecked();
	await expect(incomplete).toBeChecked();
});

test("a worker can focus and open a first-menu grid tile after the layout saves", {
	tag: "@seed:workspace",
}, async ({ scenario, page }) => {
	const { caseWorkspace } = seedFor(scenario, "workspace");
	await openBuilder(page, `/build/${caseWorkspace.appId}`);
	await openAppSettings(page);
	await page.getByLabel("First menu", { exact: true }).click();
	const saved = savedWith(page, caseWorkspace.appId, [
		'"firstMenuLayout":"grid"',
	]);
	await page.getByRole("menuitem", { name: "Grid", exact: true }).click();
	expect((await saved).ok()).toBe(true);
	await reloadBuilder(page);
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	const grid = page.locator('[data-menu-layout="grid"]');
	await expect(grid).toBeVisible();
	const tile = grid.getByRole("button", { name: /^Patient tile/ });
	await tile.focus();
	await expect(tile).toBeFocused();
	await tile.press("Enter");
	await expect(grid).toBeHidden();
	const results = page.locator('[data-case-results="tile"]');
	const caseChoice = results.locator("[data-case-result-action]").first();
	await expect(caseChoice).toBeVisible();
	await caseChoice.click();
	await expect(
		page
			.locator("main")
			.getByRole("button", { name: "Record a visit", exact: true }),
	).toBeVisible();
});

// ── Where workers use the app ───────────────────────────────────────────

/** The picker lines the platform table writes (`platformPickerLine`). */
const DATETIME_PICKER_LINE =
	"Not available in Web Apps. You can ask for a date and a time as two questions, or change where this app runs in App settings.";

/** Wait for the save of a batch whose body holds every one of `parts`. */
function savedWith(page: Page, appId: string, parts: readonly string[]) {
	return page.waitForResponse((response) => {
		const request = response.request();
		const body = request.postData() ?? "";
		return (
			new URL(response.url()).pathname === `/api/apps/${appId}` &&
			request.method() === "PUT" &&
			parts.every((part) => body.includes(part))
		);
	});
}

/** Open the starter form, whose canvas holds the insertion gaps. */
test("a form keeps its own submit button wording after a reload", {
	tag: "@seed:open",
}, async ({ scenario, page }) => {
	const { openAppId } = seedFor(scenario, "open");
	await openBuilder(page, `/build/${openAppId}`);
	await openStarterForm(page);
	await page
		.getByRole("button", { name: "Form settings", exact: true })
		.click();
	const label = page.getByRole("textbox", {
		name: "Submit button in Web Apps",
	});
	// The builder saves the document with its autosave PUT.
	const saved = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname === `/api/apps/${openAppId}` &&
			response.request().method() === "PUT" &&
			response.request().postData()?.includes("Send referral") === true &&
			response.ok(),
	);
	await label.fill("Send referral");
	await label.press("Enter");
	await saved;
	await reloadBuilder(page);
	await page
		.getByRole("button", { name: "Form settings", exact: true })
		.click();
	await expect(label).toHaveValue("Send referral");
});

async function openStarterForm(page: Page) {
	await page
		.getByRole("list", { name: "Survey forms" })
		.getByRole("button", { name: "Survey", exact: true })
		.click();
	await expect(page.locator("[data-insertion-point]").first()).toBeAttached();
}

/** Open the insertion menu at the form's last gap and a submenu of it. */
async function openInsertionSubmenu(page: Page, category: string) {
	await page.locator("[data-insertion-point] > button").last().click();
	await page.getByRole("menuitem", { name: category, exact: true }).hover();
}

async function choosePlatforms(
	page: Page,
	choice: "both" | "web-apps" | "android",
) {
	await page.locator(`[data-platform-choice="${choice}"]`).click();
}

test("where workers use the app can be changed, and a question it can't run is named and split", {
	tag: "@seed:open",
}, async ({ scenario, page }) => {
	const { openAppId } = seedFor(scenario, "open");
	await openBuilder(page, `/build/${openAppId}`);
	await openStarterForm(page);

	// A new app runs on both, so Date/Time is offered disabled with its line,
	// and the two-question insertion follows it.
	await openInsertionSubmenu(page, "Date & Time");
	const datetimeItem = page.getByRole("menuitem", { name: /^Date\/Time/ });
	await expect(datetimeItem).toBeDisabled();
	await expect(datetimeItem).toContainText(DATETIME_PICKER_LINE);
	await expect(
		page.getByRole("menuitem", { name: /^Date and time \(as two questions\)/ }),
	).toBeVisible();
	await page.keyboard.press("Escape");
	await page.keyboard.press("Escape");

	// Android only commits through the client gate.
	await openAppSettings(page);
	const narrowed = savedWith(page, openAppId, [
		'"kind":"setAppSettings"',
		'"runsOnlyOn":"android"',
	]);
	await choosePlatforms(page, "android");
	expect((await narrowed).ok()).toBe(true);
	await expect(
		page.getByRole("radio", { name: /^Android only/ }),
	).toBeChecked();
	await page.keyboard.press("Escape");

	// Date/Time is then offered, and inserts.
	await openInsertionSubmenu(page, "Date & Time");
	const inserted = savedWith(page, openAppId, ['"kind":"addField"']);
	await page.getByRole("menuitem", { name: "Date/Time", exact: true }).click();
	expect((await inserted).ok()).toBe(true);

	// Adding Web Apps back names the question in the way.
	await openAppSettings(page);
	await choosePlatforms(page, "both");
	const block = page.locator("[data-platform-refusal]");
	await expect(block).toContainText(
		"Web Apps can't run one thing this app uses",
	);
	await block.getByRole("button", { name: "Open new_datetime" }).click();
	await expect(
		page.locator('[data-field-id="id"] input').visible(),
	).toHaveValue("new_datetime");
	await expect(block).toBeVisible();

	// Its split leaves nothing in the way, and the block closes.
	const split = savedWith(page, openAppId, ['"kind":"convertField"']);
	await block
		.getByRole("button", { name: "Ask for the date and the time separately" })
		.click();
	expect((await split).ok()).toBe(true);
	await expect(block).toHaveCount(0);

	const widened = savedWith(page, openAppId, [
		'"kind":"setAppSettings"',
		'"runsOnlyOn":null',
	]);
	await choosePlatforms(page, "both");
	expect((await widened).ok()).toBe(true);

	await reloadBuilder(page);
	await openAppSettings(page);
	await expect(
		page.getByRole("radio", { name: /^Web Apps and Android/ }),
	).toBeChecked();
	await page.keyboard.press("Escape");
	for (const id of ["new_datetime_date", "new_datetime_time", "new_datetime"])
		await expect(page.locator(`[data-tree-field="${id}"]`)).toBeVisible();
});

test("a date and a time can be asked for in an app that runs in Web Apps", {
	tag: "@seed:open",
}, async ({ scenario, page }) => {
	const { openAppId } = seedFor(scenario, "open");
	await openBuilder(page, `/build/${openAppId}`);
	await openStarterForm(page);

	await openInsertionSubmenu(page, "Date & Time");
	const added = savedWith(page, openAppId, ['"kind":"addField"']);
	await page
		.getByRole("menuitem", { name: /^Date and time \(as two questions\)/ })
		.click();
	expect((await added).ok()).toBe(true);
	const ids = ["new_datetime_date", "new_datetime_time", "new_datetime"];
	for (const id of ids)
		await expect(page.locator(`[data-tree-field="${id}"]`)).toBeVisible();
	await expect(
		page.locator('[data-field-id="id"] input').visible(),
	).toHaveValue("new_datetime_date");

	// One undo removes all three.
	const undone = savedWith(page, openAppId, ['"kind":"removeField"']);
	await page.getByRole("button", { name: "Undo", exact: true }).click();
	expect((await undone).ok()).toBe(true);
	for (const id of ids)
		await expect(page.locator(`[data-tree-field="${id}"]`)).toHaveCount(0);
});

test("a stated difference shows where the author works", {
	tag: "@seed:open",
}, async ({ scenario, page }) => {
	const { openAppId } = seedFor(scenario, "open");
	await openBuilder(page, `/build/${openAppId}`);
	await openStarterForm(page);

	await openInsertionSubmenu(page, "Attachments and scanning");
	const added = savedWith(page, openAppId, ['"kind":"addField"']);
	await page.getByRole("menuitem", { name: "Image", exact: true }).click();
	expect((await added).ok()).toBe(true);
	const note = page.locator('[data-platform-note="image-question"]');
	await expect(note).toContainText("In Web Apps,");
	await expect(note).toContainText("On Android,");

	await openAppSettings(page);
	const narrowed = savedWith(page, openAppId, ['"runsOnlyOn":"android"']);
	await choosePlatforms(page, "android");
	expect((await narrowed).ok()).toBe(true);
	await expect(note).toHaveCount(0);
});

test("choosing both Connect roles saves the Android declaration and preserves independent roles", {
	tag: "@seed:open",
}, async ({ scenario, page }) => {
	const { openAppId } = seedFor(scenario, "open");
	await openBuilder(page, `/build/${openAppId}`);
	await openAppSettings(page);
	const connect = page.getByRole("group", { name: "CommCare Connect" });
	const learn = connect.getByRole("switch", { name: "Learn", exact: true });
	const deliver = connect.getByRole("switch", { name: "Deliver", exact: true });
	await expect(connect).toContainText(
		"Choosing a Connect role sets this app to Android only.",
	);
	await expect(connect).toContainText("if CommCare has location permission");
	const first = savedWith(page, openAppId, [
		'"runsOnlyOn":"android"',
		'"roles":["learn"]',
	]);
	await learn.click();
	expect((await first).ok()).toBe(true);
	const both = savedWith(page, openAppId, ['"roles":["learn","deliver"]']);
	await deliver.click();
	expect((await both).ok()).toBe(true);
	await reloadBuilder(page);
	await openAppSettings(page);
	await expect(learn).toBeChecked();
	await expect(deliver).toBeChecked();
	const onlyDelivery = savedWith(page, openAppId, ['"roles":["deliver"]']);
	await learn.click();
	expect((await onlyDelivery).ok()).toBe(true);
	const off = savedWith(page, openAppId, ['"roles":[]']);
	await deliver.click();
	expect((await off).ok()).toBe(true);
	await expect(
		page.getByRole("radio", { name: /^Android only/ }),
	).toBeChecked();
});

test("a learning activity keeps its role and explains how to remove it", {
	tag: "@seed:connect-learn",
}, async ({ scenario, page }) => {
	const { connectLearn } = seedFor(scenario, "connect-learn");
	await openBuilder(page, `/build/${connectLearn.appId}`);
	await openAppSettings(page);
	const connect = page.getByRole("group", { name: "CommCare Connect" });
	const learn = connect.getByRole("switch", { name: "Learn", exact: true });
	await learn.click();
	await expect(connect.getByRole("alert")).toContainText(/lesson_one.*role/);
	await expect(learn).toBeChecked();
	await reloadBuilder(page);
	await openAppSettings(page);
	await expect(learn).toBeChecked();
});

test("the individual grid can be set while the app uses lists, then takes effect when chosen", {
	tag: "@seed:workspace",
}, async ({ scenario, page }) => {
	const { caseWorkspace } = seedFor(scenario, "workspace");
	await openBuilder(page, caseWorkspace.routes.tileModule);
	await page
		.getByRole("button", { name: "Module settings", exact: true })
		.click();
	const section = page.locator("[data-menu-screen]");
	const individual = section.getByRole("switch", { name: /^Use a grid/ });
	await expect(individual).not.toBeChecked();
	await expect(section.getByText(/This choice takes effect/)).toBeVisible();
	const saved = savedWith(page, caseWorkspace.appId, ['"menuLayout":"grid"']);
	await individual.click();
	await saved;
	await reloadBuilder(page);
	await page
		.getByRole("button", { name: "Module settings", exact: true })
		.click();
	await expect(individual).toBeChecked();
	await openAppSettings(page);
	await page.getByLabel("Other menus", { exact: true }).click();
	const applies = savedWith(page, caseWorkspace.appId, [
		'"formMenuLayout":"individual"',
	]);
	await page
		.getByRole("menuitem", { name: "Choose per menu", exact: true })
		.click();
	await applies;
	await openBuilder(page, caseWorkspace.routes.tileModule);
	await page
		.getByRole("button", { name: "Module settings", exact: true })
		.click();
	await expect(
		section.getByText("Show this menu’s choices as tiles.", { exact: true }),
	).toBeVisible();
});

test("each form keeps its own location choice while the app requests every location", {
	tag: "@seed:workspace",
}, async ({ scenario, page }) => {
	const { caseWorkspace } = seedFor(scenario, "workspace");
	await openBuilder(page, caseWorkspace.routes.tileForm);
	const openForm = () =>
		page.getByRole("button", { name: "Form settings", exact: true }).click();
	const form = page.getByRole("switch", {
		name: "Request location for this form",
		exact: true,
	});
	const all = page.getByRole("switch", {
		name: "Request location for every form",
		exact: true,
	});
	const save = async (control: typeof all, needle: string) => {
		const [response] = await Promise.all([
			page.waitForResponse(
				(r) =>
					new URL(r.url()).pathname === `/api/apps/${caseWorkspace.appId}` &&
					r.request().method() === "PUT" &&
					(r.request().postData() ?? "").includes(needle),
			),
			control.click(),
		]);
		expect(response.ok()).toBe(true);
	};
	await openForm();
	await expect(form).not.toBeChecked();
	await save(form, '"captureLocation":true');
	await page.getByRole("button", { name: "Close form settings" }).click();
	await openAppSettings(page);
	await expect(all).not.toBeChecked();
	await save(all, '"captureLocation":true');
	await page.getByRole("button", { name: "Close app settings" }).click();
	await openForm();
	await expect(form).toBeChecked();
	await expect(
		page.getByText("Your app requests location for every form.", {
			exact: false,
		}),
	).toBeVisible();
	await page.getByRole("button", { name: "Close form settings" }).click();
	await openAppSettings(page);
	await save(all, '"captureLocation":false');
	await reloadBuilder(page);
	await openForm();
	await expect(form).toBeChecked();
	await expect(
		page.getByText(
			"On Android, opening this form requests the worker’s location.",
		),
	).toBeVisible();
});

test(
	"a sectioned Learn form keeps its worker pages and submitted activity order after a Builder edit",
	{
		tag: "@seed:connect-learn",
	},
	async ({ scenario, page }, testInfo) => {
		const {
			connectLearn: { appId },
		} = seedFor(scenario, "connect-learn");
		await openBuilder(page, `/build/${appId}`);
		await page
			.getByRole("list", { name: "Training forms" })
			.getByRole("button", { name: "Lesson one", exact: true })
			.click();
		await page.locator("[data-insertion-point] > button").last().click();
		await expect(
			page.getByRole("menuitem", { name: "Section", exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("menuitem", { name: "Input", exact: true }),
		).toHaveCount(0);
		await page
			.getByRole("menuitem", { name: "CommCare Connect", exact: true })
			.hover();
		const save = savedWith(page, appId, [
			'"kind":"addField"',
			'"id":"new_learning_module"',
		]);
		await page
			.getByRole("menuitem", { name: "Learning module", exact: true })
			.click();
		expect((await save).ok()).toBe(true);
		await reloadBuilder(page);
		await expect(
			page.locator('[data-tree-field="new_learning_module"]'),
		).toBeVisible();
		const response = await page.request.get(`/api/apps/${appId}`);
		expect(response.ok()).toBe(true);
		const { blueprint } = (await response.json()) as {
			blueprint: {
				moduleOrder: string[];
				formOrder: Record<string, string[]>;
				fieldOrder: Record<string, string[]>;
				fields: Record<string, { id: string }>;
			};
		};
		const form = blueprint.formOrder[blueprint.moduleOrder[0]][0];
		const root = blueprint.fieldOrder[form];
		expect(root.map((uuid) => blueprint.fields[uuid].id)).toEqual([
			"lesson_one",
			"practice",
			"review",
			"follow_up",
			"completion",
			"new_learning_module",
		]);
		expect(
			blueprint.fieldOrder[root[1]].map((uuid) => blueprint.fields[uuid].id),
		).toEqual(["reflection", "rehearsal"]);

		await openBuilder(page, `/build/${appId}`);
		await page.getByRole("button", { name: "Preview", exact: true }).click();
		const main = page.locator("main");
		await main.getByRole("button", { name: "Start", exact: true }).click();
		await main.getByRole("button", { name: /^Training\b/ }).click();
		await main.getByRole("button", { name: "Lesson one", exact: true }).click();
		const pages = main.getByRole("navigation", { name: "Sections" });
		await expect(pages.getByRole("button")).toHaveCount(2);
		await expect(
			pages.getByRole("button", { name: /Practice/ }),
		).toHaveAttribute("aria-current", "step");
		await main
			.getByRole("textbox", { name: "Reflection" })
			.fill("Practice with a colleague");
		await main.getByRole("button", { name: "Next", exact: true }).click();
		await expect(
			pages.getByRole("button", { name: /Follow up/ }),
		).toHaveAttribute("aria-current", "step");
		await expect(
			main.getByRole("textbox", { name: "Next step" }),
		).toBeVisible();
		await expect(
			main.getByRole("button", { name: "Finish", exact: true }),
		).toBeEnabled();
		await testInfo.attach("edited-learn-form-on-android", {
			body: await page.screenshot({ animations: "disabled" }),
			contentType: "image/png",
		});
	},
);

test("Android Preview reopens an incomplete form under its saved label", {
	tag: "@seed:open",
}, async ({ scenario, page }) => {
	const { openAppId } = seedFor(scenario, "open");
	await openBuilder(page, `/build/${openAppId}`);
	await openAppSettings(page);
	const android = savedWith(page, openAppId, ['"runsOnlyOn":"android"']);
	await choosePlatforms(page, "android");
	expect((await android).ok()).toBe(true);
	const incomplete = savedWith(page, openAppId, ['"showIncompleteForms":true']);
	await page.getByRole("switch", { name: /^Show incomplete forms/ }).click();
	expect((await incomplete).ok()).toBe(true);
	await page.keyboard.press("Escape");

	await openStarterForm(page);
	await page
		.getByRole("button", { name: "Form settings", exact: true })
		.click();
	await page.getByLabel("Add a form behavior", { exact: true }).click();
	await page
		.getByRole("option", { name: "Saved form label", exact: true })
		.click();
	await page.getByLabel("Text for saved form label", { exact: true }).click();
	const label = savedWith(page, openAppId, ['"savedFormDescriptorText"']);
	await page.getByRole("option", { name: /^Question 1/ }).click();
	expect((await label).ok()).toBe(true);
	await openBuilder(page, `/build/${openAppId}`);
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	const main = page.locator("main");
	await main.getByRole("button", { name: "Start", exact: true }).click();
	await main.getByRole("button", { name: /^Survey/ }).click();
	await main.getByRole("button", { name: "Survey", exact: true }).click();
	const answer = main.getByRole("textbox", { name: "Question 1", exact: true });
	await answer.fill("Before leaving");
	await main
		.getByRole("button", { name: "Save for later", exact: true })
		.click();
	await main.getByRole("button", { name: "Incomplete", exact: true }).click();
	await main.getByRole("button", { name: /^Question 1/ }).click();
	await expect(answer).toHaveValue("Before leaving");
	await expect(
		main.getByRole("button", { name: "Finish", exact: true }),
	).toBeEnabled();
});
