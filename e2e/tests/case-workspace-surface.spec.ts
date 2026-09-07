import { resolve } from "node:path";
import type { Page, Route } from "@playwright/test";
import { componentPeer } from "../lib/componentPeer";
import { expect, test } from "../lib/fixtures";

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

async function savedModule(page: Page) {
	return JSON.parse(
		(await page.getByLabel("Saved module").textContent()) ?? "null",
	);
}
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
	await page.keyboard.press("Escape");
	await expect(trigger).toBeFocused();
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
	await expect(dialog).toContainText("custom Search action label will stay");
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
	expect(after.caseSearchConfig).toEqual({
		excludedOwnerIds: before.caseSearchConfig.excludedOwnerIds,
		searchButtonLabel: "Find",
	});
	await expect(
		page.getByText("Search is available from Results", { exact: true }),
	).toBeVisible();
});
test("native Search date-range conversion keeps the saved default until confirmation", async ({
	page,
}) => {
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
	await expect(
		page.getByRole("button", { name: /starting value for search field/ }),
	).toHaveCount(0);
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
	const activeBody = page.locator("[data-case-workspace-scroll-body]:visible");
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

async function capturedFilterPeer(page: Page) {
	const pending: Route[] = [];
	const owned = new Set<Route>();
	const requests: unknown[] = [];
	await page.route("**/native/filter-preview", (route) => {
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
			await page.unrouteAll({ behavior: "wait" });
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
	const { filter: ignored, ...expected } = before.caseListConfig;
	expect(ignored).toBeDefined();
	expect(after.caseListConfig).toEqual(expected);
	await page.getByRole("button", { name: "Search", exact: true }).click();
	await expect(
		page.getByText("Search is available from Results", { exact: true }),
	).toBeVisible();
});

test("native Search screen copy preserves long refused drafts and clears overrides back to visible defaults", async ({
	page,
}) => {
	await page.goto(`${peer.origin}?scenario=search`);
	await page
		.getByRole("button", { name: "Edit Search screen", exact: true })
		.click();
	const title = page.getByRole("textbox", { name: "Title", exact: true });
	const label = page.getByRole("textbox", {
		name: "Search button label",
		exact: true,
	});
	await expect(title).toHaveValue("Search");
	await expect(label).toHaveValue("Search");
	await title.fill("Find clients");
	await label.click();
	expect((await savedModule(page)).caseSearchConfig.searchScreenTitle).toBe(
		"Find clients",
	);
	const tooLong = "Find every possible matching client case right now";
	await label.fill(tooLong);
	await title.click();
	await expect(label).toHaveValue(tooLong);
	await expect(label).toHaveAttribute("aria-invalid", "true");
	await expect(page.getByRole("alert")).toContainText(
		"Keep the label to 32 characters or fewer",
	);
	expect(
		(await savedModule(page)).caseSearchConfig.searchButtonLabel,
	).toBeUndefined();
	await label.fill("Find cases");
	await title.click();
	expect((await savedModule(page)).caseSearchConfig.searchButtonLabel).toBe(
		"Find cases",
	);
	await title.fill("");
	await label.click();
	await expect(title).toHaveValue("Search");
	await label.fill("Search");
	await title.click();
	expect((await savedModule(page)).caseSearchConfig).toBeUndefined();
	await expect(title).toHaveValue("Search");
	await expect(label).toHaveValue("Search");
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
	expect((await savedModule(page)).caseSearchConfig).toEqual({});
	expect((await savedModule(page)).caseListConfig.searchInputs).toEqual([]);
	await expect(
		page.getByRole("textbox", { name: "Title", exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByText("Search is available from Results", { exact: true }),
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
