import { resolve } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { blueprintDocSchema } from "../../../lib/domain";
import { componentPeer } from "../../lib/componentPeer";
import { expect, test } from "../../lib/fixtures";

let peer: Awaited<ReturnType<typeof componentPeer>>;
test.use({ actionTimeout: 10_000 });
test.beforeAll(async () => {
	peer = await componentPeer("e2e/lib/builder-tree-client.tsx", [], {
		"@/lib/organization/actions": resolve(
			"e2e/lib/builder-workflows-boundary.ts",
		),
		"@/lib/lookup/actions": resolve("e2e/lib/builder-workflows-boundary.ts"),
		"@/lib/preview/engine/caseDataBinding": resolve(
			"e2e/lib/builder-tree-boundary.ts",
		),
		"@/lib/preview/engine/casePropertyRenamePreflight": resolve(
			"e2e/lib/builder-data-boundary.ts",
		),
	});
});
test.afterAll(async () => {
	await peer?.close();
});
async function saved(page: Page) {
	return blueprintDocSchema.parse(
		JSON.parse(
			(await page.getByLabel("Saved blueprint").textContent()) ?? "null",
		),
	);
}
async function touchTarget(locator: Locator) {
	const box = await locator.boundingBox();
	expect(box).not.toBeNull();
	expect(box?.height).toBeGreaterThanOrEqual(43.5);
	expect(box?.width).toBeGreaterThanOrEqual(43.5);
}

test("native tree search filters actual entities, reveals their path, and keeps independent keyboard selection", async ({
	page,
}) => {
	await page.goto(peer.origin);
	const structure = page.getByRole("region", {
		name: "Structure",
		exact: true,
	});
	const doc = await saved(page);
	const visits = Object.values(doc.modules).find((m) => m.name === "Visits");
	const form = Object.values(doc.forms).find((f) => f.name === "Follow up");
	const field = Object.values(doc.fields).find((f) => f.id === "home_address");
	if (!visits || !form || !field) throw new Error("Missing named tree fixture");
	const collapse = structure.getByRole("button", {
		name: "Collapse Care",
		exact: true,
	});
	await touchTarget(collapse);
	await collapse.focus();
	await collapse.press("Enter");
	await expect(
		structure.getByRole("button", { name: "Visits", exact: true }),
	).toHaveCount(0);
	await expect(page).toHaveURL(/\/a\/native-app-tree$/);
	const search = page.getByRole("textbox", { name: "Find in app" });
	await touchTarget(search);
	await search.fill("home_address");
	await expect(
		structure.getByRole("button", { name: "Home address", exact: true }),
	).toBeVisible();
	await expect(
		structure.getByRole("button", { name: "Outreach", exact: true }),
	).toHaveCount(0);
	await expect(
		structure.getByRole("button", { name: "Add module", exact: true }),
	).toHaveCount(0);
	await structure
		.getByRole("button", { name: "Home address", exact: true })
		.focus();
	await page.keyboard.press("Space");
	await expect(page).toHaveURL(new RegExp(`/${field.uuid}$`));
	await expect(
		structure.getByRole("button", { name: "Home address", exact: true }),
	).toHaveAttribute("aria-current", "page");
	await search.fill("no-match-zzzz");
	await expect(
		page.getByText("No matches in your app", { exact: true }),
	).toBeVisible();
	await search.press("Escape");
	await expect(search).toHaveValue("");
	await expect(
		structure.getByRole("button", { name: "Outreach", exact: true }),
	).toBeVisible();
	await search.fill("Visit");
	await page.getByRole("button", { name: "Clear search", exact: true }).click();
	await expect(search).toHaveValue("");
});

test("native expanded and compact tree keep a case-list parent menu separate from Results", async ({
	page,
}) => {
	await page.goto(peer.origin);
	const structure = page.getByRole("region", {
		name: "Structure",
		exact: true,
	});
	const doc = await saved(page);
	const care = Object.values(doc.modules).find((m) => m.name === "Care");
	const visits = Object.values(doc.modules).find((m) => m.name === "Visits");
	const form = Object.values(doc.forms).find((f) => f.name === "Follow up");
	if (!care || !visits || !form) throw new Error("Missing tree fixture");
	await expect(
		structure.getByText("Patient cases", { exact: true }),
	).toBeVisible();
	await structure.getByRole("button", { name: "Care", exact: true }).click();
	await expect(page).toHaveURL(new RegExp(`/${care.uuid}$`));
	await structure.getByRole("button", { name: /^Cases Search/ }).click();
	await expect(page).toHaveURL(new RegExp(`/${care.uuid}/results$`));
	await page.getByRole("button", { name: "Show compact structure" }).click();
	await structure.getByRole("button", { name: "Care", exact: true }).click();
	await expect(page).toHaveURL(new RegExp(`/${care.uuid}$`));
	await structure
		.getByRole("button", { name: "Care, case list and search", exact: true })
		.click();
	await expect(page).toHaveURL(new RegExp(`/${care.uuid}/results$`));
	const target = structure.getByRole("button", {
		name: "Care › Visits › Follow up",
		exact: true,
	});
	await touchTarget(target);
	await target.focus();
	await target.press("Enter");
	await expect(page).toHaveURL(new RegExp(`/${form.uuid}$`));
	await structure
		.getByRole("button", { name: "Expand structure sidebar" })
		.click();
	await expect(
		structure.getByRole("button", { name: "Follow up", exact: true }),
	).toHaveAttribute("aria-current", "page");
});

test("native insertion menus commit admitted modules, submenus and forms in the chosen parent", async ({
	page,
}) => {
	await page.goto(peer.origin);
	const before = await saved(page);
	const care = Object.values(before.modules).find((m) => m.name === "Care");
	const outreach = Object.values(before.modules).find(
		(m) => m.name === "Outreach",
	);
	if (!care || !outreach) throw new Error("Missing modules");
	await page.getByRole("button", { name: "Add module", exact: true }).click();
	const popup = page.getByRole("dialog", { name: "Add module", exact: true });
	await touchTarget(popup.getByRole("button", { name: /Case list Manages/ }));
	await popup.getByRole("button", { name: /Case list Manages/ }).click();
	await popup
		.getByRole("button", { name: "Back to module choices", exact: true })
		.click();
	await popup.getByRole("button", { name: /Case list Manages/ }).click();
	await popup
		.getByRole("button", { name: "Patient case", exact: true })
		.click();
	let doc = await saved(page);
	const newRoot = doc.moduleOrder.at(-1);
	if (!newRoot) throw new Error("New root missing");
	expect(doc.moduleOrder.slice(0, -1)).toEqual(before.moduleOrder);
	expect(doc.modules[newRoot]).toMatchObject({
		caseType: "patient_case",
		caseListOnly: true,
	});
	expect(doc.formOrder[newRoot]).toEqual([]);
	await expect(page).toHaveURL(new RegExp(`/${newRoot}/results$`));
	await page
		.getByRole("list", { name: "Care submenus", exact: true })
		.getByRole("button", { name: "Add submenu", exact: true })
		.click();
	await page
		.getByRole("dialog", { name: "Add submenu", exact: true })
		.getByRole("button", { name: /Survey Forms without cases/ })
		.click();
	doc = await saved(page);
	const child = Object.values(doc.modules).find(
		(m) => !before.modules[m.uuid] && m.parentModuleUuid === care.uuid,
	);
	if (!child) throw new Error("New submenu missing");
	expect(doc.formOrder[child.uuid]).toHaveLength(1);
	await expect(page).toHaveURL(new RegExp(`/${child.uuid}$`));
	await page
		.getByRole("list", { name: "Outreach forms", exact: true })
		.getByRole("button", { name: "Add form", exact: true })
		.click();
	await expect(
		page.getByRole("menuitem", { name: /Registration Needs a case type/ }),
	).toBeDisabled();
	await page
		.getByRole("menuitem", { name: /Survey Collects data without a case/ })
		.click();
	doc = await saved(page);
	expect(doc.formOrder[outreach.uuid]).toHaveLength(2);
	const newForm = doc.formOrder[outreach.uuid][1];
	expect(doc.forms[newForm].type).toBe("survey");
	expect(doc.fieldOrder[newForm].length).toBeGreaterThan(0);
	await expect(page).toHaveURL(new RegExp(`/${newForm}$`));
});

test("native module placement moves actual membership and returns focus after reparenting", async ({
	page,
}) => {
	await page.goto(peer.origin);
	const before = await saved(page);
	const care = Object.values(before.modules).find((m) => m.name === "Care");
	const outreach = Object.values(before.modules).find(
		(m) => m.name === "Outreach",
	);
	if (!care || !outreach) throw new Error("Missing modules");
	await page
		.getByRole("button", { name: "Collapse Care", exact: true })
		.click();
	const actions = page.getByRole("button", {
		name: "Module actions for Outreach",
		exact: true,
	});
	await touchTarget(actions);
	await actions.click();
	await page
		.getByRole("menuitem", { name: "Move to menu", exact: true })
		.hover();
	await page.getByRole("menuitem", { name: "Care", exact: true }).click();
	await expect(actions).toBeFocused();
	await expect(
		page
			.getByRole("list", { name: "Care submenus", exact: true })
			.getByRole("button", { name: "Outreach", exact: true }),
	).toBeVisible();
	let doc = await saved(page);
	expect(doc.modules[outreach.uuid].parentModuleUuid).toBe(care.uuid);
	expect(doc.formOrder[outreach.uuid]).toEqual(before.formOrder[outreach.uuid]);
	await actions.click();
	await page
		.getByRole("menuitem", { name: "Make top-level", exact: true })
		.click();
	doc = await saved(page);
	expect(doc.modules[outreach.uuid].parentModuleUuid).toBeUndefined();
	await expect(actions).toBeFocused();
	await actions.click();
	await page.getByRole("menuitem", { name: "Move up", exact: true }).click();
	await expect(actions).toBeFocused();
	doc = await saved(page);
	expect(
		doc.moduleOrder.filter((uuid) => !doc.modules[uuid].parentModuleUuid),
	).toEqual([outreach.uuid, care.uuid]);
	await page.getByRole("textbox", { name: "Find in app" }).fill("Outreach");
	await actions.click();
	await expect(
		page.getByRole("menuitem", { name: /Move up Clear search to reorder/ }),
	).toBeDisabled();
	await expect(
		page.getByRole("menuitem", { name: "Move down", exact: true }),
	).toBeDisabled();
});

test("native tree delete cancellation and actual last-form refusal preserve identity and focus", async ({
	page,
}) => {
	await page.goto(peer.origin);
	const before = await saved(page);
	const formList = page.getByRole("list", {
		name: "Outreach forms",
		exact: true,
	});
	const remove = formList.getByRole("button", {
		name: "Delete form",
		exact: true,
	});
	await remove.focus();
	await remove.press("Enter");
	const confirm = formList.getByRole("button", {
		name: "Confirm delete form",
		exact: true,
	});
	await expect(confirm).toBeFocused();
	await touchTarget(confirm);
	await confirm.press("Escape");
	await expect(remove).toBeFocused();
	expect(await saved(page)).toEqual(before);
	await remove.press("Enter");
	await expect(confirm).toBeFocused();
	await confirm.press("Enter");
	await expect(remove).toBeFocused();
	expect(await saved(page)).toEqual(before);
	await expect(
		page.getByText(/needs at least one form|needs a form|add a form/i),
	).toBeVisible();
});

test("native viewer and unfinished-build states withhold write actions and lock selection", async ({
	page,
}) => {
	await page.goto(`${peer.origin}?scenario=viewer`);
	await expect(
		page.getByRole("button", { name: /Module actions for/ }),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Add module", exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Delete form", exact: true }),
	).toHaveCount(0);
	await page.getByRole("button", { name: "Care", exact: true }).click();
	await expect(page.getByLabel("Current route")).toContainText(
		'"kind":"module"',
	);
	await page.goto(`${peer.origin}?scenario=locked`);
	await expect(
		page.getByRole("textbox", { name: "Find in app" }),
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Care", exact: true }),
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Add module", exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: /Module actions for/ }),
	).toHaveCount(0);
});
