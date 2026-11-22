import { expect, seedFor, test } from "../../lib/appFixtures";
import { FORM_SECTIONS_SEED } from "../../lib/formSectionsSeed";
import { openBuilder, reloadBuilder } from "../../lib/pageLoads";

test("a submitted answer can move to another group while its question stays on the same page", {
	tag: "@seed:sections",
}, async ({ scenario, page, request }) => {
	const { formSections } = seedFor(scenario, "sections");
	const { aboutYou, yourVisit } = FORM_SECTIONS_SEED;
	await openBuilder(page, formSections.route);
	await page
		.getByRole("button", { name: aboutYou.nameLabel, exact: true })
		.first()
		.click();
	await page
		.getByRole("button", { name: "Field actions", exact: true })
		.click();
	await page
		.getByRole("menuitem", { name: "Place submitted answer", exact: true })
		.click();
	const dialog = page.getByRole("dialog", {
		name: "Place the submitted answer",
	});
	await dialog.getByRole("combobox", { name: "Group", exact: true }).click();
	await page
		.getByRole("option", { name: yourVisit.title, exact: true })
		.click();
	const saved = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname === `/api/apps/${formSections.appId}` &&
			response.request().method() === "PUT" &&
			response.request().postData()?.includes('"where":"submission"') === true,
	);
	await dialog
		.getByRole("button", { name: "Save position", exact: true })
		.click();
	expect((await saved).ok()).toBe(true);
	const snapshot = await request.get(`/api/apps/${formSections.appId}`);
	expect(snapshot.ok()).toBe(true);
	const { blueprint } = await snapshot.json();
	expect(blueprint.fieldOrder[aboutYou.uuid]).toContain(aboutYou.nameFieldUuid);
	expect(blueprint.fields[aboutYou.nameFieldUuid].submissionPlacement).toEqual({
		parent: yourVisit.uuid,
		position: 1,
	});
	await reloadBuilder(page);
	const main = page.getByRole("main");
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	await page
		.getByRole("button", { name: /^Running as .* in Web Apps\./ })
		.click();
	await page.getByRole("menuitemradio", { name: /^Android/ }).click();
	await main.getByRole("button", { name: "Start", exact: true }).click();
	await main
		.getByRole("button", {
			name: new RegExp(`^${FORM_SECTIONS_SEED.moduleName}`),
		})
		.click();
	await main
		.getByRole("button", { name: FORM_SECTIONS_SEED.formName, exact: true })
		.click();
	await expect(
		main.getByRole("heading", { name: aboutYou.title, level: 2 }),
	).toBeVisible();
	await main.getByRole("textbox", { name: aboutYou.nameLabel }).fill("Jo");
	await main.getByRole("button", { name: "Next", exact: true }).click();
	await expect(
		main.getByRole("heading", { name: yourVisit.title, level: 2 }),
	).toBeVisible();
	await expect(
		main.getByRole("textbox", { name: aboutYou.nameLabel }),
	).toHaveCount(0);
	await expect(
		main.getByRole("textbox", { name: yourVisit.noteLabel }),
	).toBeVisible();
});
