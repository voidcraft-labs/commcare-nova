import { resolve } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { componentPeer } from "../lib/componentPeer";
import { expect, test } from "../lib/fixtures";

let peer: Awaited<ReturnType<typeof componentPeer>>;
test.use({ actionTimeout: 10_000 });
test.beforeAll(async () => {
	peer = await componentPeer(
		"e2e/lib/builder-controls-client.tsx",
		[
			{
				path: "/component/case-write-verdict.worker.ts",
				entryPoint: "lib/doc/case-write-verdict.worker.ts",
			},
		],
		{
			"@/lib/organization/actions": resolve(
				"e2e/lib/builder-workflows-boundary.ts",
			),
			"@/lib/lookup/actions": resolve("e2e/lib/builder-workflows-boundary.ts"),
		},
	);
});
test.afterAll(async () => {
	await peer?.close();
});

async function height(locator: Locator) {
	const box = await locator.boundingBox();
	expect(box).not.toBeNull();
	return Math.round(box?.height ?? 0);
}
async function settleGeometry(locator: Locator) {
	await expect(locator).not.toHaveAttribute("data-starting-style", "");
	await expect
		.poll(() =>
			locator.evaluate((element) => {
				const transform = getComputedStyle(element).transform;
				const matrix =
					transform === "none" ? new DOMMatrix() : new DOMMatrix(transform);
				return [matrix.a, matrix.d];
			}),
		)
		.toEqual([1, 1]);
	await locator.evaluate(async (element) => {
		await Promise.all(
			element
				.getAnimations({ subtree: true })
				.map((animation) => animation.finished),
		);
	});
}
async function contained(locator: Locator, width: number) {
	const geometry = await locator.evaluate((element) => {
		const rect = element.getBoundingClientRect();
		return {
			left: rect.left,
			right: rect.right,
			overflow: element.scrollWidth - element.clientWidth,
		};
	});
	expect(geometry.left).toBeGreaterThanOrEqual(0);
	expect(geometry.right).toBeLessThanOrEqual(width);
	expect(geometry.overflow).toBeLessThanOrEqual(1);
}

test("case target calculation stays local across the actual rail and canvas until admitted", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1400, height: 1100 });
	await page.goto(`${peer.origin}/?scenario=case-target`);
	const settings = page.getByRole("region", { name: "Case change settings" });
	const canvas = page.getByRole("region", { name: "Case change canvas" });
	const saved = page.getByLabel("Saved case changes");
	const original = await saved.innerText();
	await expect(page.getByLabel("Can undo case change")).toHaveText("false");
	await page.getByRole("button", { name: /^Unavailable calculation:/ }).click();
	const unavailable = page.getByRole("menuitem", {
		name: /A case found by a calculation/,
	});
	await expect(unavailable).toBeDisabled();
	await expect(unavailable).toContainText(
		"This screen cannot start a case-id calculation",
	);
	await page.keyboard.press("Escape");
	await expect(saved).toHaveText(original);
	const picker = settings.getByRole("button", { name: /^Which case:/ });
	await picker.click();
	await page
		.getByRole("menuitem", { name: /A case found by a calculation/ })
		.click();
	await expect(
		canvas.getByText("Which case to change", { exact: true }),
	).toBeVisible();
	const value = canvas.getByRole("textbox", { name: "Text value" });
	await expect(value).toHaveValue("");
	await expect(saved).toHaveText(original);
	await expect(page.getByLabel("Can undo case change")).toHaveText("false");
	await canvas.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(value).toHaveCount(0);
	await expect(saved).toHaveText(original);
	await picker.click();
	await page
		.getByRole("menuitem", { name: /A case found by a calculation/ })
		.click();
	await value.fill("patient-case-42");
	await page.getByRole("button", { name: "Leave case change" }).click();
	await expect
		.poll(async () => JSON.parse(await saved.innerText())[0].target)
		.toEqual({
			kind: "expression",
			expr: {
				kind: "term",
				term: { kind: "literal", value: "patient-case-42" },
			},
		});
	await expect(page.getByLabel("Can undo case change")).toHaveText("true");
	await expect(
		canvas.getByRole("button", { name: "Cancel", exact: true }),
	).toHaveCount(0);
	const committed = await saved.innerText();
	await picker.click();
	await page
		.getByRole("menuitem", { name: /A case found by a calculation/ })
		.click();
	await expect(saved).toHaveText(committed);
});

test("carried values use real single-case admission and retain native confirmation focus", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=carry-single`);
	const saved = page.getByLabel("Saved carried link");
	const original = await saved.innerText();
	await page.getByRole("button", { name: /Work it out here/ }).click();
	await expect
		.poll(async () => JSON.parse(await saved.innerText()).datums)
		.toEqual([
			{
				name: "case_id",
				xpath: { parts: [{ kind: "text", text: "''" }] },
			},
		]);
	const automatic = page.getByRole("button", {
		name: /^Carry it automatically/,
	});
	await automatic.click();
	const cancel = page.getByRole("button", { name: "Cancel", exact: true });
	await expect(cancel).toBeVisible();
	await cancel.click();
	await expect(automatic).toBeFocused();
	await expect
		.poll(async () => "datums" in JSON.parse(await saved.innerText()))
		.toBe(true);
	await automatic.click();
	await page
		.getByRole("button", { name: "Carry it automatically", exact: true })
		.click();
	await expect(saved).toHaveText(original);
	await expect(automatic).toBeFocused();
});

test("carried values with a complete case selection withhold scalar manual editing", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=carry-multiple`);
	await expect(
		page.getByText(/carries the selected cases automatically/i),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Work it out here/ }),
	).toHaveCount(0);
	await expect(page.getByRole("textbox")).toHaveCount(0);
	await expect
		.poll(
			async () =>
				"datums" in
				JSON.parse(await page.getByLabel("Saved carried link").innerText()),
		)
		.toBe(false);
});

for (const width of [320, 768]) {
	test(`calendar uses native date selection and contains full-height controls at ${width}px`, async ({
		page,
	}) => {
		await page.setViewportSize({ width, height: 900 });
		await page.goto(`${peer.origin}/?scenario=calendar`);
		const plain = page.getByRole("region", { name: "Plain calendar" });
		const first = plain.getByRole("button", {
			name: /Wednesday, January 1st, 2025/i,
		});
		await expect(first).toBeVisible();
		expect(await height(first)).toBeGreaterThanOrEqual(44);
		for (const label of [/previous month/i, /next month/i])
			expect(
				await height(plain.getByRole("button", { name: label })),
			).toBeGreaterThanOrEqual(44);
		await first.focus();
		await page.keyboard.press("ArrowRight");
		await expect(
			plain.getByRole("button", { name: /Thursday, January 2nd, 2025/i }),
		).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(page.getByLabel("Selected date")).toHaveText("2025-01-02");
		await plain.getByRole("button", { name: /next month/i }).click();
		await expect(plain).toContainText("February 2025");
		const week = page.getByRole("region", { name: "Week calendar" });
		const dropdowns = week.getByRole("combobox");
		await expect(dropdowns).toHaveCount(2);
		for (const dropdown of await dropdowns.all())
			expect(await height(dropdown)).toBeGreaterThanOrEqual(44);
		await contained(plain, width);
		await contained(week, width);
	});
}

test("dialog portals preserve direction, fit long authored copy and return native focus", async ({
	page,
}) => {
	await page.setViewportSize({ width: 320, height: 620 });
	await page.goto(`${peer.origin}/?scenario=dialog`);
	const trigger = page.getByRole("button", {
		name: "Open dialog",
		exact: true,
	});
	await trigger.click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toHaveAttribute("dir", "rtl");
	await settleGeometry(dialog);
	await contained(dialog, 320);
	const close = dialog.getByRole("button", { name: "Close", exact: true });
	expect(await height(close)).toBeGreaterThanOrEqual(44);
	const titleBox = await dialog.getByRole("heading").boundingBox();
	const closeBox = await close.boundingBox();
	expect(titleBox).not.toBeNull();
	expect(closeBox).not.toBeNull();
	expect((titleBox?.x ?? 0) + (titleBox?.width ?? 0)).toBeLessThanOrEqual(
		closeBox?.x ?? 0,
	);
	for (const name of ["Cancel", "Use connection"])
		expect(
			await height(dialog.getByRole("button", { name, exact: true })),
		).toBeGreaterThanOrEqual(44);
	await dialog.getByRole("button", { name: "Open nested popover" }).click();
	const popup = page.locator('[data-slot="popover-content"]');
	await expect(popup).toHaveAttribute("dir", "rtl");
	expect(await popup.evaluate((node) => getComputedStyle(node).direction)).toBe(
		"rtl",
	);
	await popup.getByRole("button", { name: "Choose nested action" }).click();
	await expect(page.getByLabel("Nested selection")).toHaveText("popover");
	await page.keyboard.press("Escape");
	await expect(popup).toHaveCount(0);
	await dialog.getByRole("combobox", { name: "Nested choice" }).click();
	await page.getByRole("option", { name: "Nested value", exact: true }).click();
	await expect(page.getByLabel("Nested selection")).toHaveText("selected");
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(trigger).toBeFocused();
	await page.getByRole("button", { name: "Open confirmation" }).click();
	const alert = page.getByRole("alertdialog");
	await expect(alert).toBeVisible();
	await settleGeometry(alert);
	await contained(alert, 320);
	const cancel = alert.getByRole("button", { name: "Cancel" });
	const actionTops = await alert
		.getByRole("button")
		.evaluateAll((buttons) =>
			buttons.map((button) => button.getBoundingClientRect().top),
		);
	expect(actionTops).toHaveLength(2);
	expect(Math.abs(actionTops[0] - actionTops[1])).toBeLessThan(2);
	expect(await height(cancel)).toBeGreaterThanOrEqual(44);
	await cancel.click();
	await expect(alert).toHaveCount(0);
});

test("select resolves labels, wraps authored values and skips disabled combobox choices", async ({
	page,
}) => {
	await page.goto(peer.origin);
	const compact = page.getByRole("combobox", { name: "Compact status" });
	const wrapping = page.getByRole("combobox", { name: "Wrapping status" });
	await expect(compact).toHaveText("Needs review");
	expect(await height(compact)).toBe(44);
	await wrapping.click();
	await page.getByRole("option", { name: /ThisIsAnAuthoredName/ }).click();
	expect(await height(wrapping)).toBeGreaterThan(44);
	expect(await height(compact)).toBe(44);
	await contained(wrapping, 1280);
	const input = page.getByRole("combobox", { name: "Choose information" });
	await input.click();
	await input.press("ArrowDown");
	const unavailable = page.getByRole("option", {
		name: "Unavailable",
		exact: true,
	});
	await expect(unavailable).toHaveAttribute("aria-disabled", "true");
	expect(
		await unavailable.evaluate(
			(element) => getComputedStyle(element).pointerEvents,
		),
	).not.toBe("none");
	await unavailable.hover();
	expect(
		await unavailable.evaluate((element) => getComputedStyle(element).cursor),
	).toBe("not-allowed");
	await input.press("Home");
	await input.press("ArrowDown");
	await input.press("Enter");
	await expect(input).not.toHaveValue("Unavailable");
});

test("input groups own one native focus ring and a disabled send action does not dim their text", async ({
	page,
}) => {
	await page.goto(peer.origin);
	for (const [label, id] of [
		["Name", "text-group"],
		["Message", "message-group"],
	]) {
		const input = page.getByRole("textbox", { name: label });
		await input.focus();
		const group = page.getByTestId(id);
		await expect(input).toBeFocused();
		expect(
			await group.evaluate((element) => getComputedStyle(element).opacity),
		).toBe("1");
		expect(
			await group.evaluate((element) => getComputedStyle(element).boxShadow),
		).not.toBe("none");
		const inputShadow = await input.evaluate(
			(element) => getComputedStyle(element).boxShadow,
		);
		expect(
			inputShadow === "none" ||
				!/[1-9]/.test(inputShadow.replace(/rgba?\([^)]+\)/g, "")),
		).toBe(true);
	}
});

test("real React row identity preserves local drafts across document clones and duplicate moves", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=identity`);
	const second = page.getByRole("textbox", { name: "Row 2" });
	await second.fill("uncommitted second occurrence");
	const handle = await second.elementHandle();
	expect(handle).not.toBeNull();
	try {
		await page.getByRole("button", { name: "Clone document" }).click();
		await expect(second).toHaveValue("uncommitted second occurrence");
		expect(await handle?.evaluate((node) => node.isConnected)).toBe(true);
		await page.getByRole("button", { name: "Move row 2 to start" }).click();
		await expect(page.getByRole("textbox", { name: "Row 1" })).toHaveValue(
			"uncommitted second occurrence",
		);
		expect(
			await handle?.evaluate(
				(node) =>
					node.isConnected && node.getAttribute("aria-label") === "Row 1",
			),
		).toBe(true);
		await expect(page.getByRole("textbox", { name: "Row 2" })).toHaveValue(
			"same",
		);
	} finally {
		await handle?.dispose();
	}
});

test("expression replacement cancels without mutation, confirms once and restores focus after replacing the trigger", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=expression`);
	const source = page.getByRole("button", { name: "Value source: A value" });
	const authored = page.getByLabel("Authored value");
	const original = await authored.textContent();
	await source.click();
	await page.getByRole("menuitem", { name: /^Math/ }).click();
	await expect(page.getByRole("alertdialog")).toBeVisible();
	await expect(page.getByLabel("Commit count")).toHaveText("0");
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(source).toBeFocused();
	await expect(authored).toHaveText(original ?? "");
	await source.click();
	await page.getByRole("menuitem", { name: /^Math/ }).click();
	await page.getByRole("button", { name: "Replace", exact: true }).click();
	await expect(page.getByRole("alertdialog")).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Change value type" }).first(),
	).toBeFocused();
	await expect(page.getByLabel("Commit count")).toHaveText("1");
	expect(JSON.parse((await authored.textContent()) ?? "null").kind).toBe(
		"arith",
	);
});

test("condition changes explain authored pattern loss before committing", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=pattern`);
	const authored = page.getByLabel("Authored condition");
	const original = await authored.textContent();
	const verb = page.getByRole("button", {
		name: /^Condition matches a pattern/i,
	});
	await verb.click();
	await page.getByRole("menuitem", { name: /^is blank/i }).click();
	const confirmation = page.getByRole("alertdialog");
	await expect(confirmation).toContainText("the text pattern");
	await expect(page.getByLabel("Commit count")).toHaveText("0");
	await confirmation.getByRole("button", { name: "Cancel" }).click();
	await expect(authored).toHaveText(original ?? "");
	await expect(verb).toBeFocused();
	await verb.click();
	await page.getByRole("menuitem", { name: /^is blank/i }).click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: /Replace|Change/ })
		.click();
	await expect(page.getByLabel("Commit count")).toHaveText("1");
	expect(JSON.parse((await authored.textContent()) ?? "null").kind).toBe(
		"is-blank",
	);
});

test("connection removal explains rebinding, commits once and leaves a usable focus target", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=relation`);
	const remove = page.getByRole("button", {
		name: "Remove connection from Visit to Patient",
	});
	await remove.click();
	const confirmation = page.getByRole("alertdialog");
	await expect(confirmation).toContainText("Patient instead of Household");
	await confirmation.getByRole("button", { name: "Cancel" }).click();
	await expect(remove).toBeFocused();
	await expect(page.getByLabel("Commit count")).toHaveText("0");
	await remove.click();
	await page
		.getByRole("button", { name: "Remove connection", exact: true })
		.click();
	await expect(page.getByLabel("Commit count")).toHaveText("1");
	expect(
		JSON.parse(
			(await page.getByLabel("Authored connection").textContent()) ?? "null",
		),
	).toEqual({
		kind: "ancestor",
		via: [{ identifier: "parent", throughCaseType: "patient" }],
	});
	await expect(
		page.getByRole("button", { name: "More settings" }),
	).toBeFocused();
});

test("custom connection directions retain destinations and name drafts commit on Enter once", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=custom-relation`);
	const direction = page.getByRole("combobox", { name: "Where to look" });
	await direction.click();
	await page.getByRole("option", { name: /^Any related case/ }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(page.getByRole("alertdialog")).toHaveCount(0);
	const authored = page.getByLabel("Authored connection");
	expect(JSON.parse((await authored.textContent()) ?? "null")).toEqual({
		kind: "any-relation",
		identifier: "host",
		ofCaseType: "household",
	});
	await direction.click();
	await page.getByRole("option", { name: /^Child case/ }).click();
	await expect(page.getByLabel("Commit count")).toHaveText("2");
	expect(JSON.parse((await authored.textContent()) ?? "null")).toEqual({
		kind: "subcase",
		identifier: "host",
		ofCaseType: "household",
	});
	await page.getByRole("button", { name: "More settings" }).click();
	const name = page.getByRole("textbox", { name: "Connection name" });
	await name.fill("not-valid");
	await name.press("Tab");
	await expect(page.getByRole("alert")).toContainText(
		"letters, numbers, and underscores",
	);
	await expect(page.getByLabel("Commit count")).toHaveText("2");
	await name.fill("guardian_link");
	await name.press("Enter");
	await expect(page.getByLabel("Commit count")).toHaveText("3");
	expect(JSON.parse((await authored.textContent()) ?? "null")).toEqual({
		kind: "subcase",
		identifier: "guardian_link",
		ofCaseType: "household",
	});
});

test("property editing retains explicit self relation and list removal transfers native focus", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=property`);
	await page.getByRole("button", { name: /^Case information:/ }).click();
	await page.getByRole("menuitem", { name: /^Age/i }).click();
	await expect(page.getByLabel("Commit count")).toHaveText("1");
	const condition = JSON.parse(
		(await page.getByLabel("Authored condition").textContent()) ?? "null",
	);
	expect(condition.left.term).toEqual({
		kind: "prop",
		caseType: "patient",
		property: "age",
		via: { kind: "self" },
	});
	await page.goto(`${peer.origin}/?scenario=membership`);
	const actions = page.getByRole("button", {
		name: "Remove value",
		exact: true,
	});
	const survivor = await actions.nth(1).elementHandle();
	try {
		await actions.first().click();
		await expect(actions).toHaveCount(2);
		await expect(page.getByLabel("Commit count")).toHaveText("1");
		expect(
			await survivor?.evaluate((element) => element === document.activeElement),
		).toBe(true);
	} finally {
		await survivor?.dispose();
	}
});

test("literal drafts refuse invalid integers and commit corrections with their type", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=literal`);
	const number = page.getByLabel("Whole number");
	await number.fill("7.5");
	await page.getByRole("button", { name: "Leave inputs" }).click();
	await expect(number).toHaveAttribute("aria-invalid", "true");
	await expect(number).toHaveValue("7.5");
	await expect(page.getByLabel("Authored number")).toHaveText(
		'{"kind":"literal","value":7,"data_type":"int"}',
	);
	await number.fill("8");
	await page.getByRole("button", { name: "Leave inputs" }).click();
	await expect(number).not.toHaveAttribute("aria-invalid", "true");
	await expect(page.getByLabel("Authored number")).toHaveText(
		'{"kind":"literal","value":8,"data_type":"int"}',
	);
	const date = page.getByLabel("Visit date");
	await date.fill("2026-09-06");
	await page.getByRole("button", { name: "Leave inputs" }).click();
	await expect(page.getByLabel("Authored date")).toHaveText(
		'{"kind":"literal","value":"2026-09-06","data_type":"date"}',
	);
});
test("date pieces replace the native selection, return the caret and commit only complete patterns", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=date-pattern`);
	const input = page.getByLabel("Custom date style");
	await page.getByRole("button", { name: "Choose date pieces" }).click();
	await input.focus();
	await input.press("End");
	await input.press("Shift+ArrowLeft");
	await input.press("Shift+ArrowLeft");
	await page
		.getByRole("button", { name: "Insert month name, shown as July" })
		.click();
	await expect(input).toHaveValue("Visit %B");
	await expect(input).toBeFocused();
	expect(
		await input.evaluate(
			(element) => (element as HTMLInputElement).selectionStart,
		),
	).toBe(8);
	await expect(page.getByLabel("Authored date style")).toHaveText("Visit %Y");
	await input.press("Enter");
	await expect(page.getByLabel("Authored date style")).toHaveText("Visit %B");
	await input.fill("Visit %");
	await page.getByRole("button", { name: "Leave date style" }).click();
	await expect(input).toHaveAttribute("aria-invalid", "true");
	await expect(page.getByLabel("Authored date style")).toHaveText("Visit %B");
	await page.getByRole("button", { name: "Short date", exact: true }).click();
	await expect(page.getByLabel("Authored date style")).toHaveText("short");
	await expect(input).toHaveCount(0);
});
test("case type picker selects stored identities, rejects duplicates and creates natural names", async ({
	page,
}) => {
	await page.setViewportSize({ width: 320, height: 640 });
	await page.goto(`${peer.origin}/?scenario=case-type`);
	const trigger = page.getByRole("button", {
		name: "Case type: Client record",
	});
	await trigger.click();
	await contained(page.locator('[data-slot="popover-content"]'), 320);
	const draft = page.getByLabel("Create case type");
	await draft.fill("Client record");
	await expect(
		page.getByRole("button", { name: "Create", exact: true }),
	).toBeDisabled();
	await expect(draft).toHaveAttribute("aria-invalid", "true");
	await draft.press("Enter");
	await expect(page.getByLabel("Chosen case type")).toHaveText("client_record");
	await page.getByRole("button", { name: "Household", exact: true }).click();
	await expect(page.getByLabel("Chosen case type")).toHaveText("household");
	const selected = page.getByRole("button", { name: "Case type: Household" });
	await expect(selected).toBeFocused();
	await selected.click();
	await draft.fill("Home follow-up visit");
	await draft.press("Enter");
	await expect(page.getByLabel("Chosen case type")).toHaveText(
		"home_follow_up_visit",
	);
	await page
		.getByRole("button", { name: "Case type: Home follow up visit" })
		.click();
	await page.getByRole("button", { name: "Stop managing cases" }).click();
	await expect(page.getByLabel("Chosen case type")).toHaveText("None");
});

for (const { kind, row, remove, add, key } of [
	{
		kind: "concat",
		row: "value",
		remove: "Remove value",
		add: "Add value",
		key: "parts",
	},
	{
		kind: "coalesce",
		row: "fallback",
		remove: "Remove value",
		add: "Add another value",
		key: "values",
	},
	{
		kind: "switch",
		row: "choice",
		remove: "Remove choice",
		add: "Add choice",
		key: "cases",
	},
]) {
	test(`${kind} edits move actual rows, retain native focus and protect the final value`, async ({
		page,
	}) => {
		await page.goto(`${peer.origin}/?scenario=${kind}`);
		const second = page.getByRole("button", { name: `Move ${row} 2 of 3` });
		const originalSecond = await second.elementHandle();
		let nextRemove: Awaited<ReturnType<Locator["elementHandle"]>> | null = null;
		try {
			await second.focus();
			await second.press("Home");
			const first = page.getByRole("button", { name: `Move ${row} 1 of 3` });
			await expect(first).toBeFocused();
			expect(
				await first.evaluate(
					(element, original) => element === original,
					originalSecond,
				),
			).toBe(true);
			const moved = JSON.parse(
				await page.getByLabel("Authored list").innerText(),
			);
			expect(
				kind === "switch"
					? moved.cases.map(
							(item: { when: { value: number } }) => item.when.value,
						)
					: moved[key].map(
							(item: { term: { value: string } }) => item.term.value,
						),
			).toEqual(kind === "switch" ? [2, 1, 3] : ["second", "first", "third"]);
			await page.getByRole("button", { name: "Clone expression" }).click();
			expect(
				await first.evaluate(
					(element, original) => element === original,
					originalSecond,
				),
			).toBe(true);
			nextRemove = await page
				.getByRole("button", { name: remove, exact: true })
				.nth(1)
				.elementHandle();
			await page
				.getByRole("button", { name: remove, exact: true })
				.first()
				.click();
			expect(
				await page.evaluate(
					(element) => document.activeElement === element,
					nextRemove,
				),
			).toBe(true);
			await page
				.getByRole("button", { name: remove, exact: true })
				.first()
				.click();
			await expect(
				page.getByRole("button", { name: remove, exact: true }),
			).toHaveCount(0);
			const remaining = JSON.parse(
				await page.getByLabel("Authored list").innerText(),
			);
			expect(remaining[key]).toHaveLength(1);
			await page.getByRole("button", { name: add, exact: true }).click();
			const appended = JSON.parse(
				await page.getByLabel("Authored list").innerText(),
			);
			expect(appended[key]).toHaveLength(2);
			if (kind === "switch") {
				expect(appended.cases[1].when).toEqual({ kind: "literal", value: 0 });
				expect(appended.cases[1].then).toEqual({
					kind: "term",
					term: { kind: "literal", value: 0 },
				});
				expect(appended.on).toEqual(remaining.on);
				expect(appended.fallback).toEqual(remaining.fallback);
			}
		} finally {
			await Promise.all([originalSecond?.dispose(), nextRemove?.dispose()]);
		}
	});
}
test("clearing an invalid optional condition retires its validity and adding starts valid", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=optional-condition`);
	await expect(page.getByLabel("Condition validity")).toHaveText("false");
	await page.getByRole("button", { name: "Clear filter" }).click();
	await expect(page.getByLabel("Optional condition")).toHaveText("None");
	await expect(page.getByLabel("Condition validity")).toHaveText("true");
	await page.getByRole("button", { name: "Add filter" }).click();
	await expect(page.getByLabel("Optional condition")).toHaveText(
		'{"kind":"match-all"}',
	);
	await expect(page.getByLabel("Condition validity")).toHaveText("true");
});

for (const { kind, message } of [
	{ kind: "arith-error", message: "Choose a number" },
	{
		kind: "if-error",
		message: "Make every possible result use the same kind of information",
	},
]) {
	test(`${kind} renders one precise diagnostic and propagates corrected validity`, async ({
		page,
	}) => {
		await page.goto(`${peer.origin}/?scenario=${kind}`);
		await expect(page.getByLabel("Expression validity")).toHaveText("false");
		await expect(page.getByText(message, { exact: true })).toHaveCount(1);
		await expect(page.getByText(message, { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Load corrected value" }).click();
		await expect(page.getByLabel("Expression validity")).toHaveText("true");
		await expect(page.getByText(message, { exact: true })).toHaveCount(0);
	});
}
test("property search keeps full labels readable and selects the exact information identity", async ({
	page,
}) => {
	await page.setViewportSize({ width: 320, height: 640 });
	await page.goto(`${peer.origin}/?scenario=property-picker`);
	const trigger = page.getByRole("button", {
		name: /^Case information: Preferred follow up/,
	});
	await contained(trigger, 320);
	await trigger.click();
	const search = page.getByRole("searchbox", { name: "Search information" });
	await expect(search).toBeFocused();
	await contained(page.getByRole("menu"), 320);
	await search.fill("birth");
	await expect(
		page.getByRole("menuitem", { name: /Date of birth/ }),
	).toBeVisible();
	await expect(page.getByRole("menuitem", { name: /Telephone/ })).toHaveCount(
		0,
	);
	await search.fill("home_phone");
	await page.getByRole("menuitem", { name: /Telephone/ }).click();
	await expect(page.getByLabel("Selected information")).toHaveText(
		"home_phone",
	);
	const selected = page.getByRole("button", {
		name: "Case information: Telephone",
	});
	await expect(selected).toBeFocused();
	await selected.click();
	await expect(search).toHaveValue("");
	await search.fill("nothing-like-this");
	await expect(
		page.getByRole("status").filter({ hasText: "No matching information" }),
	).toContainText("No matching information");
	await page.getByRole("menuitem", { name: "Create a new question" }).click();
	await expect(page.getByLabel("Create requests")).toHaveText("1");
	await page.getByRole("button", { name: "Load missing information" }).click();
	await expect(
		page.getByRole("button", {
			name: "Case information: Unavailable information",
		}),
	).toBeVisible();
	await expect(
		page.getByLabel("This information is no longer available"),
	).toBeVisible();
});

test("numeric term accepts compatible decimals and retains malformed drafts", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=integer-term`);
	const number = page.getByLabel("Number value");
	await number.fill("7.5");
	await page.getByRole("button", { name: "Leave value" }).click();
	await expect(page.getByLabel("Saved integer term")).toHaveText(
		'{"kind":"term","term":{"kind":"literal","value":7.5}}',
	);
	await number.fill("7e");
	await page.getByRole("button", { name: "Leave value" }).click();
	await expect(number).toHaveAttribute("aria-invalid", "true");
	await expect(number).toHaveValue("7e");
	await expect(page.getByLabel("Saved integer term")).toHaveText(
		'{"kind":"term","term":{"kind":"literal","value":7.5}}',
	);
	await number.fill("8");
	await page.getByRole("button", { name: "Leave value" }).click();
	await expect(page.getByLabel("Saved integer term")).toHaveText(
		'{"kind":"term","term":{"kind":"literal","value":8}}',
	);
});

test("source replacement cancels with native focus and restores the complete saved connection", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=term-source`);
	const source = page.getByRole("button", {
		name: "Value source: Other case information",
	});
	const original = await page.getByLabel("Saved source").textContent();
	await source.click();
	await page.getByRole("menuitemradio", { name: /^A value/ }).click();
	const dialog = page.getByRole("alertdialog", {
		name: "Use a value instead?",
	});
	await expect(dialog).toContainText("and its connection");
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(source).toBeFocused();
	await expect(page.getByLabel("Source commits")).toHaveText("0");
	await source.click();
	await page.getByRole("menuitemradio", { name: /^A value/ }).click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Replace" })
		.click();
	const valueSource = page.getByRole("button", {
		name: "Value source: A value",
	});
	await expect(valueSource).toBeFocused();
	await expect(page.getByLabel("Saved source")).toHaveText(
		'{"kind":"term","term":{"kind":"literal","value":""}}',
	);
	await valueSource.click();
	await page
		.getByRole("menuitemradio", { name: /^Other case information/ })
		.click();
	await expect(page.getByRole("alertdialog")).toHaveCount(0);
	await expect(page.getByLabel("Saved source")).toHaveText(original ?? "");
	await expect(page.getByLabel("Source commits")).toHaveText("2");
});
test("raw user field requires a valid authored name and retains invalid edits locally", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=raw-source`);
	await page.getByRole("button", { name: "Value source: A value" }).click();
	await page.getByRole("menuitemradio", { name: /^Other user field/ }).click();
	const dialog = page.getByRole("alertdialog", {
		name: "Which user information?",
	});
	const apply = dialog.getByRole("button", { name: "Use field" });
	await expect(apply).toBeDisabled();
	const name = dialog.getByLabel("User field name");
	await name.fill("bad name");
	await expect(name).toHaveAttribute("aria-invalid", "true");
	await expect(apply).toBeDisabled();
	await name.fill("assigned-region");
	await apply.click();
	await expect(page.getByLabel("Saved source")).toHaveText(
		'{"kind":"term","term":{"kind":"session-user","field":"assigned-region"}}',
	);
	const field = page.getByRole("textbox", { name: "User information field" });
	await field.fill("bad name");
	await page.getByRole("button", { name: "Leave source" }).click();
	await expect(field).toHaveAttribute("aria-invalid", "true");
	await expect(page.getByLabel("Source commits")).toHaveText("1");
	await field.fill("assigned_region");
	await page.getByRole("button", { name: "Leave source" }).click();
	await expect(page.getByLabel("Saved source")).toHaveText(
		'{"kind":"term","term":{"kind":"session-user","field":"assigned_region"}}',
	);
});

function workbenchRegion(page: Page, path: readonly (string | number)[]) {
	return page.locator(`[data-workbench-focus-id='${JSON.stringify(path)}']`);
}
test("workbench navigation restores actual scroll and the exact keyboard opener", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 840 });
	await page.goto(`${peer.origin}/?scenario=workbench-navigation`);
	const scroller = page.getByLabel("Rule workspace");
	const opener = workbenchRegion(page, ["and", 1]).locator(
		"[data-rule-focus-summary]",
	);
	await opener.scrollIntoViewIfNeeded();
	await scroller.evaluate((element) => {
		element.scrollTop = 200;
	});
	await opener.focus();
	const previous = await scroller.evaluate((element) => element.scrollTop);
	await opener.press("Enter");
	await expect(
		page.getByRole("heading", { name: "Editing any condition" }),
	).toBeFocused();
	const current = await scroller.evaluate((element) => element.scrollTop);
	expect(current).not.toBe(previous);
	const nested = workbenchRegion(page, ["and", 1, "or", 1]).locator(
		"[data-rule-focus-summary]",
	);
	await nested.focus();
	await nested.press("Enter");
	await expect(
		page.getByRole("heading", { name: "Editing exclude cases when" }),
	).toBeFocused();
	const navigation = page.getByRole("navigation", {
		name: "Condition location",
	});
	await expect(navigation.locator('[aria-current="location"]')).toHaveCount(1);
	expect(
		await navigation.evaluate(
			(element) => element.scrollWidth <= element.clientWidth + 1,
		),
	).toBe(true);
	await page
		.getByRole("button", { name: "Back to any condition" })
		.press("Enter");
	await expect(
		workbenchRegion(page, ["and", 1, "or", 1]).locator(
			"[data-rule-focus-summary]",
		),
	).toBeFocused();
	await page
		.getByRole("button", { name: "Back to cases available" })
		.press("Enter");
	await expect(opener).toBeFocused();
	expect(await scroller.evaluate((element) => element.scrollTop)).toBe(
		previous,
	);
	for (let replay = 0; replay < 2; replay++) {
		await page.getByRole("button", { name: "Focus nested condition" }).click();
		await expect(
			workbenchRegion(page, ["and", 1, "or", 1, "not", "clause"]).locator(
				"[data-workbench-active-heading]",
			),
		).toBeFocused();
	}
});
test("workbench grouping, moving and removal preserve authored conditions with native focus", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=workbench-group`);
	const first = () => workbenchRegion(page, ["and", 0]);
	await first()
		.getByRole("button", { name: /^Organize / })
		.click();
	await page.getByRole("menuitem", { name: "Move later" }).press("Enter");
	await expect(
		workbenchRegion(page, ["and", 1]).getByLabel("Text value"),
	).toHaveValue("North");
	expect(
		await workbenchRegion(page, ["and", 1]).evaluate((element) =>
			element.contains(document.activeElement),
		),
	).toBe(true);
	await first()
		.getByRole("button", { name: /^Organize / })
		.click();
	await page
		.getByRole("menuitem", { name: "Let either of these conditions match" })
		.press("Enter");
	await expect(first()).toContainText("Any condition matches");
	expect(
		await first().evaluate((element) =>
			element.contains(document.activeElement),
		),
	).toBe(true);
	await first()
		.getByRole("button", { name: /^Organize / })
		.click();
	await page
		.getByRole("menuitem", { name: "Require every condition separately" })
		.press("Enter");
	await expect(first().getByLabel("Text value")).toHaveValue("South");
	await first().getByRole("button", { name: "Delete condition" }).click();
	await expect(first().getByLabel("Text value")).toHaveValue("North");
	expect(
		await first().evaluate((element) =>
			element.contains(document.activeElement),
		),
	).toBe(true);
	await first().getByRole("button", { name: "Delete condition" }).click();
	await expect(workbenchRegion(page, []).getByLabel("Text value")).toHaveValue(
		"West",
	);
	expect(
		await workbenchRegion(page, []).evaluate((element) =>
			element.contains(document.activeElement),
		),
	).toBe(true);
});
test("workbench exposes whole-rule search refusal in the actual source menu", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=workbench-search`);
	await page.getByRole("button", { name: "Value source: A value" }).click();
	const source = page.getByRole("menuitemradio", {
		name: /^Other case information/,
	});
	await expect(source).toHaveAttribute("aria-disabled", "true");
	await expect(source).toContainText(
		"This condition already uses case information",
	);
	await source.press("Enter");
	await expect(page.getByLabel("Saved rule")).toContainText('"North"');
});

for (const kind of ["comparison-missing", "match-missing", "match-empty"]) {
	test(`${kind} locates one visible condition diagnostic and clears it after repair`, async ({
		page,
	}) => {
		await page.goto(`${peer.origin}/?scenario=${kind}`);
		const message =
			kind === "match-empty"
				? "Enter a value to match"
				: "Choose available case information";
		await expect(page.getByLabel("Predicate validity")).toHaveText("false");
		await expect(page.getByText(message, { exact: true })).toHaveCount(1);
		await expect(page.getByText(message, { exact: true })).toBeVisible();
		await page
			.getByRole("button", { name: "Load corrected condition" })
			.click();
		await expect(page.getByLabel("Predicate validity")).toHaveText("true");
		await expect(page.getByText(message, { exact: true })).toHaveCount(0);
	});
}
test("related multiple-choice chips use destination identities and restore focus through deletion", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=multi-select`);
	await expect(
		page.getByRole("button", { name: "Remove Open, saved as open_a" }),
	).toBeVisible();
	await page.getByRole("button", { name: "Add option" }).click();
	await page.getByRole("menuitem", { name: "Open Saved as open_b" }).click();
	const added = page.getByRole("button", {
		name: "Remove Open, saved as open_b",
	});
	await expect(added).toBeVisible();
	await page.getByRole("button", { name: "Remove Closed" }).press("Enter");
	await expect(added).toBeFocused();
	await added.press("Enter");
	await expect(page.getByRole("button", { name: "Add option" })).toBeFocused();
	await expect(page.getByLabel("Saved choices")).toContainText(
		'"value":"open_a"',
	);
	await expect(page.getByLabel("Saved choices")).not.toContainText(
		'"value":"open_b"',
	);
	await expect(page.getByLabel("Saved choices")).not.toContainText(
		'"value":"client"',
	);
});
test("distance drafts retain invalid values and refuse unit conversion overflow", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=distance`);
	const distance = page.getByRole("spinbutton", {
		name: "Distance",
		exact: true,
	});
	await distance.fill("-1");
	await page.getByRole("button", { name: "Leave distance" }).click();
	await expect(distance).toHaveValue("-1");
	await expect(distance).toHaveAttribute("aria-invalid", "true");
	await expect(page.getByRole("alert")).toHaveText(
		"Enter a distance greater than 0",
	);
	await expect(page.getByLabel("Saved distance")).toContainText('"distance":1');
	await distance.fill("0.25");
	await page.getByRole("button", { name: "Leave distance" }).click();
	await expect(distance).not.toHaveAttribute("aria-invalid", "true");
	await expect(page.getByLabel("Saved distance")).toContainText(
		'"distance":0.25',
	);
	await page.getByRole("button", { name: "Load large distance" }).click();
	const unit = page.getByRole("combobox", { name: "Distance unit kilometers" });
	await unit.click();
	await page.getByRole("option", { name: "miles", exact: true }).click();
	await expect(unit).toHaveAttribute("aria-invalid", "true");
	await expect(page.getByRole("alert")).toHaveText(
		"Enter a smaller distance before switching to miles",
	);
	await expect(page.getByLabel("Saved distance")).toContainText(
		'"unit":"kilometers"',
	);
});

test("worker information follows catalog renames without rewriting identity and offers missing-source recovery", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=worker-source`);
	await expect(
		page.getByRole("button", {
			name: "Worker information: Assigned region, assigned_region",
		}),
	).toBeVisible();
	const original = await page.getByLabel("Saved worker source").textContent();
	await page.getByRole("button", { name: "Rename worker information" }).click();
	await expect(
		page.getByRole("button", {
			name: "Worker information: Service area, service_area",
		}),
	).toBeVisible();
	await expect(page.getByLabel("Saved worker source")).toHaveText(
		original ?? "",
	);
	await page.getByRole("button", { name: "Remove worker information" }).click();
	await expect(page.getByRole("alert")).toContainText(
		"Worker information unavailable",
	);
	await expect(page.getByRole("alert")).toContainText(
		"Choose another value source",
	);
	await expect(page.getByRole("alert")).not.toContainText("00000000-");
	await expect(page.getByLabel("Worker validity")).toHaveText("false");
});
test("related membership edits use the destination date control despite an integer property with the same name", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=related-membership`);
	const date = page.getByLabel("Value", { exact: true });
	await expect(date).toHaveAttribute("type", "date");
	await expect(date).toHaveValue("2026-01-01");
	await date.fill("2026-09-06");
	await expect(page.getByLabel("Saved membership")).toContainText(
		'"value":"2026-09-06","data_type":"date"',
	);
	await page.getByRole("button", { name: "Add value", exact: true }).click();
	await expect(page.getByLabel("Value", { exact: true })).toHaveCount(2);
});
for (const [label, kind] of [
	["Always match", "match-all"],
	["Never match", "match-none"],
]) {
	test(`workbench special condition ${label} requires confirmation and returns keyboard focus`, async ({
		page,
	}) => {
		await page.goto(`${peer.origin}/?scenario=workbench-special`);
		const trigger = page.getByRole("button", {
			name: "Condition is",
			exact: true,
		});
		await trigger.click();
		await page.getByRole("menuitem", { name: new RegExp(`^${label}`) }).click();
		await page
			.getByRole("alertdialog")
			.getByRole("button", { name: "Cancel" })
			.click();
		await expect(trigger).toBeFocused();
		await expect(page.getByLabel("Saved rule")).toContainText('"North"');
		await trigger.click();
		await page.getByRole("menuitem", { name: new RegExp(`^${label}`) }).click();
		await page
			.getByRole("alertdialog")
			.getByRole("button", { name: "Change condition" })
			.click();
		await expect(page.getByLabel("Saved rule")).toHaveText(
			`{"kind":"${kind}"}`,
		);
		await expect(
			page.getByRole("button", { name: `Condition ${label}` }),
		).toBeFocused();
	});
}

test("slot disclosure keeps a native heading and controls its named region by keyboard", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=slot-header`);
	const heading = page.getByRole("heading", { name: "Open starting value" });
	const toggle = heading.getByRole("button", { name: "Open starting value" });
	await expect(toggle).toHaveAttribute("aria-controls", "starting-value");
	await expect(page.getByText("Saved starting value")).not.toBeVisible();
	await toggle.focus();
	await toggle.press("Enter");
	await expect(page.getByText("Saved starting value")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Close starting value" }),
	).toBeFocused();
	await page
		.getByRole("button", { name: "Close starting value" })
		.press("Space");
	await expect(page.getByText("Saved starting value")).not.toBeVisible();
});

test("literal type keyboard submenu confirms typed-date loss and restores the exact saved value", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=literal-shape`);
	const source = page.getByRole("button", { name: "Value source: A value" });
	const original = await page.getByLabel("Saved literal shape").textContent();
	async function chooseShape(name: string) {
		await source.focus();
		await source.press("ArrowDown");
		const submenu = page.getByRole("menuitem", { name: /^Value type/ });
		await submenu.focus();
		await submenu.press("ArrowRight");
		const choice = page.getByRole("menuitem", { name, exact: true });
		await choice.focus();
		await choice.press("Enter");
	}
	await chooseShape("Text");
	const confirm = page.getByRole("alertdialog", {
		name: "Change this value to text?",
	});
	await expect(confirm).toContainText("This replaces the saved date value");
	await confirm.getByRole("button", { name: "Cancel" }).click();
	await expect(source).toBeFocused();
	await expect(page.getByLabel("Saved literal shape")).toHaveText(
		original ?? "",
	);
	await chooseShape("Text");
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Change value" })
		.click();
	await expect(source).toBeFocused();
	await expect(page.getByLabel("Saved literal shape")).toHaveText(
		'{"kind":"term","term":{"kind":"literal","value":""}}',
	);
	await chooseShape("Date");
	await expect(page.getByRole("alertdialog")).toHaveCount(0);
	await expect(page.getByLabel("Saved literal shape")).toHaveText(
		original ?? "",
	);
});

for (const kind of ["count", "exists", "workbench"]) {
	test(`${kind} related filter refuses a new destination until its authored condition is removed`, async ({
		page,
	}) => {
		await page.goto(`${peer.origin}/?scenario=related-filter-${kind}`);
		const saved = page.getByLabel("Saved related filter");
		const original = await saved.textContent();
		const picker = page.getByRole("combobox", { name: "Child case type" });
		await picker.click();
		const option = page.getByRole("option", { name: /^Visit/ });
		await expect(option).toHaveAttribute("aria-disabled", "true");
		await expect(option).toContainText(
			"Choose information from the related case shown here",
		);
		await page.keyboard.press("Escape");
		await expect(saved).toHaveText(original ?? "");
		await page
			.getByRole("button", { name: "Delete condition", exact: true })
			.click();
		await picker.click();
		const admitted = page.getByRole("option", { name: "Visit", exact: true });
		await expect(admitted).not.toHaveAttribute("aria-disabled", "true");
		await admitted.click();
		await expect(saved).toContainText('"ofCaseType":"visit"');
		await expect(saved).not.toContainText('"where"');
	});
}
for (const kind of ["count", "exists"]) {
	test(`${kind} adds a real destination filter and removes its optional key`, async ({
		page,
	}) => {
		await page.goto(`${peer.origin}/?scenario=related-filter-${kind}-seed`);
		await page
			.getByRole("button", { name: "Add condition", exact: true })
			.click();
		await expect(page.getByLabel("Saved related filter")).toContainText(
			'"caseType":"patient"',
		);
		await expect(page.getByLabel("Saved related filter")).toContainText(
			'"property":"enrollment"',
		);
		await page
			.getByRole("button", { name: "Delete condition", exact: true })
			.click();
		await expect(page.getByLabel("Saved related filter")).not.toContainText(
			'"where"',
		);
	});
}

for (const mode of [
	"logical",
	"workbench",
	"active",
	"membership",
	"concat",
	"coalesce",
	"switch",
]) {
	test(`${mode} immutable AST leaf edits retain the exact native date control and focus`, async ({
		page,
	}) => {
		await page.goto(`${peer.origin}/?scenario=stable-${mode}`);
		const date = page.locator('input[type="date"]').first();
		const original = await date.elementHandle();
		try {
			await date.focus();
			await date.fill("2026-09-06");
			await expect(page.getByLabel("Saved stable AST")).toContainText(
				"2026-09-06",
			);
			expect(
				await date.evaluate((current, prior) => current === prior, original),
			).toBe(true);
			await expect(date).toBeFocused();
		} finally {
			await original?.dispose();
		}
	});
}
test("boolean immutable AST leaf edit preserves its focused native choice", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=stable-boolean`);
	const choice = page.getByRole("button", { name: "No", exact: true });
	const original = await choice.elementHandle();
	try {
		await choice.click();
		await expect(choice).toHaveAttribute("aria-pressed", "true");
		await expect(page.getByLabel("Saved stable AST")).toContainText(
			'"value":false',
		);
		expect(
			await choice.evaluate((current, prior) => current === prior, original),
		).toBe(true);
		await expect(choice).toBeFocused();
	} finally {
		await original?.dispose();
	}
});
test("logical group native drag moves a saved clause and retains its control identity", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=logical-drag`);
	const grips = page.getByRole("button", {
		name: "Drag to reorder",
		exact: true,
	});
	await expect(grips).toHaveCount(3);
	const west = page.getByRole("textbox", { name: "Text value" }).nth(2);
	const original = await west.elementHandle();
	try {
		await grips.nth(2).dragTo(grips.nth(0), { targetPosition: { x: 5, y: 1 } });
		await expect(
			page.getByRole("textbox", { name: "Text value" }).first(),
		).toHaveValue("West");
		expect(
			await page
				.getByRole("textbox", { name: "Text value" })
				.first()
				.evaluate((current, prior) => current === prior, original),
		).toBe(true);
	} finally {
		await original?.dispose();
	}
});

test("options use real label editors, preserve draft identity across key-order echoes and enforce the commit gate", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=options`);
	const saved = page.getByLabel("Saved options");
	const value = page.getByRole("textbox", {
		name: "Stored value for Red",
		exact: true,
	});
	await value.fill("crimson");
	const original = await value.elementHandle();
	try {
		await page
			.getByRole("button", { name: "Reorder snapshot object keys" })
			.click();
		await expect(value).toHaveValue("crimson");
		await expect(value).toBeFocused();
		expect(
			await value.evaluate((current, prior) => current === prior, original),
		).toBe(true);
		await page.getByRole("button", { name: "Leave options" }).click();
		await expect(saved).toContainText('"value":"crimson"');
		await value.fill("blue");
		await page.getByRole("button", { name: "Make app read only" }).click();
		await value.press("Enter");
		await expect(value).toHaveValue("blue");
		await expect(saved).toContainText('"value":"crimson"');
		await expect(page.getByRole("alert")).toBeVisible();
		await page.getByRole("button", { name: "Restore editing" }).click();
		await value.fill("red");
		await value.press("Enter");
		await expect(saved).toContainText('"value":"red"');
		await expect(page.getByRole("alert")).toHaveCount(0);
	} finally {
		await original?.dispose();
	}
	await page.getByRole("button", { name: "Add option", exact: true }).click();
	const label = page
		.getByRole("textbox", { name: "Label", exact: true })
		.nth(2);
	await expect(label).toBeFocused();
	await label.fill("Green");
	await label.press("Enter");
	await expect(
		page.getByRole("textbox", { name: "Stored value for Green", exact: true }),
	).toHaveValue("green");
	await page.getByRole("button", { name: "Remove Green", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Remove Red", exact: true }),
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Remove Blue", exact: true }),
	).toBeDisabled();
});
test("changing a reference-bearing option label preserves the authored stored token", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=options`);
	await page
		.getByRole("button", { name: "Load authored reference label" })
		.click();
	await expect(page.getByLabel("Saved options")).toContainText(
		'"kind":"field-ref"',
	);
	const label = page
		.getByRole("textbox", { name: "Label", exact: true })
		.first();
	await label.fill("Renamed");
	await label.press("Enter");
	await expect(
		page.getByRole("textbox", {
			name: "Stored value for Renamed",
			exact: true,
		}),
	).toHaveValue("option_1");
	await expect(page.getByLabel("Saved options")).toContainText(
		'"value":"option_1"',
	);
});

test("refused prose commits keep the real editor draft until permission is restored", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=field-prose`);
	const hint = page.getByRole("textbox", { name: "Hint", exact: true });
	await expect(page.getByLabel("Can undo")).toHaveText("false");
	await hint.fill("Helpful wording");
	await expect(page.getByLabel("Saved prose field")).not.toContainText(
		'"hint"',
	);
	await page.evaluate(() =>
		window.dispatchEvent(
			new CustomEvent("native-editor-access", { detail: false }),
		),
	);
	await expect(
		page.getByRole("button", { name: "Restore editing" }),
	).toBeVisible();
	await expect(page.getByLabel("Saved prose field")).not.toContainText(
		'"hint"',
	);
	await hint.press("Enter");
	await expect(page.getByLabel("Saved prose field")).not.toContainText(
		'"hint"',
	);
	await expect(hint).toHaveText("Helpful wording");
	await expect(page.getByRole("alert")).toBeVisible();
	await page.evaluate(() =>
		window.dispatchEvent(
			new CustomEvent("native-editor-access", { detail: true }),
		),
	);
	await expect(
		page.getByRole("button", { name: "Make app read only" }),
	).toBeVisible();
	await hint.press("Enter");
	await expect(page.getByLabel("Saved prose field")).toContainText(
		"Helpful wording",
	);
	await expect(page.getByRole("alert")).toHaveCount(0);
	await hint.press("ControlOrMeta+A");
	await hint.press("Backspace");
	await expect(hint).toHaveText("");
	await hint.press("Enter");
	await expect(page.getByLabel("Saved prose field")).not.toContainText(
		'"hint"',
	);
});

test("validation messages stage empty slots, persist prose and retain a refused clear", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=field-logic`);
	const saved = page.getByLabel("Saved logic field");
	await expect(
		page.getByRole("button", { name: "Validation message", exact: true }),
	).toHaveCount(0);
	await page
		.locator('[data-field-id="validate"]')
		.getByRole("button")
		.first()
		.click();
	const code = page.locator('.cm-content[contenteditable="true"]');
	await code.fill("true()");
	await code.press("ControlOrMeta+Enter");
	await expect(saved).toContainText('"validate"');
	const add = page.getByRole("button", {
		name: "Validation message",
		exact: true,
	});
	await add.click();
	const message = page.getByRole("textbox", {
		name: "Validation message",
		exact: true,
	});
	await expect(message).toBeFocused();
	await message.press("Escape");
	await expect(add).toBeVisible();
	await expect(saved).not.toContainText('"validate_msg"');
	await add.click();
	await message.fill("Check the answer");
	await message.press("Enter");
	await expect(saved).toContainText("Check the answer");
	// Use the editor's native selection command. fill("") selects only the DOM,
	// which ProseMirror's delayed focus selection can replace before Delete.
	await message.press("ControlOrMeta+A");
	await message.press("Backspace");
	await expect(message).toHaveText("");
	await expect(message).toBeFocused();
	await page.evaluate(() =>
		window.dispatchEvent(
			new CustomEvent("native-editor-access", { detail: false }),
		),
	);
	await expect(
		page.getByRole("button", { name: "Restore editing" }),
	).toBeVisible();
	await message.press("Enter");
	await expect(saved).toContainText("Check the answer");
	await expect(message).toBeFocused();
	await expect(message).toHaveText("");
	await expect(page.getByRole("alert")).toHaveCount(1);
	await page.evaluate(() =>
		window.dispatchEvent(
			new CustomEvent("native-editor-access", { detail: true }),
		),
	);
	await expect(
		page.getByRole("button", { name: "Make app read only" }),
	).toBeVisible();
	await message.press("Enter");
	await expect(saved).not.toContainText('"validate_msg"');
	await expect(add).toBeVisible();
});

test("required control stores parsed conditions and removes only the authored condition", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=field-required`);
	const saved = page.getByLabel("Saved logic field");
	const required = page.getByRole("switch", { name: "Required", exact: true });
	await expect(required).not.toBeChecked();
	await required.click();
	await expect(required).toBeChecked();
	await page.getByRole("button", { name: "Condition", exact: true }).click();
	const code = page.locator('.cm-content[contenteditable="true"]');
	await code.fill("string-length(.) > 2");
	await code.press("ControlOrMeta+Enter");
	await expect(
		page.getByRole("button", { name: "Remove condition", exact: true }),
	).toBeVisible();
	await expect(saved).toContainText("string-length");
	await page
		.getByRole("button", { name: "Remove condition", exact: true })
		.click();
	await expect(required).toBeChecked();
	await expect(
		page.getByRole("button", { name: "Condition", exact: true }),
	).toBeVisible();
	await required.click();
	await expect(required).not.toBeChecked();
	await expect(saved).not.toContainText('"required"');
});

test("lookup choice sources stage complete identities, cancel cleanly and refuse a vanished table", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=options-source`);
	const saved = page.getByLabel("Saved source");
	const initial = await saved.textContent();
	const source = page.getByRole("combobox", {
		name: "Where the choices come from",
		exact: true,
	});
	const pickTable = async () => {
		await source.click();
		await page.getByRole("option", { name: "Regions", exact: true }).click();
	};
	await pickTable();
	const confirm = page.getByRole("button", {
		name: "Use this table",
		exact: true,
	});
	await expect(confirm).toBeDisabled();
	await expect(saved).toHaveText(initial ?? "");
	await page
		.getByRole("combobox", { name: "Value that gets saved", exact: true })
		.click();
	await page.getByRole("option", { name: "Region code", exact: true }).click();
	await expect(confirm).toBeDisabled();
	await page
		.getByRole("combobox", { name: "Value people see", exact: true })
		.click();
	await page.getByRole("option", { name: "Region name", exact: true }).click();
	await expect(confirm).toBeEnabled();
	await page.getByRole("button", { name: "Add row rule", exact: true }).click();
	await expect(saved).toHaveText(initial ?? "");
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(saved).toHaveText(initial ?? "");
	await pickTable();
	await page
		.getByRole("combobox", { name: "Value that gets saved", exact: true })
		.click();
	await page.getByRole("option", { name: "Region code", exact: true }).click();
	await page
		.getByRole("combobox", { name: "Value people see", exact: true })
		.click();
	await page.getByRole("option", { name: "Region name", exact: true }).click();
	await page.getByRole("button", { name: "Add row rule", exact: true }).click();
	await confirm.click();
	await expect(saved).toContainText('"kind":"lookup"');
	await expect(saved).toContainText('"filter"');
	await expect(page.getByRole("alert")).toHaveCount(0);
	const stored = await saved.textContent();
	await source.click();
	await page
		.getByRole("option", { name: "Options in this question", exact: true })
		.click();
	await expect(saved).toHaveText(stored ?? "");
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(saved).toHaveText(stored ?? "");
	await expect(source).toContainText("Regions");
	await expect(
		page.getByRole("button", { name: "Use these options", exact: true }),
	).toHaveCount(0);
	await page
		.getByRole("button", { name: "Remove table definition", exact: true })
		.click();
	await expect(page.getByRole("alert")).toContainText("isn't in this Project");
	await expect(saved).toHaveText(stored ?? "");
	await page
		.getByRole("button", { name: "Restore table definition", exact: true })
		.click();
	await expect(page.getByRole("alert")).toHaveCount(0);
});

test("markdown formatting fits a narrow inspector and native dialogs insert the requested content", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=markdown`);
	const toolbar = page.getByRole("toolbar", { name: "Subtitle formatting" });
	await expect(toolbar).toBeVisible();
	expect(await toolbar.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
		true,
	);
	const editor = page.getByLabel("Subtitle", { exact: true });
	await editor.click();
	await editor.press("ControlOrMeta+a");
	await page.getByRole("button", { name: "Bold", exact: true }).click();
	await expect(editor.locator("strong")).toHaveText("Hello");
	await page
		.getByRole("button", { name: "Leave markdown", exact: true })
		.click();
	await expect(page.getByLabel("Saved markdown")).toHaveText("**Hello**");
	const more = page.getByRole("button", {
		name: "More formatting",
		exact: true,
	});
	await more.click();
	const headings = page.getByRole("menuitem", {
		name: "Headings",
		exact: true,
	});
	await headings.focus();
	await headings.press("ArrowRight");
	await expect(
		page.getByRole("menuitemcheckbox", { name: "Heading 1", exact: true }),
	).toBeVisible();
	await page.keyboard.press("Escape");
	await page.keyboard.press("Escape");
	await more.click();
	await page.getByRole("menuitem", { name: "Table", exact: true }).click();
	const tableDialog = page.getByRole("dialog", {
		name: "Insert table",
		exact: true,
	});
	await expect(tableDialog).toBeVisible();
	await tableDialog
		.getByRole("spinbutton", { name: "Rows", exact: true })
		.fill("0");
	await expect(
		tableDialog.getByRole("button", { name: "Insert", exact: true }),
	).toBeDisabled();
	await tableDialog
		.getByRole("spinbutton", { name: "Rows", exact: true })
		.fill("2");
	await tableDialog
		.getByRole("spinbutton", { name: "Columns", exact: true })
		.fill("2");
	await tableDialog
		.getByRole("button", { name: "Insert", exact: true })
		.click();
	await expect(tableDialog).toHaveCount(0);
	await expect(editor.locator("table tr")).toHaveCount(2);
	await expect(editor.locator("table th, table td")).toHaveCount(4);
	await more.click();
	await page.getByRole("menuitem", { name: "Image", exact: true }).click();
	const imageDialog = page.getByRole("dialog", {
		name: "Insert image",
		exact: true,
	});
	await imageDialog
		.getByRole("textbox", { name: "Image address", exact: true })
		.fill(`${peer.origin}/native-image.svg`);
	await imageDialog
		.getByRole("textbox", { name: "Image description", exact: true })
		.fill("Region symbol");
	await imageDialog
		.getByRole("button", { name: "Insert", exact: true })
		.click();
	await expect(imageDialog).toHaveCount(0);
	await expect(
		editor.getByRole("img", { name: "Region symbol", exact: true }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Leave markdown", exact: true })
		.click();
	await expect(page.getByLabel("Saved markdown")).toContainText(
		"![Region symbol]",
	);
	const saved = await page.getByLabel("Saved markdown").textContent();
	await page
		.getByRole("button", { name: "Reopen markdown", exact: true })
		.click();
	await expect(
		editor
			.locator("table")
			.getByRole("img", { name: "Region symbol", exact: true }),
	).toBeVisible();
	await editor.click();
	await page
		.getByRole("button", { name: "Leave markdown", exact: true })
		.click();
	await expect(page.getByLabel("Saved markdown")).toHaveText(saved ?? "");
});

test("field activation is one-shot through empty cancellation, saved values and selection changes", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=activation`);
	const logic = page.getByRole("region", { name: "Logic section" });
	await logic.getByRole("button", { name: "Required", exact: true }).click();
	await expect(
		logic.getByRole("switch", { name: "Required", exact: true }),
	).toBeChecked();
	const appearance = page.getByRole("region", { name: "Appearance section" });
	const add = appearance.getByRole("button", { name: "Hint", exact: true });
	const editor = appearance.getByRole("textbox", { name: "Hint", exact: true });
	await add.click();
	await expect(editor).toBeFocused();
	await page
		.getByRole("button", { name: "Select second field", exact: true })
		.click();
	await expect(page.getByLabel("Selected field")).toHaveText("second");
	await expect(add).toBeVisible();
	await page
		.getByRole("button", { name: "Select first field", exact: true })
		.click();
	await expect(page.getByLabel("Selected field")).toHaveText("first");
	await expect(add).toBeVisible();
	await expect(editor).toHaveCount(0);
	await add.click();
	await editor.fill("Keep this hint");
	await editor.press("Enter");
	await expect(editor).toHaveText("Keep this hint");
	await editor.press("ControlOrMeta+A");
	await editor.press("Backspace");
	await expect(editor).toHaveText("");
	await editor.press("Enter");
	await expect(add).toBeVisible();
	await expect(editor).toHaveCount(0);
	await add.click();
	await expect(editor).toBeFocused();
	await editor.press("Escape");
	await expect(add).toBeVisible();
});

test("case storage describes several-case writes and commits a worker-admitted destination", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=case-write`);
	const chooser = page.getByRole("combobox", {
		name: "Saves to: Phone, #patient/phone",
		exact: true,
	});
	await expect(chooser).toBeVisible();
	const described = await chooser.getAttribute("aria-describedby");
	expect(described).toBeTruthy();
	await expect(page.locator(`[id="${described}"]`)).toContainText(
		"every selected case",
	);
	await chooser.click();
	const email = page.getByRole("option", { name: /Email.*#patient\/email/ });
	await email.click();
	await expect(page.getByLabel("Saved destination")).toHaveText(
		'{"caseType":"patient","property":"email"}',
	);
	await expect(
		page.getByRole("combobox", {
			name: "Saves to: Email, #patient/email",
			exact: true,
		}),
	).toBeVisible();
});

test("worker information preserves refused drafts across disclosure and guards shared edits and references", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=setup-worker`);
	const worker = page.getByRole("region", {
		name: "Worker information",
		exact: true,
	});
	const region = worker.getByRole("button", { name: /Region.*region/ });
	await region.click();
	const name = worker.getByRole("textbox", {
		name: "Name people see",
		exact: true,
	});
	await name.fill("");
	await name.press("Enter");
	await expect(worker.getByRole("alert")).toHaveText(
		"Enter a name people can see.",
	);
	const original = await name.elementHandle();
	try {
		await worker.getByRole("button", { name: /Cadre.*cadre/ }).click();
		await region.click();
		await expect(name).toHaveValue("");
		expect(
			await name.evaluate((node, previous) => node === previous, original),
		).toBe(true);
	} finally {
		await original?.dispose();
	}
	await name.press("Escape");
	await expect(name).toHaveValue("Region");
	await name.fill("Local region");
	await page
		.getByRole("button", { name: "Peer renames region", exact: true })
		.click();
	await expect(page.getByLabel("Saved worker properties")).toContainText(
		'"label":"District"',
	);
	await name.press("Enter");
	await expect(worker.getByRole("alert")).toContainText("another editor");
	await expect(name).toHaveValue("Local region");
	await name.press("Escape");
	await expect(name).toHaveValue("District");
	const slug = worker.getByRole("textbox", {
		name: "Name it saves under",
		exact: true,
	});
	await slug.fill("1invalid");
	await expect(slug).toHaveAttribute("aria-invalid", "true");
	await slug.press("Escape");
	await expect(slug).toHaveValue("region");
	const choices = worker.getByRole("textbox", {
		name: "Accepted values",
		exact: true,
	});
	await choices.fill("north");
	await worker
		.getByRole("button", { name: "Apply accepted values", exact: true })
		.click();
	await expect(choices).toHaveAttribute("aria-invalid", "true");
	await expect(worker.getByRole("alert")).toContainText(
		"A role or persona has a value",
	);
	const originalChoices = await choices.elementHandle();
	try {
		await worker.getByRole("button", { name: /Cadre.*cadre/ }).click();
		await worker.getByRole("button", { name: /District.*region/ }).click();
		await expect(choices).toHaveValue("north");
		expect(
			await choices.evaluate(
				(node, previous) => node === previous,
				originalChoices,
			),
		).toBe(true);
	} finally {
		await originalChoices?.dispose();
	}
	await choices.fill("north\nsouth\n__nova_no_value\neast");
	await worker
		.getByRole("button", { name: "Apply accepted values", exact: true })
		.click();
	await expect(choices).not.toHaveAttribute("aria-invalid", "true");
	await expect(page.getByLabel("Saved worker properties")).toContainText(
		'"choices":["north","south","__nova_no_value","east"]',
	);
	const remove = worker.getByRole("button", {
		name: "Remove worker information",
		exact: true,
	});
	await remove.click();
	await expect(
		worker.getByText("Can't remove District yet", { exact: true }),
	).toBeVisible();
	await expect(worker.getByText(/1 saved setting uses/)).toBeVisible();
	await expect(
		worker.getByRole("button", { name: "Remove", exact: true }),
	).toHaveCount(0);
	await worker.getByRole("button", { name: "Close", exact: true }).click();
	await expect(remove).toBeFocused();
});

test("persona value controls save inherited, blank, sentinel-like choice and free-text overrides distinctly", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=setup-values`);
	const values = page.getByRole("region", {
		name: "Persona values",
		exact: true,
	});
	const region = values.getByRole("combobox", { name: "Region", exact: true });
	const saved = page.getByLabel("Saved persona values");
	const propertyId = "00000000-0000-7000-8000-000000000343";
	const textId = "00000000-0000-7000-8000-000000000344";
	await region.click();
	await page
		.getByRole("option", { name: "__nova_no_value", exact: true })
		.click();
	await expect(saved).toHaveText(
		JSON.stringify({ [propertyId]: "__nova_no_value" }),
	);
	await region.click();
	await page.getByRole("option", { name: "Blank", exact: true }).click();
	await expect(saved).toHaveText(JSON.stringify({ [propertyId]: "" }));
	await expect(region).toContainText("Blank");
	await region.click();
	await page
		.getByRole("option", { name: "Use role value: north", exact: true })
		.click();
	await expect(saved).toHaveText("{}");
	await expect(region).toContainText("Use role value: north");
	const text = values.getByRole("textbox", { name: "Cadre", exact: true });
	await expect(text).toHaveAttribute("placeholder", "nurse");
	await text.fill("midwife");
	await expect(saved).toHaveText(JSON.stringify({ [textId]: "midwife" }));
	await text.fill("");
	await expect(saved).toHaveText(JSON.stringify({ [textId]: "" }));
	await values
		.getByRole("button", { name: "Use role value", exact: true })
		.click();
	await expect(saved).toHaveText("{}");
	await expect(text).toHaveAttribute("placeholder", "nurse");
});

test("native access gate retains the actual editor through reconnect and removes it on terminal loss", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=access`);
	const input = page.getByRole("textbox", { name: "Retained module name" });
	await input.fill("Unsaved client wording");
	const node = await input.elementHandle();
	if (!node) throw new Error("Missing actual editor");
	await page
		.getByRole("button", { name: "Refresh access", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "Refreshing app" }),
	).toBeVisible();
	expect(await node.evaluate((element) => element.isConnected)).toBe(true);
	await page
		.getByRole("button", { name: "Refresh access", exact: true })
		.focus();
	await node.evaluate((element) => element.focus());
	expect(
		await node.evaluate((element) => element === document.activeElement),
	).toBe(false);
	await page
		.getByRole("button", { name: "Reconnect access", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "Reconnecting", exact: true }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Restore access", exact: true })
		.click();
	await expect(input).toHaveValue("Unsaved client wording");
	expect(
		await input.evaluate((element, before) => element === before, node),
	).toBe(true);
	await expect(page.getByLabel("Saved access module")).toHaveText("Clients");
	await page
		.getByRole("button", { name: "Revoke access", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "This app is no longer available" }),
	).toBeVisible();
	expect(await node.evaluate((element) => element.isConnected)).toBe(false);
	await page
		.getByRole("button", { name: "Restore access", exact: true })
		.click();
	await expect(input).toHaveValue("Clients");
	await page
		.getByRole("button", { name: "Require upgrade", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "Nova needs to refresh" }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Refresh Nova", exact: true }),
	).toBeVisible();
});

test("native access gate quarantines a real controlled portal after its source generation pauses", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=access`);
	await page
		.getByRole("button", { name: "Open controlled floating panel" })
		.click();
	const action = page.getByRole("button", { name: "Source Project action" });
	await expect(action).toBeVisible();
	const node = await action.elementHandle();
	if (!node) throw new Error("Missing actual floating action");
	await action.focus();
	await page
		.getByRole("button", { name: "Refresh access", exact: true })
		.click();
	await expect(action).toBeHidden();
	await page
		.getByRole("button", { name: "Restore access", exact: true })
		.click();
	await expect(action).toBeHidden();
	await node.evaluate((element) => element.focus());
	expect(
		await node.evaluate((element) => element === document.activeElement),
	).toBe(false);
});

test("native module settings edit names and placement with bounded panel geometry and actual viewer access", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 780 });
	await page.goto(`${peer.origin}/?scenario=module-settings`);
	const settings = page.getByRole("button", {
		name: "Module settings",
		exact: true,
	});
	await settings.click();
	const panel = page.getByRole("dialog", {
		name: "Module settings",
		exact: true,
	});
	await expect(panel).toBeVisible();
	await contained(panel, 390);
	const name = page.getByRole("textbox", { name: "Module name", exact: true });
	const longName =
		"Community health follow-up and medication administration for returning clients";
	await name.fill(longName);
	await name.press("Enter");
	await expect
		.poll(
			async () =>
				JSON.parse(await page.getByLabel("Saved module").innerText()).name,
		)
		.toBe(longName);
	const placement = page.getByRole("combobox", { name: "Menu placement" });
	await expect(placement).toHaveText("Top level");
	await placement.click();
	await page.getByRole("option", { name: "Care", exact: true }).click();
	await expect(placement).toHaveText("Care");
	await expect(
		page.getByText("Shown inside Care", { exact: true }),
	).toBeVisible();
	await expect
		.poll(
			async () =>
				"parentModuleUuid" in
				JSON.parse(await page.getByLabel("Saved module").innerText()),
		)
		.toBe(true);
	await page.getByRole("button", { name: "Close module settings" }).click();
	await expect(settings).toBeFocused();
	const title = page.getByRole("textbox", {
		name: "Module title",
		exact: true,
	});
	await expect(title).toHaveValue(longName);
	const size = await title.evaluate((element) => ({
		width: element.getBoundingClientRect().width,
		height: element.getBoundingClientRect().height,
		client: element.clientHeight,
		scroll: element.scrollHeight,
	}));
	expect(size.width).toBeLessThanOrEqual(192);
	expect(size.height).toBeGreaterThan(44);
	expect(size.scroll - size.client).toBeLessThanOrEqual(1);
	await page.getByRole("button", { name: "Select parent module" }).click();
	await settings.click();
	await expect(name).toHaveCount(0);
	await expect(placement).toHaveText("Top level");
	await expect(placement).toBeDisabled();
	await expect(
		page.getByRole("heading", { name: "Case list link", exact: true }),
	).toHaveCount(0);
	await page.getByRole("button", { name: "Close module settings" }).click();
	await page.getByRole("button", { name: "View as reader" }).click();
	await expect(settings).toHaveCount(0);
	await expect(title).toHaveAttribute("readonly", "");
	await expect(title).toHaveAttribute("tabindex", "-1");
});

test("native module case type confirmation applies actual admission and explains a formless clear", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=module-settings`);
	await page
		.getByRole("button", { name: "Module settings", exact: true })
		.click();
	const picker = page.getByRole("button", {
		name: "Case type: Patient",
		exact: true,
	});
	await picker.click();
	await page.getByRole("button", { name: "Visit", exact: true }).click();
	const confirmation = page.getByRole("alertdialog", {
		name: "Switch to Visit cases?",
	});
	await expect(confirmation).toBeVisible();
	await confirmation
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await expect(picker).toBeFocused();
	await expect
		.poll(
			async () =>
				JSON.parse(await page.getByLabel("Saved module").innerText()).caseType,
		)
		.toBe("patient");
	await picker.click();
	await page.getByRole("button", { name: "Visit", exact: true }).click();
	await confirmation
		.getByRole("button", { name: "Switch", exact: true })
		.click();
	await expect
		.poll(
			async () =>
				JSON.parse(await page.getByLabel("Saved module").innerText()).caseType,
		)
		.toBe("visit");
	const changed = page.getByRole("button", {
		name: "Case type: Visit",
		exact: true,
	});
	await expect(changed).toBeFocused();
	await changed.click();
	await page
		.getByRole("button", { name: "Stop managing cases", exact: true })
		.click();
	const empty = page.getByRole("alertdialog", { name: "Add a form first" });
	await expect(empty).toBeVisible();
	await expect(
		empty.getByRole("button", { name: "Stop managing", exact: true }),
	).toHaveCount(0);
	await empty.getByRole("button", { name: "Close", exact: true }).click();
	await expect(changed).toBeFocused();
});

test("native module case type refusals keep the actual confirmation and saved case workflow", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=module-settings`);
	await page
		.getByRole("button", { name: "Select active module", exact: true })
		.click();
	await page
		.getByRole("button", { name: "Module settings", exact: true })
		.click();
	const saved = page.getByLabel("Saved module");
	const original = await saved.innerText();
	const picker = page.getByRole("button", {
		name: "Case type: Patient",
		exact: true,
	});
	await picker.click();
	await page
		.getByRole("button", { name: "Stop managing cases", exact: true })
		.click();
	const clear = page.getByRole("alertdialog", {
		name: "Stop managing cases?",
		exact: true,
	});
	await clear
		.getByRole("button", { name: "Stop managing", exact: true })
		.click();
	await expect(clear.getByRole("alert")).toBeVisible();
	await expect(saved).toHaveText(original);
	await clear.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(picker).toBeFocused();
	await picker.click();
	await page.getByRole("button", { name: "Visit", exact: true }).click();
	const switchDialog = page.getByRole("alertdialog", {
		name: "Switch to Visit cases?",
		exact: true,
	});
	await switchDialog
		.getByRole("button", { name: "Switch", exact: true })
		.click();
	await expect(switchDialog.getByRole("alert")).toBeVisible();
	await expect(saved).toHaveText(original);
	await switchDialog
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await expect(picker).toBeFocused();
});

test("native module appearance keeps the menu tile and case-list link media independent", async ({
	page,
}) => {
	const firstId = "00000000-0000-7000-8000-000000005101";
	const secondId = "00000000-0000-7000-8000-000000005102";
	const audioId = "00000000-0000-7000-8000-000000005103";
	await page.route("**/api/media/library?*", async (route) => {
		const url = new URL(route.request().url());
		expect(url.searchParams.get("appId")).toBe("native-module-settings");
		await route.fulfill({
			json: {
				assets: [firstId, secondId, audioId].map((id, index) => ({
					id,
					contentHash: "b".repeat(64),
					mimeType: index === 2 ? "audio/mpeg" : "image/png",
					kind: index === 2 ? "audio" : "image",
					extension: index === 2 ? "mp3" : "png",
					sizeBytes: 68,
					dimensions: { width: 1, height: 1 },
					originalFilename:
						index === 0 ? "menu.png" : index === 1 ? "cases.png" : "spoken.mp3",
					status: "ready",
					createdAt: "2026-07-17T00:00:00.000Z",
				})),
				nextCursor: null,
			},
		});
	});
	await page.route("**/api/media/*?scope=*", async (route) => {
		await route.fulfill({
			contentType: "image/png",
			body: Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1YQAAAAASUVORK5CYII=",
				"base64",
			),
		});
	});
	await page.goto(`${peer.origin}/?scenario=module-settings`);
	await page
		.getByRole("button", { name: "Module settings", exact: true })
		.click();
	const menu = page.getByRole("group", { name: "Menu tile icon", exact: true });
	const cases = page.getByRole("group", {
		name: "Case list link icon",
		exact: true,
	});
	const saved = page.getByLabel("Saved module");
	await menu.getByRole("button", { name: "Attach", exact: true }).click();
	await page.getByRole("tab", { name: "Library", exact: true }).click();
	await page
		.getByRole("button", { name: "Choose menu.png", exact: true })
		.click();
	await expect
		.poll(async () => JSON.parse(await saved.innerText()).icon)
		.toBe(firstId);
	await cases.getByRole("button", { name: "Attach", exact: true }).click();
	await page.getByRole("tab", { name: "Library", exact: true }).click();
	await page
		.getByRole("button", { name: "Choose cases.png", exact: true })
		.click();
	await expect
		.poll(async () => {
			const module = JSON.parse(await saved.innerText());
			return { menu: module.icon, cases: module.caseListConfig.icon };
		})
		.toEqual({ menu: firstId, cases: secondId });
	for (const label of [
		"Menu tile spoken label",
		"Case list link spoken label",
	]) {
		const slot = page.getByRole("group", { name: label, exact: true });
		await slot.getByRole("button", { name: "Attach", exact: true }).click();
		await page.getByRole("tab", { name: "Library", exact: true }).click();
		await page
			.getByRole("button", { name: "Choose spoken.mp3", exact: true })
			.click();
	}
	await expect
		.poll(async () => {
			const module = JSON.parse(await saved.innerText());
			return [
				module.icon,
				module.audioLabel,
				module.caseListConfig.icon,
				module.caseListConfig.audioLabel,
			];
		})
		.toEqual([firstId, audioId, secondId, audioId]);
	for (const label of [
		"Menu tile spoken label",
		"Case list link spoken label",
	]) {
		await page
			.getByRole("group", { name: label, exact: true })
			.getByRole("button", { name: "Remove audio", exact: true })
			.click();
	}
	await expect
		.poll(async () => {
			const module = JSON.parse(await saved.innerText());
			return {
				menu: module.icon,
				cases: module.caseListConfig.icon,
				menuAudio: Object.hasOwn(module, "audioLabel"),
				casesAudio: Object.hasOwn(module.caseListConfig, "audioLabel"),
			};
		})
		.toEqual({
			menu: firstId,
			cases: secondId,
			menuAudio: false,
			casesAudio: false,
		});
	await menu.getByRole("button", { name: "Remove image", exact: true }).click();
	await expect
		.poll(async () => {
			const module = JSON.parse(await saved.innerText());
			return {
				menuPresent: Object.hasOwn(module, "icon"),
				cases: module.caseListConfig.icon,
			};
		})
		.toEqual({ menuPresent: false, cases: secondId });
	await cases
		.getByRole("button", { name: "Remove image", exact: true })
		.click();
	await expect
		.poll(async () =>
			Object.hasOwn(JSON.parse(await saved.innerText()).caseListConfig, "icon"),
		)
		.toBe(false);
	await expect(
		menu.getByRole("button", { name: "Attach", exact: true }),
	).toBeVisible();
	await expect(
		cases.getByRole("button", { name: "Attach", exact: true }),
	).toBeVisible();
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
	test(`native content frames ${reducedMotion} respect actual geometry during a Preview flip`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 700 });
		await page.emulateMedia({ reducedMotion });
		await page.goto(`${peer.origin}/?scenario=frame`);
		await expect(
			page.getByRole("button", { name: "Toggle frame preview" }),
		).toBeVisible();
		const samples = await page.evaluate(async () => {
			const button = [...document.querySelectorAll("button")].find(
				(element) => element.textContent === "Toggle frame preview",
			);
			if (!button) throw new Error("Missing frame toggle");
			const read = () =>
				["wide", "small"].map((name) => {
					const frame = document.querySelector(
						`[data-frame-marker="${name}"]`,
					)?.parentElement;
					if (!frame) throw new Error("Missing actual frame");
					const transform = getComputedStyle(frame).transform;
					return {
						left: frame.getBoundingClientRect().left,
						x: transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m41,
					};
				});
			const before = read();
			button.click();
			const frames = [];
			for (let frame = 0; frame < 20; frame += 1) {
				await new Promise<void>((resolve) =>
					requestAnimationFrame(() => resolve()),
				);
				frames.push(read());
			}
			return { before, frames };
		});
		const last = samples.frames.at(-1);
		if (!last) throw new Error("No native frame samples");
		expect(last.map((frame) => frame.x)).toEqual([0, 0]);
		expect(last[0].left).not.toBe(samples.before[0].left);
		if (reducedMotion === "reduce") {
			expect(
				samples.frames.every((frame) => frame.every((box) => box.x === 0)),
			).toBe(true);
		} else {
			expect(samples.frames.some((frame) => Math.abs(frame[0].x) > 1)).toBe(
				true,
			);
			expect(samples.frames.some((frame) => Math.abs(frame[1].x) > 1)).toBe(
				true,
			);
		}
	});
}

test("native content frames settle a running glide when the device enables reduced motion", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1280, height: 700 });
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
	await page.goto(`${peer.origin}/?scenario=frame`);
	const toggle = page.getByRole("button", { name: "Toggle frame preview" });
	await expect(toggle).toBeVisible();
	await page.clock.pauseAt(new Date("2026-01-01T01:00:00Z"));
	const readOffsets = () =>
		page.evaluate(() =>
			["wide", "small"].map((name) => {
				const frame = document.querySelector(
					`[data-frame-marker="${name}"]`,
				)?.parentElement;
				if (!frame) throw new Error("Missing frame");
				const transform = getComputedStyle(frame).transform;
				return transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m41;
			}),
		);
	// Dispatch with the animation clock paused, then observe the actual React
	// commit before advancing Motion. Browser actionability itself needs frames.
	await toggle.evaluate((element: HTMLButtonElement) => element.click());
	await expect(toggle).toHaveAttribute("aria-pressed", "true");
	await page.clock.runFor(32);
	expect((await readOffsets()).every((offset) => Math.abs(offset) > 1)).toBe(
		true,
	);

	await page.emulateMedia({ reducedMotion: "reduce" });
	let elapsed = 32;
	await expect
		.poll(
			async () => {
				await page.clock.runFor(16);
				elapsed += 16;
				return readOffsets();
			},
			{ intervals: [0, 20, 50] },
		)
		.toEqual([0, 0]);
	// Event delivery, React commits and Motion renders need not occupy exactly
	// two frames. Still require interruption: merely waiting out the ordinary
	// 200ms glide must fail, even when a slow CI worker delays the assertion.
	expect(elapsed).toBeLessThan(100);
});

test("native breadcrumb overflow and compact paths preserve complete names, focus, and independent peer targets", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1600, height: 800 });
	await page.goto(`${peer.origin}/?scenario=chrome`);
	const navigation = page.getByRole("navigation", { name: "Page navigation" });
	await expect(
		navigation.getByRole("button", { name: "Home", exact: true }),
	).toBeVisible();
	await navigation
		.getByRole("button", { name: "Go back", exact: true })
		.click();
	await expect(page.getByLabel("Chrome destination")).toHaveText("back");
	const leaf = navigation.locator('[aria-current="location"]');
	await expect(leaf).not.toHaveAttribute("tabindex", "0");
	const targets = page.getByRole("button", {
		name: /^(Follow (Ada|Grace|Linus)|2 more collaborators)$/,
	});
	await expect(targets).toHaveCount(4);
	await expect
		.poll(() =>
			page
				.getByRole("button", { name: "Follow Ada", exact: true })
				.locator("img")
				.evaluate((img: HTMLImageElement) => img.naturalWidth),
		)
		.toBe(12);
	const rectangles = await targets.evaluateAll((nodes) =>
		nodes.map((node) => {
			const r = node.getBoundingClientRect();
			return { left: r.left, right: r.right, width: r.width, height: r.height };
		}),
	);
	for (let index = 0; index < rectangles.length; index += 1) {
		expect(rectangles[index].width).toBeGreaterThanOrEqual(44);
		expect(rectangles[index].height).toBeGreaterThanOrEqual(44);
		if (index)
			expect(rectangles[index].left).toBeGreaterThanOrEqual(
				rectangles[index - 1].right,
			);
	}
	await page
		.getByRole("button", { name: "2 more collaborators", exact: true })
		.click();
	await page.getByRole("menuitem", { name: /Katherine/ }).click();
	await expect(page.getByLabel("Chrome destination")).toHaveText(
		"user-Katherine",
	);
	await page.setViewportSize({ width: 320, height: 780 });
	const path = navigation.getByRole("button", {
		name: "Show breadcrumb path",
		exact: true,
	});
	await expect(path).toBeVisible();
	await expect(leaf).toHaveAttribute("tabindex", "0");
	await path.focus();
	await page.keyboard.press("Tab");
	await expect(leaf).toBeFocused();
	await expect(page.getByRole("tooltip")).toHaveText(
		"Follow-up visits that need a complete authored name in every workspace",
	);
	await path.click();
	await page
		.getByRole("button", {
			name: "Community nutrition and longitudinal care",
			exact: true,
		})
		.click();
	await expect(page.getByLabel("Chrome destination")).toHaveText("module");
	await expect(path).toBeFocused();
	await contained(navigation, 320);
	await page
		.getByRole("button", { name: "Toggle compact chrome", exact: true })
		.click();
	await expect(leaf).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Follow Ada", exact: true }),
	).toHaveCount(0);
	const roster = page.getByRole("button", {
		name: "5 collaborators here",
		exact: true,
	});
	expect(await height(roster)).toBeGreaterThanOrEqual(44);
	await roster.click();
	await expect(page.getByRole("menuitem")).toHaveCount(5);
	await page.getByRole("menuitem", { name: /Ada/ }).click();
	await expect(page.getByLabel("Chrome destination")).toHaveText("user-Ada");
	await expect(roster).toBeFocused();
	await navigation
		.getByRole("button", { name: "Go back", exact: true })
		.click();
	await expect(page.getByLabel("Chrome destination")).toHaveText("back");
});

test("native place choice pages and searches all rows while keeping a refused exact match unselectable", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 850 });
	await page.goto(`${peer.origin}/?scenario=places`);
	const picker = page.getByRole("combobox", { name: "Choose a place" });
	const query = page.getByRole("textbox", { name: "Search choose a place" });
	await picker.click();
	await expect(page.getByRole("option")).toHaveCount(50);
	await expect(
		page.getByRole("option", { name: "Place 51 · place-51", exact: true }),
	).toHaveCount(0);
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "Next", exact: true }).click();
	await picker.click();
	await expect(
		page.getByRole("option", { name: "Place 51 · place-51", exact: true }),
	).toBeVisible();
	await page.keyboard.press("Escape");
	await query.fill("place-120");
	await picker.click();
	await expect(page.getByRole("option")).toHaveCount(1);
	await page
		.getByRole("option", { name: "Place 120 · place-120", exact: true })
		.click();
	await expect(picker).toContainText("Place 120 · place-120");
	await expect(picker).toBeFocused();
	const original = await page.getByLabel("Chosen place").innerText();
	await query.fill("place-119");
	await picker.click();
	const refused = page.getByRole("option", { name: /Place 119/ });
	await expect(refused).toHaveAttribute("aria-disabled", "true");
	await expect(refused).toContainText(
		"This place is outside the permitted address book.",
	);
	await refused.click({ force: true });
	await page.keyboard.press("Enter");
	await expect(page.getByLabel("Chosen place")).toHaveText(original);
	await page.keyboard.press("Escape");
	await query.fill("missing place");
	await picker.click();
	await expect(
		page.getByRole("option", {
			name: "No places match this search",
			exact: true,
		}),
	).toHaveAttribute("aria-disabled", "true");
});

test("native generation milestones retain the failed stage and collapse actual error geometry on recovery", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=progress`);
	const progress = page.getByRole("progressbar", {
		name: "App generation progress",
	});
	await expect(progress).toHaveAttribute("aria-valuenow", "0");
	await expect(page.getByText("Fix", { exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "Begin build", exact: true }).click();
	await expect(progress).toHaveAttribute("aria-valuenow", "50");
	await expect(page.locator('[data-stage="build"]')).toHaveAttribute(
		"aria-current",
		"step",
	);
	await page
		.getByRole("button", { name: "Fail current stage", exact: true })
		.click();
	await expect(page.locator('[data-stage="build"]')).toHaveAttribute(
		"data-status",
		"error",
	);
	await expect(progress).toHaveAttribute("aria-valuenow", "50");
	const region = page.locator("[data-generation-error-region]");
	await expect.poll(() => height(region)).toBeGreaterThan(0);
	const original = await region.elementHandle();
	if (!original) throw new Error("Missing error region");
	await page
		.getByRole("button", { name: "Recover in Fix", exact: true })
		.click();
	await expect
		.poll(async () => Number(await progress.getAttribute("aria-valuenow")))
		.toBeCloseTo(200 / 3);
	await expect(page.locator('[data-stage="fix"]')).toHaveAttribute(
		"aria-current",
		"step",
	);
	await expect(region).toHaveAttribute("aria-hidden", "true");
	await expect.poll(() => height(region)).toBe(0);
	expect(
		await region.evaluate((element, before) => element === before, original),
	).toBe(true);
});

test("native inline validity refuses Enter and blur with the actual Connect identifier rule", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=inline-validation`);
	const input = page.getByRole("textbox", { name: "Connect code" });
	const saved = page.getByLabel("Saved Connect code");
	await input.fill("bad code");
	await expect(input).toHaveAttribute("aria-invalid", "true");
	await expect(input).toHaveAccessibleDescription(/can't contain spaces/);
	await input.press("Enter");
	await expect(saved).toHaveText("starting_code");
	await input.fill("2bad");
	await page.getByRole("button", { name: "Next field" }).click();
	await expect(saved).toHaveText("starting_code");
	await expect(input).toHaveValue("starting_code");
	await input.fill("new_valid_code");
	await expect(input).not.toHaveAttribute("aria-invalid", "true");
	await input.press("Enter");
	await expect(saved).toHaveText("new_valid_code");
});

test("native access status distinguishes viewer capability and retained changes", async ({
	page,
}) => {
	await page.goto(`${peer.origin}/?scenario=access`);
	await page
		.getByRole("button", { name: "Viewer access", exact: true })
		.click();
	await expect(page.getByText("View only", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("status").filter({ hasText: "View-only access" }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Viewer with changes", exact: true })
		.click();
	await expect(
		page.getByText("View only · Changes kept", { exact: true }),
	).toBeVisible();
	await expect(
		page
			.getByRole("status")
			.filter({ hasText: "Your changes are kept in this tab" }),
	).toBeVisible();
});
