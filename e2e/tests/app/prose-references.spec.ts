import AdmZip from "adm-zip";
import { expect, seedFor, test } from "../../lib/appFixtures";
import { FORM_SECTIONS_SEED } from "../../lib/formSectionsSeed";

const source = FORM_SECTIONS_SEED.aboutYou.nameFieldUuid;
test.use({ actionTimeout: 15_000 });

test("inspector explicitly converts literal references, preserves drafts and saves identities", {
	tag: "@seed:sections",
}, async ({ page, scenario, request }) => {
	const { formSections } = seedFor(scenario, "sections");
	await page.goto(formSections.route);
	await page
		.getByRole("button", { name: "Your name", exact: true })
		.first()
		.click();
	const properties = page.getByRole("dialog", {
		name: "Properties",
		exact: true,
	});
	await properties.getByRole("button", { name: "Hint", exact: true }).click();
	const hint = properties.getByRole("textbox", { name: "Hint", exact: true });
	await hint.fill("#form/about_you/your_name");
	await expect(page.getByRole("listbox", { name: "References" })).toBeVisible();
	await hint.press("Escape");
	await expect(hint).toHaveText("#form/about_you/your_name");
	await expect(hint).toBeFocused();
	await expect(hint.locator("[data-ref-raw]")).toHaveCount(0);
	await hint.press("ControlOrMeta+a");
	await properties
		.getByRole("button", { name: "Convert to reference", exact: true })
		.click();
	const search = page.getByRole("combobox", { name: "Search references" });
	await expect(search).toBeFocused();
	await search.press("Escape");
	await expect(hint).toBeFocused();
	await expect(hint).toHaveText("#form/about_you/your_name");
	await properties
		.getByRole("button", { name: "Convert to reference", exact: true })
		.click();
	await page
		.getByRole("option", {
			name: "Your name #form/about_you/your_name",
			exact: true,
		})
		.click();
	await expect(
		hint.locator('[data-ref-raw="#form/about_you/your_name"]'),
	).toBeVisible();
	await hint.press("ControlOrMeta+z");
	await expect(hint.locator("[data-ref-raw]")).toHaveCount(0);
	await expect(hint).toHaveText("#form/about_you/your_name");
	await hint.press("ControlOrMeta+Shift+z");
	await expect(hint.locator("[data-ref-raw]")).toHaveCount(1);
	// Enter saves this single-line inspector; it must not split a paragraph.
	await hint.press("Enter");
	await expect(hint).not.toBeFocused();
	await expect
		.poll(
			async () =>
				(await (await request.get(`/api/apps/${formSections.appId}`)).json())
					.blueprint.fields[source].hint,
		)
		.toEqual({ parts: [{ kind: "field-ref", uuid: source }] });
	await page.reload();
	await expect(
		properties.getByRole("textbox", { name: "Hint" }).locator("[data-ref-raw]"),
	).toHaveCount(1);
	const loaded = properties.getByRole("textbox", { name: "Hint" });
	// Identity survives renaming, and both live preview and the downloadable
	// device artifact use the new path rather than the old display string.
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	await page
		.getByRole("main")
		.getByRole("textbox", { name: "Your name" })
		.fill("Asha");
	await expect(
		page.getByRole("main").getByText("Asha", { exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "Back to edit", exact: true }).click();
	const renamedId = properties.getByRole("textbox").first();
	await renamedId.fill("given_name");
	await renamedId.press("Enter");
	await expect(
		loaded.locator('[data-ref-raw="#form/about_you/given_name"]'),
	).toBeVisible();
	await expect
		.poll(
			async () =>
				(await (await request.get(`/api/apps/${formSections.appId}`)).json())
					.blueprint.fields[source].id,
		)
		.toBe("given_name");
	const archive = await request.post("/api/compile", {
		data: { appId: formSections.appId, server: "production" },
	});
	expect(archive.status()).toBe(200);
	const xform = new AdmZip(await archive.body()).readAsText(
		"modules-0/forms-0.xml",
	);
	expect(xform).toContain('<output value="/data/about_you/given_name"');
	expect(xform).not.toContain("#form/about_you/your_name");
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	await expect(
		page.getByRole("main").getByRole("textbox", { name: "Your name" }),
	).toHaveValue("Asha");
	await expect(
		page.getByRole("main").getByText("Asha", { exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "Back to edit", exact: true }).click();
	await loaded.locator("[data-ref-raw]").click();
	await properties
		.getByRole("button", { name: "Replace reference", exact: true })
		.click();
	await page
		.getByRole("button", { name: "Convert to text", exact: true })
		.click();
	await expect(loaded).toHaveText("#form/about_you/given_name");
	await expect(loaded.locator("[data-ref-raw]")).toHaveCount(0);
	// An outside click commits, and keeps focus on the intended next field.
	await properties
		.getByRole("button", { name: "Insert reference", exact: true })
		.click();
	await search.fill("no_such_reference");
	await expect(
		page.getByRole("status").filter({ hasText: "No matching references" }),
	).toBeVisible();
	const fieldId = properties.getByRole("textbox").first();
	await fieldId.click();
	await expect(fieldId).toBeFocused();
	await expect
		.poll(
			async () =>
				(await (await request.get(`/api/apps/${formSections.appId}`)).json())
					.blueprint.fields[source].hint,
		)
		.toEqual({ parts: [{ kind: "text", text: "#form/about_you/given_name" }] });
	await page.setViewportSize({ width: 500, height: 713 });
	await properties
		.getByRole("button", { name: "Insert reference", exact: true })
		.click();
	await expect(search).toBeFocused();
	const picker = page.getByRole("dialog", {
		name: "Insert reference",
		exact: true,
	});
	await expect(picker).toBeVisible();
	await expect
		.poll(async () => {
			const bounds = await picker.boundingBox();
			return bounds ? bounds.y + bounds.height : Number.POSITIVE_INFINITY;
		})
		.toBeLessThanOrEqual(713);
	// The search owns list navigation. Tab leaves the picker instead of
	// stranding focus in Chrome's automatically focusable scroll container.
	await search.press("Tab");
	await expect(picker).toHaveCount(0);
	await expect(
		properties.getByRole("button", { name: "Label media", exact: true }),
	).toBeFocused();
});

test("canvas reference picker supports keyboard insertion, replacement and literal text", {
	tag: "@seed:sections",
}, async ({ page, scenario, request }) => {
	const { formSections } = seedFor(scenario, "sections");
	await page.goto(formSections.route);
	const main = page.getByRole("main");
	await main.getByRole("button", { name: "Your name", exact: true }).click();
	const label = main.getByRole("textbox", { name: "Label", exact: true });
	await page.setViewportSize({ width: 980, height: 850 });
	await label.fill("Hello ");
	await page
		.getByRole("button", { name: "Insert reference", exact: true })
		.click();
	const search = page.getByRole("combobox", { name: "Search references" });
	const picker = page.getByRole("dialog", {
		name: "Insert reference",
		exact: true,
	});
	await expect(picker).toBeVisible();
	const bounds = await picker.boundingBox();
	expect(bounds).not.toBeNull();
	if (!bounds) throw new Error("Reference picker has no bounds");
	expect(bounds.x).toBeGreaterThanOrEqual(0);
	expect(bounds.x + bounds.width).toBeLessThanOrEqual(980);
	await search.fill("first");
	await search.press("Space");
	await search.pressSequentially("name");
	await expect(search).toHaveValue("first name");
	await search.press("Enter");
	await expect(label).toBeFocused();
	await expect(
		label.locator('[data-ref-raw="#user/commcare_first_name"]'),
	).toBeVisible();
	await label.locator("[data-ref-raw]").click();
	await label.press("ControlOrMeta+b");
	await page
		.getByRole("button", { name: "Replace reference", exact: true })
		.click();
	await search.fill("commcare_last_name");
	await search.press("Enter");
	await expect(
		label.locator('[data-ref-raw="#user/commcare_last_name"]'),
	).toBeVisible();
	await expect(
		label.locator("strong [data-ref-raw], b [data-ref-raw]"),
	).toHaveCount(1);
	// Selecting and deleting a chip removes one atom; undo restores its identity.
	await label.locator("[data-ref-raw]").click();
	await label.press("Backspace");
	await expect(label.locator("[data-ref-raw]")).toHaveCount(0);
	await expect(label).toHaveText("Hello ");
	await label.press("ControlOrMeta+z");
	await expect(
		label.locator('[data-ref-raw="#user/commcare_last_name"]'),
	).toBeVisible();
	await label.press("ControlOrMeta+Enter");
	await expect(label).toHaveCount(0);
	await expect
		.poll(
			async () =>
				(await (await request.get(`/api/apps/${formSections.appId}`)).json())
					.blueprint.fields[source].label.parts,
		)
		.toEqual([
			{ kind: "text", text: "Hello **" },
			{ kind: "user-ref", property: "commcare_last_name" },
			{ kind: "text", text: "**" },
		]);
	await page.reload();
	await expect(
		main.locator('[data-ref-raw="#user/commcare_last_name"]'),
	).toBeVisible();
});

test("hashtag suggestions select namespaces and references without ending the draft", {
	tag: "@seed:sections",
}, async ({ page, scenario }) => {
	const { formSections } = seedFor(scenario, "sections");
	await page.goto(formSections.route);
	const main = page.getByRole("main");
	await main.getByRole("button", { name: "Your name", exact: true }).click();
	const label = main.getByRole("textbox", { name: "Label", exact: true });
	await label.fill("#");
	await expect(
		page.getByRole("option", { name: "#form/ Form field", exact: true }),
	).toBeVisible();
	await label.press("Enter");
	await expect(label).toHaveText("#form/");
	await expect(
		page.getByRole("option", {
			name: "Your name #form/about_you/your_name",
			exact: true,
		}),
	).toBeVisible();
	await label.press("Enter");
	await expect(
		label.locator('[data-ref-raw="#form/about_you/your_name"]'),
	).toBeVisible();
	await label.press("End");
	await label.pressSequentially(" #user/commcare_first");
	await page
		.getByRole("option", { name: /#user\/commcare_first_name/ })
		.click();
	await expect(label.locator("[data-ref-raw]")).toHaveCount(2);
	await page
		.getByRole("button", { name: "Insert reference", exact: true })
		.click();
	await label.click();
	await expect(
		page.getByRole("combobox", { name: "Search references" }),
	).toHaveCount(0);
	await expect(label).toBeVisible();
	await expect(label).toBeFocused();
	await label.press("Escape");
	await expect(
		main.getByRole("button", { name: "Your name", exact: true }),
	).toBeVisible();
});
