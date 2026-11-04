/** The case list slots through the shared tools: the menu's registration from
 * the case list (`createForm` / `updateForm` `case_list_registration`) and the
 * case list as its own menu item (`createModule` / `updateModule`
 * `case_list_menu_item`). Each call runs the real tool body, planners and
 * commit gate over an admitted document. */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { BlueprintDoc } from "@/lib/domain";
import { makeAuthoringHarness } from "../../__tests__/authoringHarness";
import { namedFormFixture } from "../../__tests__/namedFormFixture";
import { createFormInputSchema } from "../createForm";
import { updateFormInputSchema } from "../updateForm";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

function moduleNamed(doc: BlueprintDoc, name: string) {
	const found = Object.values(doc.modules).find(
		(candidate) => candidate.name === name,
	);
	if (found === undefined) throw new Error(`Missing module ${name}.`);
	return found;
}

function formNamed(doc: BlueprintDoc, name: string) {
	const found = Object.values(doc.forms).find(
		(candidate) => candidate.name === name,
	);
	if (found === undefined) throw new Error(`Missing form ${name}.`);
	return found;
}

/** A patient menu with a follow-up and a registration, searching by name,
 *  and a bare household case list. Forms that read the search run in Web
 *  Apps alone. The canonical workspace refuses an empty form, so the
 *  registration exists before it moves to the case list; creating one there
 *  is the durable construction suites' (`iterativeCreation.postgres`). */
async function fixture() {
	const h = makeAuthoringHarness(
		{},
		namedFormFixture(
			[
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{ name: "Visit", type: "followup" },
						{ name: "Register", type: "registration" },
					],
				},
				{ name: "Households", caseType: "household", forms: [] },
			],
			{ runsOnlyOn: "web-apps" },
		),
	);
	expect(
		await h.call("addSearchInputs", {
			moduleUuid: "Patients",
			searchInputs: [
				{
					name: "name",
					kind: "simple",
					type: "text",
					label: "Name",
					property: "case_name",
				},
			],
		}),
	).toMatchObject({ ok: true });
	return h;
}

describe("registration from the case list", () => {
	it("refuses the retired entry input on both form tools", () => {
		const moduleUuid = testUuid("registration-schema-module");
		const formUuid = testUuid("registration-schema-form");
		const entry = { kind: "search-no-matches" };
		expect(
			createFormInputSchema.safeParse({
				moduleUuid,
				name: "Register",
				type: "registration",
				entry,
			}).success,
		).toBe(false);
		expect(
			updateFormInputSchema.safeParse({ moduleUuid, formUuid, entry }).success,
		).toBe(false);
		// The new input is the menu's slot, which takes no kind.
		expect(
			createFormInputSchema.safeParse({
				moduleUuid,
				name: "Register",
				type: "registration",
				case_list_registration: entry,
			}).success,
		).toBe(false);
	});

	it("writes the menu's slot and turns on Forms read the search", async () => {
		const h = await fixture();
		expect(
			await h.call("updateForm", {
				formUuid: "Register",
				case_list_registration: { label: "Register a new patient" },
			}),
		).toMatchObject({
			ok: true,
			caseListRegistration: true,
			formsReadSearch: true,
		});
		const doc = h.currentDoc();
		const register = formNamed(doc, "Register");
		const patients = moduleNamed(doc, "Patients");
		expect(patients.caseListRegistrationForm).toEqual({
			kind: "after-empty-search",
			formUuid: register.uuid,
			label: "Register a new patient",
		});
		expect(patients.caseSearchConfig).toMatchObject({ formsReadSearch: true });
		const read = await h.call("getModule", { moduleUuid: "Patients" });
		expect(read).toMatchObject({
			searchWorkflow: "searchFirst",
			formsReadSearch: true,
			caseListRegistrationForm: {
				formUuid: register.uuid,
				label: "Register a new patient",
			},
		});
		if (!isRecord(read) || !Array.isArray(read.forms))
			throw new Error("getModule returned no forms.");
		expect(
			read.forms.map((form: { name: string; opensFromCaseList: boolean }) => [
				form.name,
				form.opensFromCaseList,
			]),
		).toEqual([
			["Visit", false],
			["Register", true],
		]);
	});

	it("restores a menu form with null, turning Forms read the search off and removing Search-based starting values", async () => {
		const h = await fixture();
		expect(
			await h.call("updateForm", {
				formUuid: "Register",
				case_list_registration: {},
			}),
		).toMatchObject({ ok: true });
		expect(
			await h.call("addFields", {
				formUuid: "Register",
				fields: [
					{
						kind: "text",
						id: "searched_name",
						label: "Name",
						default_value: "#search/name",
					},
				],
			}),
		).toMatchObject({ ok: true });
		const field = Object.values(h.currentDoc().fields).find(
			(candidate) => candidate.id === "searched_name",
		);
		if (field === undefined) throw new Error("Missing carried answer.");

		const cleared = await h.call("updateForm", {
			formUuid: "Register",
			case_list_registration: null,
		});
		expect(cleared).toMatchObject({
			ok: true,
			caseListRegistration: false,
			formsReadSearch: false,
			clearedSearchDefaults: [field.uuid],
		});
		const doc = h.currentDoc();
		const patients = moduleNamed(doc, "Patients");
		expect(patients.caseListRegistrationForm).toBeUndefined();
		expect(patients.caseSearchConfig ?? {}).not.toHaveProperty(
			"formsReadSearch",
		);
		expect(doc.fields[field.uuid]).not.toHaveProperty("default_value");
		expect(doc.formOrder[patients.uuid]).toContain(
			formNamed(doc, "Register").uuid,
		);
	});
});

describe("the case list as its own menu item", () => {
	it("adds the item beside a menu's forms and takes it off again", async () => {
		const h = await fixture();
		expect(
			await h.call("updateModule", {
				moduleUuid: "Patients",
				case_list_menu_item: { label: "All patients" },
			}),
		).toMatchObject({ ok: true, caseListMenuItem: true });
		expect(moduleNamed(h.currentDoc(), "Patients").caseListMenuItem).toEqual({
			label: "All patients",
		});
		expect(await h.call("getModule", { moduleUuid: "Patients" })).toMatchObject(
			{ caseListMenuItem: { label: "All patients" } },
		);

		expect(
			await h.call("updateModule", {
				moduleUuid: "Patients",
				case_list_menu_item: null,
			}),
		).toMatchObject({ ok: true, caseListMenuItem: false });
		expect(
			moduleNamed(h.currentDoc(), "Patients").caseListMenuItem,
		).toBeUndefined();
		expect(await h.call("getModule", { moduleUuid: "Patients" })).toMatchObject(
			{ caseListMenuItem: null },
		);
	});

	it("refuses taking the item off a menu with no forms", async () => {
		const h = await fixture();
		const before = h.currentDoc();
		expect(moduleNamed(before, "Households").caseListMenuItem).toBeDefined();
		const result = await h.call("updateModule", {
			moduleUuid: "Households",
			case_list_menu_item: null,
		});
		expect(result).toMatchObject({
			error: expect.stringContaining("has no forms on its menu"),
		});
		expect(h.currentDoc()).toBe(before);
	});
});
