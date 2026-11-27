import { resolve } from "node:path";
import type { Page, Route } from "@playwright/test";
import { componentPeer } from "../../lib/componentPeer";
import { expect, test } from "../../lib/fixtures";
import { removableRoutes } from "../../lib/routes";

test.use({ actionTimeout: 10_000 });

let peer: Awaited<ReturnType<typeof componentPeer>>;
test.beforeAll(async () => {
	peer = await componentPeer("e2e/lib/case-workspace-surface-client.tsx", [], {
		"@/lib/lookup/actions": resolve(
			"e2e/lib/case-workspace-surface-boundary.ts",
		),
		"@/lib/preview/engine/caseDataBinding": resolve(
			"e2e/lib/case-workspace-surface-boundary.ts",
		),
	});
});
test.afterAll(async () => {
	await peer?.close();
});
test.beforeEach(async ({ page }) => {
	await page.route("**/native/filter-preview", (route) =>
		route.fulfill({ json: { kind: "rows", rows: [], totalCount: 0 } }),
	);
});
test("native workspace keeps URL tabs and inspector edits on the actual document", async ({
	page,
}) => {
	await page.goto(peer.origin);
	await expect(
		page.getByRole("navigation", { name: "Case workspace screens" }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Results", exact: true }),
	).toHaveAttribute("aria-current", "page");
	await page.getByRole("button", { name: "Details", exact: true }).click();
	await expect(page).toHaveURL(/\/details$/);
	await page.getByRole("button", { name: "Results", exact: true }).click();
	await expect(page).toHaveURL(/\/results$/);
	await page
		.locator('[data-case-column-select="00000000-0000-7000-8000-000000006001"]')
		.first()
		.click();
	await page
		.getByRole("textbox", { name: "Display label", exact: true })
		.fill("Updated name");
	await page
		.getByRole("button", { name: "Leave workspace", exact: true })
		.click();
	await expect(page.getByLabel("Saved module")).toContainText(
		'"header":"Updated name"',
	);
	await page
		.getByRole("button", { name: "Close properties", exact: true })
		.click();
	await expect(
		page
			.locator(
				'[data-case-column-select="00000000-0000-7000-8000-000000006001"]',
			)
			.first(),
	).toBeFocused();
});

test("a retained Android-only write is not offered as information for a case column", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=accented-write`);
	await page
		.locator('[data-case-column-select="00000000-0000-7000-8000-000000006001"]')
		.first()
		.click();
	await page.getByRole("button", { name: /^Information from:/ }).click();
	await expect(
		page.getByRole("menuitem", { name: /Portable state/ }),
	).toBeVisible();
	await expect(
		page.getByRole("menuitem", { name: /State saved on Android/ }),
	).toHaveCount(0);
	await page.getByRole("menuitem", { name: /Portable state/ }).click();
	await page
		.getByRole("button", { name: "Leave workspace", exact: true })
		.click();
	const saved = await savedModule(page);
	expect(saved.caseListConfig.columns[0].field).toBe("estado_e");
});

async function savedModule(page: Page) {
	return JSON.parse(
		(await page.getByLabel("Saved module").textContent()) ?? "null",
	);
}
test("a map color, its boundary and a location are saved together from Results", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=map`);
	await page
		.locator('[data-case-column-select="00000000-0000-7000-8000-000000006001"]')
		.first()
		.click();
	await page
		.getByRole("button", { name: "Display as: Text", exact: true })
		.click();
	await page.getByRole("menuitem", { name: /^Map layer/ }).click();
	const dialog = page.getByRole("alertdialog", {
		name: "Set up this map layer",
	});
	const save = dialog.getByRole("button", {
		name: "Save map layer",
		exact: true,
	});
	await expect(save).toBeDisabled();
	await dialog
		.getByRole("combobox", { name: "Map layer", exact: true })
		.click();
	await page
		.getByRole("option", { name: "Boundary color", exact: true })
		.click();
	await dialog
		.getByRole("combobox", { name: "Case location", exact: true })
		.click();
	await page
		.getByRole("option", { name: "Home location", exact: true })
		.click();
	await expect(save).toBeDisabled();
	await dialog.getByRole("combobox", { name: "Boundary", exact: true }).click();
	await page
		.getByRole("option", { name: "Assigned area", exact: true })
		.click();
	await expect
		.poll(async () =>
			(await savedModule(page)).caseListConfig.columns.map(
				(column: { kind: string }) => column.kind,
			),
		)
		.toEqual(["plain", "plain"]);
	await save.click();
	await expect(dialog).toBeHidden();
	await expect
		.poll(async () => (await savedModule(page)).caseListConfig.columns)
		.toMatchObject([
			{
				kind: "map-layer",
				field: "priority_color",
				layer: "boundary-color",
				visibleInDetail: false,
			},
			{ kind: "plain", field: "dob" },
			{ kind: "map-location", field: "home_point", visibleInDetail: false },
			{
				kind: "map-layer",
				field: "service_area",
				layer: "boundary",
				visibleInDetail: false,
			},
		]);
});

test("workers can see a choice label and its saved value in separate case columns", async ({
	page,
}) => {
	await page.goto(`${peer.origin}?scenario=choice-labels-and-values`);
	const code = page
		.locator('[data-case-column-select="00000000-0000-7000-8000-000000006002"]')
		.first();
	await code.click();
	const group = page.getByRole("group", { name: "Show choices as" });
	const saved = group.getByRole("button", { name: "Saved values" });
	await saved.focus();
	await saved.press("Space");
	await expect(saved).toHaveAttribute("aria-pressed", "true");
	await expect
		.poll(async () =>
			(await savedModule(page)).caseListConfig.columns.map(
				(c: { showChoice?: string }) => c.showChoice ?? "label",
			),
		)
		.toEqual(["label", "saved-value"]);
	await page
		.getByRole("button", { name: "Close properties", exact: true })
		.click();
	await code.click();
	await expect(saved).toHaveAttribute("aria-pressed", "true");
	await group.getByRole("button", { name: "Choice labels" }).click();
	await expect
		.poll(
			async () =>
				(await savedModule(page)).caseListConfig.columns[1].showChoice,
		)
		.toBeUndefined();
});

async function selectSearchInput(page: Page) {
	await page
		.locator('[data-case-search-field="00000000-0000-7000-8000-000000006003"]')
		.click();
}
test("native selection review cancels and commits actual consequences with focus recovery", async ({
	page,
}) => {
	await page.goto(`${peer.origin}?scenario=selection`);
	const several = page.getByRole("radio", {
		name: "Several cases",
		exact: true,
	});
	const before = await savedModule(page);
	await several.focus();
	await several.press("Space");
	const dialog = page.getByRole("alertdialog");
	await expect(dialog).toContainText(
		"“Status” in “Visit” has a starting answer",
	);
	await expect(dialog).toContainText(
		"“Photo” in “Visit” saves the stored file link",
	);
	await expect(dialog).toContainText(
		"Results tile will no longer stay above forms",
	);
	await expect(
		dialog.getByRole("button", { name: "Keep one case" }),
	).toBeFocused();
	expect(await savedModule(page)).toEqual(before);
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(several).toBeFocused();
	expect(await savedModule(page)).toEqual(before);
	await several.press("Space");
	await dialog
		.getByRole("button", { name: "Use several cases", exact: true })
		.click();
	await expect(several).toBeChecked();
	await expect(several).toBeFocused();
	const after = await savedModule(page);
	expect(after.caseListConfig.selection).toEqual({
		kind: "multiple",
		maximum: 100,
	});
	expect(after.caseListConfig.tile.persistOnForms).toBeUndefined();
	expect(after.caseListConfig.columns).toEqual(before.caseListConfig.columns);
	await page
		.getByRole("radio", { name: "One case", exact: true })
		.press("Space");
	await dialog
		.getByRole("button", { name: "Use one case", exact: true })
		.click();
	await expect(
		page.getByRole("radio", { name: "One case", exact: true }),
	).toBeChecked();
	expect((await savedModule(page)).caseListConfig.selection).toBeUndefined();
});
test("native selection limit validates drafts, commits a local limit, and refuses a stale peer overwrite", async ({
	page,
}) => {
	await page.goto(`${peer.origin}?scenario=results`);
	await page
		.getByRole("radio", { name: "Several cases", exact: true })
		.press("Space");
	await page
		.getByRole("button", { name: "Use several cases", exact: true })
		.click();
	const limit = page.getByRole("spinbutton", {
		name: "Most cases a worker can choose",
	});
	await limit.fill("101");
	await limit.press("Enter");
	await expect(limit).toHaveAttribute("aria-invalid", "true");
	expect((await savedModule(page)).caseListConfig.selection.maximum).toBe(100);
	await limit.press("Escape");
	await expect(limit).toHaveValue("100");
	await limit.fill("12");
	await limit.press("Enter");
	await expect(page.getByRole("alertdialog")).toHaveCount(0);
	await expect(limit).toBeFocused();
	await expect(limit).toHaveValue("12");
	await limit.fill("24");
	await page.getByRole("button", { name: "Peer changes limit" }).click();
	await expect(limit).toHaveValue("24");
	await expect(limit).toBeFocused();
	await limit.press("Enter");
	await expect(page.getByRole("alert")).toContainText(
		"This limit changed elsewhere",
	);
	expect((await savedModule(page)).caseListConfig.selection.maximum).toBe(18);
	await limit.press("Escape");
	await expect(limit).toHaveValue("18");
});
test("native selection viewer describes saved behavior without editing controls", async ({
	page,
}) => {
	await page.goto(`${peer.origin}?scenario=selection-viewer`);
	await expect(
		page.getByRole("heading", { name: "Case selection", exact: true }),
	).toBeVisible();
	await expect(
		page.getByText("People choose up to 8 cases", { exact: false }),
	).toBeVisible();
	await expect(page.getByRole("radio")).toHaveCount(0);
	await expect(page.getByRole("spinbutton")).toHaveCount(0);
	expect((await savedModule(page)).caseListConfig.selection).toEqual({
		kind: "multiple",
		maximum: 8,
	});
});
test("native list action viewer reads the form button's condition once", async ({
	page,
}) => {
	await page.goto(`${peer.origin}?scenario=list-action-viewer`);
	const setting = page.locator("[data-register-from-list-setting]");
	await expect(
		setting.getByRole("heading", { name: "Form button on the list" }),
	).toBeVisible();
	await expect(setting.getByText(/^The form button appears/)).toHaveCount(1);
	await expect(
		setting.getByRole("button", { name: "When a condition is met" }),
	).toHaveCount(0);
});
test("native list action keeps the button's visibility unsaved until a condition is written", async ({
	page,
}) => {
	await page.goto(`${peer.origin}?scenario=list-action`);
	const setting = page.locator("[data-register-from-list-setting]");
	const conditional = setting.getByRole("button", {
		name: "When a condition is met",
	});
	await conditional.click();
	await expect(conditional).toHaveAttribute("aria-pressed", "true");
	await setting.getByRole("button", { name: "Add condition" }).click();
	await expect(conditional).toHaveAttribute("aria-pressed", "true");
	const slot = (await savedModule(page)).caseListRegistrationForm;
	expect(slot).toMatchObject({ kind: "always" });
	expect(slot).not.toHaveProperty("showWhen");
	await setting
		.getByRole("button", { name: "Whenever the list opens" })
		.click();
	await expect(
		setting.getByRole("button", { name: "Add condition" }),
	).toHaveCount(0);
	expect((await savedModule(page)).caseListRegistrationForm).not.toHaveProperty(
		"showWhen",
	);
});
test("native Search chooser filters, recovers focus, and creates the selected typed field", async ({
	page,
}) => {
	await page.goto(`${peer.origin}?scenario=search`);
	const trigger = page.getByRole("combobox", {
		name: "Add search field",
		exact: true,
	});
	await trigger.press("Enter");
	const search = page.getByRole("combobox", {
		name: "Search case information",
		exact: true,
	});
	await expect(search).toBeFocused();
	await expect(page.getByRole("option").first()).toContainText("Client name");
	await search.fill("no matching property");
	await expect(
		page.getByRole("status").filter({ hasText: "No matching information" }),
	).toBeVisible();
	await page.getByRole("button", { name: "Clear search", exact: true }).click();
	await expect(search).toHaveValue("");
	await expect(search).toBeFocused();
	await search.fill("dob");
	await expect(page.getByRole("option")).toHaveCount(1);
	await expect(page.getByRole("option")).toContainText("Birth date");
	await search.press("ArrowDown");
	await search.press("Enter");
	await expect(search).toHaveCount(0);
	const saved = (await savedModule(page)).caseListConfig.searchInputs;
	expect(saved).toHaveLength(2);
	expect(saved[1]).toMatchObject({
		kind: "simple",
		type: "date",
		property: "dob",
		label: "Birth date",
	});
	await expect(
		page.getByRole("textbox", { name: "Search field 2 label" }),
	).toBeVisible();
	await page.getByRole("button", { name: "Close properties" }).click();
	await expect(
		page.locator(`[data-case-search-field="${saved[1].uuid}"]`),
	).toBeFocused();
	await trigger.click();
	// Opening hands native keyboard ownership to the popup's search input.
	await expect(search).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(search).toHaveCount(0);
	await expect(trigger).toHaveAttribute("aria-expanded", "false");
	await expect(trigger).toBeFocused();
});
test("direct parent Search keeps its match when a field is renamed or relabeled", async ({
	page,
}) => {
	await page.goto(`${peer.origin}?scenario=search-direct-parent`);
	const original = (await savedModule(page)).caseListConfig.searchInputs[0];
	await page.locator(`[data-case-search-field="${original.uuid}"]`).click();

	const matching = page.getByRole("switch", {
		name: /^Use project space matching/,
	});
	await expect(matching).toBeChecked();
	const label = page.getByRole("textbox", { name: "Search field 1 label" });
	await label.fill("Household address");
	await label.press("Tab");
	await expect
		.poll(async () => (await savedModule(page)).caseListConfig.searchInputs[0])
		.toMatchObject({ ...original, label: "Household address" });

	await page.getByRole("button", { name: "More settings" }).click();
	const name = page.getByRole("textbox", {
		name: "Search field 1 name",
		exact: true,
	});
	await name.fill("home_address");
	await name.press("Tab");
	await expect
		.poll(async () => (await savedModule(page)).caseListConfig.searchInputs[0])
		.toMatchObject({
			...original,
			label: "Household address",
			name: "home_address",
		});
	await expect(matching).toBeChecked();

	await page
		.getByRole("combobox", { name: "Search field 1 information" })
		.click();
	await page.getByRole("option", { name: /^Region/ }).click();
	const changed = (await savedModule(page)).caseListConfig.searchInputs[0];
	expect(changed).toMatchObject({
		uuid: original.uuid,
		property: "region",
		name: "home_address",
	});
	expect(changed).not.toHaveProperty("matching");
	expect(changed).not.toHaveProperty("via");
	await expect(matching).toHaveCount(0);
});

test("native Search keyboard reordering and removal preserve field identity and move focus", async ({
	page,
}) => {
	await page.goto(`${peer.origin}?scenario=search`);
	await page
		.getByRole("combobox", { name: "Add search field", exact: true })
		.click();
	await page.getByRole("option", { name: /Birth date.*Date/ }).click();
	const original = (await savedModule(page)).caseListConfig.searchInputs;
	const handle = page.getByRole("button", {
		name: /Move Birth date in Search/,
	});
	const identity = await handle.elementHandle();
	await handle.press("Home");
	await expect(handle).toBeFocused();
	expect(await handle.evaluate((el, same) => el === same, identity)).toBe(true);
	expect(
		(await savedModule(page)).caseListConfig.searchInputs.map(
			(x: { uuid: string }) => x.uuid,
		),
	).toEqual([original[1].uuid, original[0].uuid]);
	await expect(
		page.getByRole("status").filter({ hasText: "Birth date moved earlier" }),
	).toHaveText("Birth date moved earlier in Search");
	await page.locator(`[data-case-search-field="${original[1].uuid}"]`).click();
	await page
		.getByRole("button", { name: "Remove search field", exact: true })
		.click();
	await expect(
		page.locator(`[data-case-search-field="${original[0].uuid}"]`),
	).toBeFocused();
	expect((await savedModule(page)).caseListConfig.searchInputs).toEqual([
		original[0],
	]);
	await identity?.dispose();
});
test("native last Search field removal reviews copy and preserves independent assigned cases", async ({
	page,
}) => {
	await page.goto(`${peer.origin}?scenario=search-remove`);
	await selectSearchInput(page);
	const before = await savedModule(page);
	await page
		.getByRole("button", { name: "Remove search field", exact: true })
		.click();
	const dialog = page.getByRole("alertdialog");
	await expect(dialog).toContainText("Remove the last Search field?");
	await expect(dialog).toContainText(
		"Search availability condition will stay in More settings",
	);
	await expect(
		dialog.getByRole("button", { name: "Cancel", exact: true }),
	).toBeFocused();
	await page.keyboard.press("Escape");
	expect(await savedModule(page)).toEqual(before);
	await expect(
		page.getByRole("button", { name: "Remove search field", exact: true }),
	).toBeFocused();
	await page
		.getByRole("button", { name: "Remove search field", exact: true })
		.click();
	await dialog
		.getByRole("button", { name: "Remove field", exact: true })
		.click();
	await expect(
		page.getByRole("combobox", { name: "Add search field", exact: true }),
	).toBeFocused();
	const after = await savedModule(page);
	expect(after.caseListConfig.searchInputs).toEqual([]);
	expect(after.caseListConfig.columns).toEqual(before.caseListConfig.columns);
	// With nothing left to fill in, the menu opens on Results first in the
	// same batch (`withWorkflowAfterInputChange`).
	expect(after.caseSearchConfig).toEqual({
		excludedOwnerIds: before.caseSearchConfig.excludedOwnerIds,
		searchButtonDisplayCondition:
			before.caseSearchConfig.searchButtonDisplayCondition,
		workflow: "skipToResults",
	});
	await expect(
		page.getByRole("heading", {
			name: "Results can open automatically",
			exact: true,
		}),
	).toBeVisible();
});
test("native Search date-range conversion keeps the saved default until confirmation", async ({
	page,
}) => {
	await page.clock.setFixedTime(new Date(2024, 2, 15, 12));
	await page.goto(`${peer.origin}?scenario=search-date`);
	await selectSearchInput(page);
	const before = await savedModule(page);
	const match = page.getByRole("button", {
		name: /Search field 1 match: Exact/,
	});
	await match.click();
	await page.getByRole("menuitemradio", { name: /Between dates/ }).click();
	const dialog = page.getByRole("alertdialog");
	await expect(dialog).toContainText("Change to “Between dates”?");
	expect(await savedModule(page)).toEqual(before);
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(match).toBeFocused();
	expect(await savedModule(page)).toEqual(before);
	await match.click();
	await page.getByRole("menuitemradio", { name: /Between dates/ }).click();
	await dialog.getByRole("button", { name: "Change", exact: true }).click();
	await expect(
		page.getByRole("button", { name: /Search field 1 type: Date range/ }),
	).toBeVisible();
	expect((await savedModule(page)).caseListConfig.searchInputs[0]).toEqual({
		...before.caseListConfig.searchInputs[0],
		type: "date-range",
		mode: { kind: "range" },
		default: undefined,
	});
	await page.getByRole("button", { name: "Choose dates" }).click();
	await page.getByLabel("Start date", { exact: true }).click();
	await page.getByRole("button", { name: /March 1st, 2024/ }).click();
	await expect(
		page.getByRole("button", { name: "Use these dates" }),
	).toBeDisabled();
	expect(
		(await savedModule(page)).caseListConfig.searchInputs[0].default,
	).toBeUndefined();
	await page.getByLabel("End date", { exact: true }).click();
	await page.getByRole("button", { name: /March 31st, 2024/ }).click();
	await page.getByRole("button", { name: "Use these dates" }).click();
	await expect
		.poll(
			async () =>
				(await savedModule(page)).caseListConfig.searchInputs[0].default,
		)
		.toEqual({
			kind: "term",
			term: { kind: "literal", value: "__range__2024-03-01__2024-03-31" },
		});
	await expect(
		page.getByText("2024-03-01 to 2024-03-31", { exact: true }),
	).toBeVisible();
});
test("a human-readable date calculation keeps its worker-zone dates when the picker closes", async ({
	page,
}) => {
	await page.goto(`${peer.origin}?scenario=search-calendar-calculation`);
	await selectSearchInput(page);
	const source = (await savedModule(page)).caseListConfig.searchInputs[0]
		.default;
	await expect(page.getByRole("button", { name: "Change dates" })).toHaveCount(
		0,
	);
	await page.getByRole("button", { name: "Choose dates" }).click();
	await expect(
		page.getByRole("button", { name: "Use these dates" }),
	).toBeDisabled();
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	expect(
		(await savedModule(page)).caseListConfig.searchInputs[0].default,
	).toEqual(source);
	await expect(
		page.getByRole("button", { name: "Choose dates" }),
	).toBeVisible();
});

test("native compatible Search type edit preserves its saved match and starting value", async ({
	page,
}) => {
	await page.goto(`${peer.origin}?scenario=search-text`);
	await selectSearchInput(page);
	const before = (await savedModule(page)).caseListConfig.searchInputs[0];
	await page
		.getByRole("button", { name: /Search field 1 type: Text box/ })
		.click();
	await page.getByRole("menuitemradio", { name: /^Barcode/ }).click();
	await expect(page.getByRole("alertdialog")).toHaveCount(0);
	expect((await savedModule(page)).caseListConfig.searchInputs[0]).toEqual({
		...before,
		type: "barcode",
	});
});

test("native selection confirmation rechecks consequences after a peer edit", async ({
	page,
}) => {
	await page.goto(`${peer.origin}?scenario=selection`);
	await page
		.getByRole("radio", { name: "Several cases", exact: true })
		.press("Space");
	const dialog = page.getByRole("alertdialog");
	await expect(dialog).toContainText("“Status” in “Visit”");
	// This event is a fixture-owned peer command, delivered while the modal owns
	// interaction. It commits through the actual mutation hook and gate.
	await page.evaluate(() =>
		window.dispatchEvent(new Event("native-peer-selection")),
	);
	await dialog
		.getByRole("button", { name: "Use several cases", exact: true })
		.click();
	await expect(dialog).toContainText("“Peer status” in “Visit”");
	await expect(dialog.getByRole("alert")).toContainText("changed");
	expect((await savedModule(page)).caseListConfig.selection).toBeUndefined();
	await dialog
		.getByRole("button", { name: "Use several cases", exact: true })
		.click();
	await expect(dialog).toHaveCount(0);
	expect((await savedModule(page)).caseListConfig.selection).toEqual({
		kind: "multiple",
		maximum: 100,
	});
});
test("native grouped Search date keeps its DOM and focus through actual planner clones", async ({
	page,
}) => {
	await page.goto(`${peer.origin}?scenario=search-clone`);
	await selectSearchInput(page);
	await page
		.getByRole("button", { name: "Edit condition", exact: true })
		.click();
	const date = page
		.locator("[data-workbench-focus-id]")
		.filter({ has: page.locator('input[type="date"]') })
		.locator('input[type="date"]')
		.first();
	await expect(date).toHaveValue("2026-01-01");
	const identity = await date.elementHandle();
	const expected = (await savedModule(page)).caseListConfig.searchInputs[0]
		.predicate;
	expected.clauses[0].right.term.value = "2026-02-02";
	try {
		await date.fill("2026-02-02");
		await expect(date).toBeFocused();
		expect(await date.evaluate((el, same) => el === same, identity)).toBe(true);
		expect(
			(await savedModule(page)).caseListConfig.searchInputs[0].predicate,
		).toEqual(expected);
	} finally {
		await identity?.dispose();
	}
});
test("native Search dependency review follows exact editors and recomputes peer repairs", async ({
	page,
}) => {
	await page.goto(`${peer.origin}?scenario=search-dependencies`);
	await selectSearchInput(page);
	await page
		.getByRole("button", { name: "Remove search field", exact: true })
		.click();
	const dialog = page.getByRole("alertdialog");
	await expect(
		dialog.getByRole("list", { name: "Rules using Name" }),
	).toContainText("Cases available");
	await dialog
		.getByRole("button", { name: /Cases available.*2 places.*Review/ })
		.click();
	await expect(page).toHaveURL(/\/results$/);
	const activeBody = page
		.locator("[data-case-workspace-scroll-body]")
		.visible();
	const focused = activeBody.locator("[data-workbench-active-heading]");
	await expect(focused).toBeFocused();
	await expect(
		activeBody.locator('section[data-workbench-focus-id="[]"]'),
	).toContainText("Search answer");
	await page
		.getByRole("button", { name: "Peer simplifies dependency" })
		.click();
	await page
		.getByRole("button", { name: "Back to Name search field", exact: true })
		.click();
	await expect(page).toHaveURL(/\/search$/);
	await expect(
		dialog.getByRole("button", { name: /Cases available.*once.*Review/ }),
	).toBeVisible();
	await dialog
		.getByRole("button", { name: /Region.*2 places.*Review/ })
		.click();
	await expect(focused).toBeFocused();
	await expect(
		activeBody.locator('section[data-workbench-focus-id="[]"]'),
	).toContainText("Search answer");
	await page.getByRole("button", { name: "Peer clears dependencies" }).click();
	await page
		.getByRole("button", { name: "Back to Name search field", exact: true })
		.click();
	await expect(dialog).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Remove search field", exact: true }),
	).toBeFocused();
	await expect(
		page.getByText("No rules use Name now. You can remove the field.", {
			exact: true,
		}),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Remove search field", exact: true })
		.click();
	expect(
		(await savedModule(page)).caseListConfig.searchInputs.map(
			(x: { name: string }) => x.name,
		),
	).toEqual(["region"]);
});
test("native Search explains an unmatched address topic and can replace it with a picker", async ({
	page,
}) => {
	await page.goto(`${peer.origin}?scenario=search-address-unmatched-topic`);
	const before = (await savedModule(page)).caseListConfig.searchInputs;
	const control = (name: string) =>
		page
			.getByRole("button", { name, exact: true })
			.and(page.locator('[aria-haspopup="menu"]'));
	await page.locator(`[data-case-search-field="${before[2].uuid}"]`).click();
	await expect(
		page.getByText(
			"This saved topic has no address field to fill the answer.",
			{ exact: false },
		),
	).toBeVisible();
	await control("address||city").click();
	await page
		.getByRole("menuitemradio", { name: "No address field", exact: true })
		.click();
	await expect
		.poll(
			async () =>
				(await savedModule(page)).caseListConfig.searchInputs[2]
					.addressReceiver,
		)
		.toBeUndefined();
	await control("No address field").click();
	await page
		.getByRole("menuitemradio", { name: "Find an address", exact: true })
		.click();
	await expect
		.poll(
			async () =>
				(await savedModule(page)).caseListConfig.searchInputs[2]
					.addressReceiver,
		)
		.toEqual({
			kind: "address",
			source: before[0].uuid,
			parts: ["city"],
		});
	await expect(control("Find an address")).toBeVisible();
	expect((await savedModule(page)).caseListConfig.searchInputs[3]).toEqual(
		before[3],
	);
});

test("native Search address removal reviews, retargets and clears links", async ({
	page,
}) => {
	await page.goto(`${peer.origin}?scenario=search-address-removal`);
	await selectSearchInput(page);
	const before = (await savedModule(page)).caseListConfig.searchInputs;
	const remove = page.getByRole("button", {
		name: "Remove search field",
		exact: true,
	});
	const review = page.getByRole("alertdialog");
	await remove.click();
	const uses = review.getByRole("list", { name: "Uses of Find an address" });
	await expect(uses.getByRole("listitem")).toHaveCount(2);
	const receiver = uses.getByRole("button", {
		name: /Region.*Fills from this address field.*Review/,
	});
	await receiver.click();
	const back = page.getByRole("button", {
		name: "Back to Find an address search field",
		exact: true,
	});
	const addressSetting = page.getByText("Fill from an address", {
		exact: true,
	});
	await expect(addressSetting).toBeVisible();
	const sourceControl = page
		.getByRole("button", { name: "Find an address", exact: true })
		.and(page.locator('[aria-haspopup="menu"]'));
	await expect(sourceControl).toBeFocused();
	await back.click();
	await expect(receiver).toBeVisible();
	expect((await savedModule(page)).caseListConfig.searchInputs).toEqual(before);

	await receiver.click();
	await sourceControl.click();
	await page
		.getByRole("menuitemradio", { name: "Alternative address", exact: true })
		.click();
	await expect
		.poll(
			async () =>
				(await savedModule(page)).caseListConfig.searchInputs[2].addressReceiver
					.source,
		)
		.toBe(before[1].uuid);
	await back.click();
	await expect(receiver).toHaveCount(0);
	const otherReceiver = uses.getByRole("button", {
		name: /Client name.*Fills from this address field.*Review/,
	});
	await otherReceiver.click();
	await expect(sourceControl).toBeFocused();
	await sourceControl.click();
	await page
		.getByRole("menuitemradio", { name: "No address field", exact: true })
		.click();
	await back.click();
	await expect(review).toHaveCount(0);
	await expect(remove).toBeFocused();
	await remove.click();
	const { addressReceiver: _oldReceiver, ...unlinked } = before[3];
	expect((await savedModule(page)).caseListConfig.searchInputs).toStrictEqual([
		before[1],
		{
			...before[2],
			addressReceiver: { ...before[2].addressReceiver, source: before[1].uuid },
		},
		unlinked,
	]);
});
test("native Add information progressive choices create a separate view and reset on reopen", async ({
	page,
}) => {
	await page.goto(peer.origin);
	const before = (await savedModule(page)).caseListConfig;
	const add = page.getByRole("combobox", {
		name: "Add information",
		exact: true,
	});
	await add.click();
	await expect(page.getByRole("option", { name: /^Client name/ })).toHaveCount(
		0,
	);
	await page
		.getByRole("option", { name: /Show information another way/ })
		.click();
	const search = page.getByRole("combobox", {
		name: "Search information already shown",
		exact: true,
	});
	await expect(search).toBeFocused();
	await page.getByRole("option", { name: /Client name.*second label/ }).click();
	const after = (await savedModule(page)).caseListConfig;
	expect(after.columns).toHaveLength(3);
	expect(after.columns.slice(0, 2)).toEqual(before.columns);
	expect(after.columns[2]).toMatchObject({
		field: "case_name",
		header: "Client name",
		visibleInDetail: false,
	});
	expect(after.listColumnOrder).toEqual([
		...before.listColumnOrder,
		after.columns[2].uuid,
	]);
	expect(after.detailColumnOrder).toEqual([
		...before.detailColumnOrder,
		after.columns[2].uuid,
	]);
	await page.getByRole("button", { name: "Close properties" }).click();
	await add.click();
	await expect(
		page.getByRole("combobox", {
			name: "Search case information",
			exact: true,
		}),
	).toBeFocused();
	await expect(
		page.getByRole("option", { name: /Show information another way/ }),
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(add).toBeFocused();
});
test("native default order uses typed directions and hidden information without changing display arrangements", async ({
	page,
}) => {
	await page.goto(peer.origin);
	const before = (await savedModule(page)).caseListConfig;
	await page
		.getByRole("button", { name: "Set default order", exact: true })
		.press("Enter");
	const add = page.getByRole("combobox", {
		name: "Add to default order",
		exact: true,
	});
	await add.click();
	await page.getByRole("option", { name: "Birth date", exact: true }).click();
	await page
		.getByRole("button", {
			name: /Change direction for Birth date, currently Earliest first/,
		})
		.click();
	await page
		.getByRole("menuitemradio", { name: "Latest first", exact: true })
		.click();
	await add.click();
	await page.getByRole("option", { name: "Region", exact: true }).click();
	const region = page.getByRole("button", { name: /^Move Region\./ });
	const identity = await region.elementHandle();
	try {
		await region.press("Home");
		await expect(region).toBeFocused();
		expect(await region.evaluate((el, same) => el === same, identity)).toBe(
			true,
		);
		const after = (await savedModule(page)).caseListConfig;
		expect(after.listColumnOrder).toEqual([
			...before.listColumnOrder,
			after.columns[2].uuid,
		]);
		expect(after.detailColumnOrder).toEqual([
			...before.detailColumnOrder,
			after.columns[2].uuid,
		]);
		expect(
			after.columns.find((c: { field: string }) => c.field === "region"),
		).toMatchObject({
			visibleInList: false,
			visibleInDetail: false,
			sort: { direction: "asc", priority: 0 },
		});
		expect(
			after.columns.find((c: { field: string }) => c.field === "dob").sort,
		).toEqual({ direction: "desc", priority: 1 });
		await page
			.getByRole("button", {
				name: "Remove Region from default order",
				exact: true,
			})
			.click();
		await expect(
			page.getByRole("button", { name: /^Move Birth date\./ }),
		).toBeFocused();
		await page
			.getByRole("button", {
				name: "Remove Birth date from default order",
				exact: true,
			})
			.click();
		await expect(add).toBeFocused();
		expect(
			(await savedModule(page)).caseListConfig.columns.every(
				(c: { sort?: unknown }) => c.sort === undefined,
			),
		).toBe(true);
	} finally {
		await identity?.dispose();
	}
});

test("native default order names a hidden field in Sort by, and an empty name takes it out", async ({
	page,
}) => {
	await page.goto(peer.origin);
	await page
		.getByRole("button", { name: "Set default order", exact: true })
		.press("Enter");
	await page
		.getByRole("combobox", { name: "Add to default order", exact: true })
		.click();
	await page.getByRole("option", { name: "Region", exact: true }).click();
	const name = page.getByRole("textbox", {
		name: "Name in Sort by",
		exact: true,
	});
	await expect(name).toHaveValue("");
	await expect(name).toHaveAccessibleDescription(
		/^Workers can order the list by this from Sort by, under this name\./,
	);
	await name.fill("Region of the household");
	await name.press("Enter");
	const region = () =>
		savedModule(page).then((module) =>
			module.caseListConfig.columns.find(
				(c: { field: string }) => c.field === "region",
			),
		);
	await expect
		.poll(async () => (await region())?.sort)
		.toEqual({
			direction: "asc",
			priority: 0,
			label: "Region of the household",
		});
	await name.fill("   ");
	await name.press("Enter");
	await expect
		.poll(async () => (await region())?.sort)
		.toEqual({ direction: "asc", priority: 0 });
	await expect(name).toHaveValue("");
});

async function capturedFilterPeer(page: Page) {
	const pending: Route[] = [];
	const owned = new Set<Route>();
	const requests: unknown[] = [];
	const filterRoutes = removableRoutes(page);
	await filterRoutes.route("**/native/filter-preview", (route) => {
		requests.push(route.request().postDataJSON());
		pending.push(route);
		owned.add(route);
	});
	return {
		requests,
		async take() {
			await expect.poll(() => pending.length).toBeGreaterThan(0);
			const route = pending.shift();
			if (!route) throw new Error("Missing filter request");
			return {
				request: () => route.request(),
				async fulfill(options: Parameters<Route["fulfill"]>[0]) {
					try {
						await route.fulfill(options);
					} finally {
						owned.delete(route);
					}
				},
			};
		},
		async close() {
			await Promise.all([...owned].map((route) => route.abort()));
			owned.clear();
			pending.length = 0;
			await filterRoutes.removeAll();
		},
	};
}
async function nextBrowserCommit(page: Page) {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	);
}
test("native matching count uses the current blueprint and keeps retry focus through pending and failed responses", async ({
	page,
}) => {
	const controlled = await capturedFilterPeer(page);
	try {
		await page.goto(`${peer.origin}?scenario=filter-owner`);
		const first = await controlled.take();
		const payload = first.request().postDataJSON();
		const module = await savedModule(page);
		expect(payload).toMatchObject({
			appId: "native-workspace",
			caseType: "patient",
			limit: 1,
			caseListConfig: module.caseListConfig,
			excludedOwnerIdsExpression: module.caseSearchConfig.excludedOwnerIds,
		});
		expect(payload.blueprint.modules[module.uuid].caseListConfig).toEqual(
			module.caseListConfig,
		);
		expect(
			payload.blueprint.caseTypes
				.find((c: { name: string }) => c.name === "patient")
				.properties.map((p: { name: string }) => p.name),
		).toContain("region");
		expect(payload.viewerTimeZone).toEqual(expect.any(String));
		await first.fulfill({ json: { kind: "error", message: "Unavailable" } });
		const retry = page.getByRole("button", { name: "Try again", exact: true });
		await expect(retry).toBeVisible();
		await retry.press("Enter");
		const pending = await controlled.take();
		const status = page
			.locator("[data-case-availability-composer]")
			.getByRole("status");
		await expect(status).toHaveAttribute("aria-busy", "true");
		await expect(status).toBeFocused();
		await pending.fulfill({
			json: { kind: "error", message: "Still unavailable" },
		});
		await expect(retry).toBeFocused();
		await retry.press("Enter");
		await (await controlled.take()).fulfill({
			json: { kind: "rows", rows: [], totalCount: 42 },
		});
		await expect(status).toContainText("42 cases match");
		await expect(status).toBeFocused();
		expect(controlled.requests).toHaveLength(3);
	} finally {
		await controlled.close();
	}
});
test("native matching count ignores stale filter responses and invalidates only its real case partition", async ({
	page,
}) => {
	const controlled = await capturedFilterPeer(page);
	try {
		await page.goto(`${peer.origin}?scenario=filter`);
		const stale = await controlled.take();
		await page.getByRole("button", { name: "Peer changes filter" }).click();
		const current = await controlled.take();
		expect(
			current.request().postDataJSON().caseListConfig.filter.right.term.value,
		).toBe("South");
		await current.fulfill({ json: { kind: "rows", rows: [], totalCount: 9 } });
		const status = page
			.locator("[data-case-availability-composer]")
			.getByRole("status");
		await expect(status).toContainText("9 cases match");
		const oldResponse = page.waitForResponse(
			(response) =>
				response.url().endsWith("/native/filter-preview") &&
				response.request().postDataJSON().caseListConfig.filter.right.term
					.value === "North",
		);
		await stale.fulfill({ json: { kind: "rows", rows: [], totalCount: 81 } });
		await (await oldResponse).finished();
		await nextBrowserCommit(page);
		await expect(status).toContainText("9 cases match");
		await page.getByRole("button", { name: "Other case data changed" }).click();
		await nextBrowserCommit(page);
		expect(controlled.requests).toHaveLength(2);
		await page
			.getByRole("button", { name: "Case data changed", exact: true })
			.click();
		const refreshed = await controlled.take();
		await expect(status).toHaveAttribute("aria-busy", "true");
		await expect(status).toContainText("9 cases match");
		await refreshed.fulfill({
			json: { kind: "rows", rows: [], totalCount: 10 },
		});
		await expect(status).toContainText("10 cases match");
		expect(controlled.requests).toHaveLength(3);
	} finally {
		await controlled.close();
	}
});
test("native matching count masks the old access epoch before new permission is confirmed", async ({
	page,
}) => {
	const controlled = await capturedFilterPeer(page);
	try {
		await page.goto(`${peer.origin}?scenario=filter`);
		await (await controlled.take()).fulfill({
			json: { kind: "rows", rows: [], totalCount: 27 },
		});
		const status = page
			.locator("[data-case-availability-composer]")
			.getByRole("status");
		await expect(status).toContainText("27 cases match");
		await page.getByRole("button", { name: "Refresh access" }).click();
		await expect(status).toContainText("Counting matches");
		await expect(status).not.toContainText("27");
		await nextBrowserCommit(page);
		expect(controlled.requests).toHaveLength(1);
		await page.getByRole("button", { name: "Access confirmed" }).click();
		const refreshed = await controlled.take();
		await expect(status).not.toContainText("27");
		await refreshed.fulfill({
			json: { kind: "rows", rows: [], totalCount: 3 },
		});
		await expect(status).toContainText("3 cases match");
	} finally {
		await controlled.close();
	}
});
test("native clearing availability confirms once and preserves Search and assigned-case settings", async ({
	page,
}) => {
	await page.goto(`${peer.origin}?scenario=filter-owner`);
	const before = await savedModule(page);
	const composer = page.locator("[data-case-availability-composer]");
	const remove = composer.getByRole("button", {
		name: "Remove these conditions",
		exact: true,
	});
	await remove.click();
	const dialog = page.getByRole("alertdialog");
	await expect(dialog).toContainText(
		"Your assigned cases setting won't change",
	);
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	expect(await savedModule(page)).toEqual(before);
	await expect(remove).toBeFocused();
	await remove.click();
	await dialog.getByRole("button", { name: "Remove", exact: true }).click();
	await expect(
		composer.getByRole("button", { name: "Add condition", exact: true }),
	).toBeFocused();
	const after = await savedModule(page);
	expect(after.caseSearchConfig).toEqual(before.caseSearchConfig);
	const { filter: cleared, ...expected } = before.caseListConfig;
	expect(cleared).toBeDefined();
	// The Device list surface is the one cleared: the online search keeps
	// the condition it sent, now stored as its own.
	expect(after.caseListConfig).toEqual({
		...expected,
		searchCondition: cleared,
	});
	await page.getByRole("button", { name: "Search", exact: true }).click();
	await expect(
		page.getByText("Search is available from Results", { exact: true }),
	).toBeVisible();
});

test("a menu can send its existing answer and a named value to a project space and switch back", async ({
	page,
}) => {
	await page.goto(`${peer.origin}?scenario=search`);
	const [original] = (await savedModule(page)).caseListConfig.searchInputs;
	await page
		.getByRole("button", { name: "Edit Search screen", exact: true })
		.click();
	const source = page.getByRole("combobox", { name: "Search source" });
	const chooseSource = async (name: string) => {
		await source.click();
		await page.getByRole("option", { name, exact: true }).click();
	};
	await chooseSource("New project space search");
	await expect(
		page.getByText("Any matching rules on those fields will be replaced.", {
			exact: false,
		}),
	).toBeVisible();
	await page
		.getByRole("textbox", { name: "Search name", exact: true })
		.fill("Clinic registry");
	const use = page.getByRole("button", { name: "Use this search" });
	await use.click();
	await expect(source).toContainText("Clinic registry");
	expect((await savedModule(page)).caseListConfig.searchInputs).toMatchObject([
		{
			kind: "parameter",
			uuid: original.uuid,
			name: original.name,
			sendAnswer: true,
		},
	]);
	await page
		.getByRole("textbox", { name: "Name sent to the search", exact: true })
		.fill("area");
	await page.getByRole("textbox", { name: "Value", exact: true }).fill("north");
	await page.getByRole("button", { name: "Add named value" }).click();
	expect(
		(await savedModule(page)).caseSearchConfig.projectSearch.defaults,
	).toMatchObject([{ name: "area" }]);
	await chooseSource("Ordinary case search");
	await use.click();
	await expect(
		page.getByText(
			/Choose the case property.*will search before switching back/,
		),
	).toBeVisible();
	await page
		.getByRole("combobox", { name: original.label, exact: true })
		.click();
	await page
		.getByRole("option", { name: original.property, exact: true })
		.click();
	await use.click();
	await expect(source).toContainText("Ordinary case search");
	const saved = await savedModule(page);
	expect(saved.caseListConfig.searchInputs).toEqual([original]);
	expect(saved.caseSearchConfig?.projectSearch).toBeUndefined();
});

test("native Search screen copy clears overrides back to visible defaults and states the button's fixed text", async ({
	page,
}) => {
	await page.goto(`${peer.origin}?scenario=search`);
	await page
		.getByRole("button", { name: "Edit Search screen", exact: true })
		.click();
	const title = page.getByRole("textbox", { name: "Title", exact: true });
	await expect(title).toHaveValue("Search");
	// The button's text is CommCare HQ's own, so the rail states it and
	// offers nothing to edit.
	await expect(
		page.getByText("The search button reads “Search All Cases” in every", {
			exact: false,
		}),
	).toBeVisible();
	await expect(
		page.getByRole("textbox", { name: "Search button label", exact: true }),
	).toHaveCount(0);
	await title.fill("Find clients");
	await title.blur();
	expect((await savedModule(page)).caseSearchConfig.searchScreenTitle).toBe(
		"Find clients",
	);
	await title.fill("");
	await title.blur();
	await expect(title).toHaveValue("Search");
	expect((await savedModule(page)).caseSearchConfig).toBeUndefined();
	expect((await savedModule(page)).caseListConfig.searchInputs).toHaveLength(1);
	await page
		.getByRole("button", { name: "Close properties", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Edit Search screen", exact: true }),
	).toBeFocused();
});
test("native zero-input Search action becomes intentional only when its settings are opened", async ({
	page,
}) => {
	await page.goto(peer.origin);
	expect((await savedModule(page)).caseSearchConfig).toBeUndefined();
	await page.getByRole("button", { name: "Search", exact: true }).click();
	const configure = page.getByRole("button", {
		name: "Change when people continue",
		exact: true,
	});
	await configure.press("Enter");
	// A Search with no field opens the menu on Results first
	// (`withWorkflowAfterInputChange`).
	expect((await savedModule(page)).caseSearchConfig).toEqual({
		workflow: "skipToResults",
	});
	expect((await savedModule(page)).caseListConfig.searchInputs).toEqual([]);
	await expect(
		page.getByRole("textbox", { name: "Title", exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("heading", {
			name: "Results can open automatically",
			exact: true,
		}),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Close properties", exact: true })
		.click();
	await expect(configure).toBeFocused();
});
test("native hidden Search creation persists its computed value and keeps visible fields separate", async ({
	page,
}) => {
	await page.goto(`${peer.origin}?scenario=search`);
	const before = (await savedModule(page)).caseListConfig.searchInputs;
	await page
		.getByRole("combobox", { name: "Add search field", exact: true })
		.click();
	await page.getByRole("option", { name: /^Hidden value/ }).click();
	const after = (await savedModule(page)).caseListConfig.searchInputs;
	expect(after).toHaveLength(2);
	expect(after[0]).toEqual(before[0]);
	expect(after[1]).toMatchObject({
		kind: "hidden",
		name: "search_time",
		value: { kind: "now" },
	});
	expect(after[1].uuid).not.toBe(before[0].uuid);
	await expect(
		page.locator(`[data-case-search-field="${after[1].uuid}"]`),
	).toContainText("Hidden");
	await expect(
		page.getByRole("button", { name: /Search field 2 type:/ }),
	).toHaveCount(0);
});

test("a worker list can show a blank value label and a signed overdue marker", async ({
	page,
}) => {
	await page.goto(peer.origin);
	const column = (id: string) =>
		page.locator(`[data-case-column-select="${id}"]`).first();
	const name = "00000000-0000-7000-8000-000000006001";
	const birth = "00000000-0000-7000-8000-000000006002";
	await column(name).click();
	await page
		.getByRole("button", { name: "Display as: Text", exact: true })
		.click();
	await page.getByRole("menuitem", { name: /^Value labels/ }).click();
	await page.getByRole("button", { name: "Add value", exact: true }).click();
	await page
		.getByRole("textbox", { name: "Value 1 display label", exact: true })
		.fill("Unspecified");
	await page.getByRole("button", { name: "Save value", exact: true }).click();
	await expect
		.poll(
			async () => (await savedModule(page)).caseListConfig.columns[0].mapping,
		)
		.toEqual([{ uuid: expect.any(String), value: "", label: "Unspecified" }]);
	await page
		.getByRole("button", { name: "Close properties", exact: true })
		.click();
	await column(birth).click();
	await page
		.getByRole("button", { name: "Display as: Text", exact: true })
		.click();
	await page.getByRole("menuitem", { name: /^Overdue marker/ }).click();
	const threshold = page.getByRole("spinbutton", {
		name: "Days after the date",
	});
	await threshold.fill("-2");
	await threshold.press("Tab");
	await expect
		.poll(
			async () => (await savedModule(page)).caseListConfig.columns[1].afterDays,
		)
		.toBe(-2);
});

test("native Value labels refuses a saved value CommCare HQ's ID mapping can't hold and adds no entry", async ({
	page,
}) => {
	await page.goto(peer.origin);
	await page
		.locator('[data-case-column-select="00000000-0000-7000-8000-000000006001"]')
		.first()
		.click();
	await page
		.getByRole("button", { name: "Display as: Text", exact: true })
		.click();
	await page.getByRole("menuitem", { name: /^Value labels/ }).click();
	await page.getByRole("button", { name: "Add value", exact: true }).click();
	await page
		.getByRole("textbox", { name: "Value 1 saved value", exact: true })
		.fill("a'b");
	await expect(
		page.getByText(`Saved values can't hold &, <, >, " or '.`, {
			exact: true,
		}),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Save value", exact: true }),
	).toBeDisabled();
	const saved = (await savedModule(page)).caseListConfig.columns.find(
		(c: { uuid: string }) => c.uuid === "00000000-0000-7000-8000-000000006001",
	);
	expect(saved).toMatchObject({ kind: "id-mapping", mapping: [] });
});

test("native default order withholds Record ID from a tile list with the reason a commit would give", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=selection`);
	const before = (await savedModule(page)).caseListConfig;
	await page
		.getByRole("button", { name: "Set default order", exact: true })
		.press("Enter");
	await page
		.getByRole("combobox", { name: "Add to default order", exact: true })
		.click();
	const recordId = page.getByRole("option", { name: /^Record ID/ });
	await expect(recordId).toHaveAttribute("aria-disabled", "true");
	await expect(recordId).toContainText(
		"tile list can't order by Record ID unless Record ID is on the tile. You can show it in Results and place it on the tile.",
	);
	// The choice keeps its place and its reason; choosing it commits nothing.
	await recordId.click({ force: true });
	await expect(recordId).toBeVisible();
	expect((await savedModule(page)).caseListConfig).toEqual(before);
	await page.keyboard.press("Escape");
});

const DOB_SELECT =
	'[data-case-column-select="00000000-0000-7000-8000-000000006002"]';

function savedDob(module: { caseListConfig: { columns: { uuid: string }[] } }) {
	return module.caseListConfig.columns.find(
		(column) => column.uuid === "00000000-0000-7000-8000-000000006002",
	);
}

test("native List search matches this takes a hidden field off the list, and Default order brings it back by layout", async ({
	page,
}) => {
	await page.goto(peer.origin);
	// Hide Birth date from Results; Details still shows it.
	await page.locator(DOB_SELECT).first().click();
	await page
		.getByRole("button", { name: "Hide from Results", exact: true })
		.click();
	await page.getByRole("button", { name: "Details", exact: true }).click();
	await page.locator(DOB_SELECT).first().click();
	const listSearch = page.getByRole("switch", {
		name: /^List search matches this/,
	});
	await expect(listSearch).toBeChecked();
	await expect(
		page.getByText(
			"People filtering the list can find a case by this, though the list doesn't show it.",
		),
	).toBeVisible();
	await listSearch.click();
	await expect(listSearch).not.toBeChecked();
	await expect(
		page.getByText(
			"Only Details shows this. The list doesn't search or sort by it.",
		),
	).toBeVisible();
	expect(savedDob(await savedModule(page))).toMatchObject({
		visibleInList: false,
		notOnList: true,
	});

	// In a list with no tile, Default order lists the field disabled, with
	// the line that names the switch.
	await page.getByRole("button", { name: "Results", exact: true }).click();
	await page
		.getByRole("button", { name: "Set default order", exact: true })
		.press("Enter");
	const add = page.getByRole("combobox", {
		name: "Add to default order",
		exact: true,
	});
	await add.click();
	const birthDate = page.getByRole("option", { name: /^Birth date/ });
	await expect(birthDate).toHaveAttribute("aria-disabled", "true");
	await expect(birthDate).toContainText(
		"This isn't on the list, so the list can't sort by it. You can turn on List search matches this to sort by it.",
	);
	await birthDate.click({ force: true });
	expect(savedDob(await savedModule(page))).not.toHaveProperty("sort");
	await page.keyboard.press("Escape");

	// Turned on again, the field is on the list, so Default order takes it,
	// and while it sorts the switch is on and disabled with its reason.
	await page.getByRole("button", { name: "Details", exact: true }).click();
	await page.locator(DOB_SELECT).first().click();
	await listSearch.click();
	await expect(listSearch).toBeChecked();
	expect(savedDob(await savedModule(page))).not.toHaveProperty("notOnList");
	await page.getByRole("button", { name: "Results", exact: true }).click();
	await add.click();
	await page.getByRole("option", { name: /^Birth date/ }).click();
	expect(savedDob(await savedModule(page))).toMatchObject({
		visibleInList: false,
		sort: { direction: "asc", priority: 0 },
	});
	await page.getByRole("button", { name: "Details", exact: true }).click();
	await page.locator(DOB_SELECT).first().click();
	await expect(listSearch).toBeChecked();
	await expect(listSearch).toBeDisabled();
	await expect(
		page.getByText(
			"The list sorts by this, so its search matches it too. You can remove it from Default order to change that.",
		),
	).toBeVisible();
});

test("native Default order offers a tile list's field that is off the list and puts it back on, hidden, with its rule", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=tile-off-list`);
	await page
		.getByRole("button", { name: "Set default order", exact: true })
		.press("Enter");
	await page
		.getByRole("combobox", { name: "Add to default order", exact: true })
		.click();
	const birthDate = page.getByRole("option", { name: /^Birth date/ });
	await expect(birthDate).not.toHaveAttribute("aria-disabled", "true");
	await birthDate.click();
	const saved = savedDob(await savedModule(page));
	expect(saved).toMatchObject({
		visibleInList: false,
		sort: { direction: "asc", priority: 0 },
	});
	expect(saved).not.toHaveProperty("notOnList");
	// A tile list shows no switch: its search matches a hidden field only
	// through its sort row.
	await page.getByRole("button", { name: "Details", exact: true }).click();
	await page.locator(DOB_SELECT).first().click();
	await expect(
		page.getByRole("switch", { name: /^List search matches this/ }),
	).toHaveCount(0);
});

test("a column shows information of the case above the listed one", async ({
	page,
}) => {
	await page.goto(`${peer.origin}?scenario=related`);
	await page
		.locator('[data-case-column-select="00000000-0000-7000-8000-000000006001"]')
		.first()
		.click();
	const from = page.getByRole("combobox", {
		name: "Read information from",
		exact: true,
	});
	await expect(from).toHaveText(/This case/);
	await from.click();
	await page
		.getByRole("option", { name: "The household above it", exact: true })
		.click();
	await expect(from).toHaveText(/The household above it/);
	// The household has a name too, so the column keeps reading case_name, now
	// the household's.
	await page
		.getByRole("button", { name: "Leave workspace", exact: true })
		.click();
	const saved = await savedModule(page);
	const column = saved.caseListConfig.columns.find(
		(one: { uuid: string }) =>
			one.uuid === "00000000-0000-7000-8000-000000006001",
	);
	expect(column).toMatchObject({
		field: "case_name",
		via: [{ identifier: "parent" }],
	});
});

test("a column follows an older case link and keeps its stored property name", async ({
	page,
}) => {
	await page.goto(`${peer.origin}?scenario=related`);
	await page
		.locator('[data-case-column-select="00000000-0000-7000-8000-000000006001"]')
		.first()
		.click();
	const from = page.getByRole("combobox", { name: "Read information from" });
	await from.click();
	await page.getByRole("option", { name: "Choose another link" }).click();
	await page.getByLabel("Link name on the case").fill("historic-site");
	await page.getByRole("button", { name: "Use this link" }).click();
	await expect(from).toHaveText(/historic-site/);
	await page.getByRole("button", { name: /^Information from:/ }).click();
	await page.getByRole("menuitem", { name: "Use a property by name" }).click();
	await page
		.getByLabel("Property name on the related case")
		.fill("outreach_status");
	await page.getByRole("button", { name: "Use this property" }).click();
	await expect(
		page.getByRole("button", { name: /^Information from:/ }),
	).toContainText(/outreach status/i);
	await page
		.getByRole("button", { name: "Leave workspace", exact: true })
		.click();
	expect(
		(await savedModule(page)).caseListConfig.columns.find(
			(one: { uuid: string }) =>
				one.uuid === "00000000-0000-7000-8000-000000006001",
		),
	).toMatchObject({
		field: "outreach_status",
		via: [{ identifier: "historic-site" }],
	});
});

test("a case column can show who owns the worker’s own record", async ({
	page,
}) => {
	await page.goto(`${peer.origin}?scenario=related`);
	const columnUuid = "00000000-0000-7000-8000-000000006001";
	await page
		.locator(`[data-case-column-select="${columnUuid}"]`)
		.first()
		.click();
	const source = page.getByRole("combobox", { name: "Read information from" });
	await source.click();
	await page
		.getByRole("option", { name: "The worker’s record", exact: true })
		.click();
	await expect(source).toHaveText("The worker’s record");
	await page.getByRole("button", { name: /^Information from:/ }).click();
	await page.getByRole("menuitem", { name: /^Owner(?:\s|$)/ }).click();
	await page.getByRole("combobox", { name: "Show owner as" }).click();
	await page.getByRole("option", { name: "Name", exact: true }).click();
	await page
		.getByRole("button", { name: "Leave workspace", exact: true })
		.click();
	const module = await savedModule(page);
	expect(
		module.caseListConfig.columns.find(
			(column: { uuid: string }) => column.uuid === columnUuid,
		),
	).toMatchObject({
		field: "owner_id",
		readFrom: "worker-record",
		showOwner: "name",
	});
});
