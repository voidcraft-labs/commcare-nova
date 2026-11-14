/**
 * Registration from the case list, read back from Nova's emission and from
 * the shapes CommCare HQ's pages store: the hidden menu folded into its host
 * with its form last, every failing test of that shape left an ordinary
 * menu, part 02's rows in order, and the label as HQ's build writes it.
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import { registrationFormLast } from "../registration";
import {
	type AppJson,
	codesOf,
	type JsonObject,
	moduleNamed,
	readMenusOf,
} from "./menuReading";

const M = "menus-and-case-lists";

const visit = {
	name: "Visit",
	type: "followup" as const,
	fields: [
		f({
			kind: "text",
			id: "notes",
			caseWrite: { caseType: "patient", property: "notes" },
		}),
	],
};
const register = {
	uuid: "reg",
	name: "Register",
	type: "registration" as const,
	fields: [
		f({
			kind: "text",
			id: "name",
			caseWrite: { caseType: "patient", property: "case_name" },
		}),
	],
};

/** A host whose forms read the search, offering its registration after an empty search. */
function afterEmptySearch(label?: string): BlueprintDoc {
	return buildDoc({
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				// A list, so the search its forms read is one CommCare HQ runs: the emission
				// writes its zero-input row, and HQ offers a search with a row.
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				caseSearchConfig: { formsReadSearch: true },
				caseListRegistrationForm: {
					formUuid: "reg",
					...(label === undefined ? {} : { label }),
				},
				forms: [visit, register],
			},
		],
	});
}

/** A list that always offers the registration of another menu. */
function always(): BlueprintDoc {
	const doc = buildDoc({
		modules: [
			{ name: "Registration", caseType: "patient", forms: [register] },
			{ name: "Patients", caseType: "patient", forms: [visit] },
		],
	});
	return produce(doc, (draft) => {
		const host = Object.values(draft.modules).find(
			(one) => one.name === "Patients",
		);
		if (host !== undefined)
			host.caseListRegistrationForm = {
				kind: "always",
				formUuid: testUuid("reg"),
				afterSubmit: "case-list",
			};
	});
}

function hiddenMenu(app: AppJson): JsonObject {
	return app.modules[1] as JsonObject;
}

function block(app: AppJson, menu = 0): JsonObject {
	return app.modules[menu]?.case_list_form as JsonObject;
}

function rewrites(reading: Awaited<ReturnType<typeof readMenusOf>>): string[] {
	return reading.outcome.kind === "read"
		? reading.outcome.draft.facts.sameStateRewrites.map((one) => one.register)
		: [];
}

describe("the hidden registration menu", () => {
	it("folds into its host, the form last among the host's forms", async () => {
		const reading = await readMenusOf(afterEmptySearch());
		expect(codesOf(reading)).toEqual([]);
		const doc = reading.doc as BlueprintDoc;
		expect(doc.moduleOrder).toHaveLength(1);
		const host = moduleNamed(doc, "Patients");
		expect(host.caseListRegistrationForm).toEqual({
			kind: "after-empty-search",
			formUuid: expect.any(String),
		});
		const forms = doc.formOrder[host.uuid] ?? [];
		expect(doc.forms[forms[forms.length - 1] as string]?.name).toBe("Register");
		const identities =
			reading.outcome.kind === "read"
				? reading.outcome.draft.identities.modules
				: [];
		expect(identities).toHaveLength(2);
	});

	it("leaves an ordinary hidden menu where a test of the shape fails", async () => {
		for (const edit of [
			(app: AppJson) => {
				hiddenMenu(app).module_filter = "1 = 2";
			},
			(app: AppJson) => {
				block(app).media_image = {
					en: "jr://file/commcare/image/register.png",
				};
			},
			(app: AppJson) => {
				block(app).relevancy_expression = "true()";
			},
		]) {
			const reading = await readMenusOf(afterEmptySearch(), edit);
			const codes = codesOf(reading);
			expect(codes).not.toContain(
				`${M}/case-list-form-on-a-search-first-host-pointing-at-a-registration`,
			);
			if (reading.doc !== undefined)
				expect(
					moduleNamed(reading.doc, "Patients").caseListRegistrationForm?.kind,
				).toBe("always");
		}
	});

	it("is the HELD-NEW row with `post_form_workflow: default`", async () => {
		const reading = await readMenusOf(afterEmptySearch(), (app) => {
			block(app).post_form_workflow = "default";
		});
		expect(codesOf(reading)).toContain(
			`${M}/case-list-form-post-form-workflow-default-on-the-hidden-module-shape`,
		);
	});
});

describe("part 02's rows, first match", () => {
	it("reads a blank form id beside a label as nothing", async () => {
		const reading = await readMenusOf(always(), (app) => {
			const one = block(app, 1);
			one.form_id = "";
		});
		expect(codesOf(reading)).toEqual([]);
		expect(
			moduleNamed(reading.doc as BlueprintDoc, "Patients")
				.caseListRegistrationForm,
		).toBeUndefined();
	});

	it("refuses a form id naming no form", async () => {
		const reading = await readMenusOf(always(), (app) => {
			block(app, 1).form_id = "not-a-form";
		});
		expect(codesOf(reading)).toContain(
			`${M}/case-list-form-missing-not-a-registration-form-toggle-off-or`,
		);
	});

	it("refuses a host some form of which needs no case", async () => {
		const reading = await readMenusOf(always(), (app) => {
			(app.modules[1]?.forms[0] as JsonObject).requires = "none";
		});
		expect(codesOf(reading)).toContain(
			`${M}/case-list-form-on-a-module-whose-forms-do-not-all-require-a-case`,
		);
	});

	it("reads the always arm with its return", async () => {
		const reading = await readMenusOf(always());
		expect(codesOf(reading)).toEqual([]);
		expect(
			moduleNamed(reading.doc as BlueprintDoc, "Patients")
				.caseListRegistrationForm,
		).toEqual({
			kind: "always",
			formUuid: expect.any(String),
			afterSubmit: "case-list",
		});
	});
});

describe("the Register label", () => {
	it("reads a label with no text in any language as HQ's words, with its record", async () => {
		const reading = await readMenusOf(always(), (app) => {
			block(app, 1).label = { en: "" };
		});
		expect(codesOf(reading)).toEqual([]);
		expect(
			moduleNamed(reading.doc as BlueprintDoc, "Patients")
				.caseListRegistrationForm?.label,
		).toBe("Create a new Case");
		expect(rewrites(reading)).toContain("registration-label-fixed");
	});

	it("keeps a label of its own, and none where it is the form's name", async () => {
		const own = await readMenusOf(afterEmptySearch("New patient"));
		expect(codesOf(own)).toEqual([]);
		expect(
			moduleNamed(own.doc as BlueprintDoc, "Patients").caseListRegistrationForm
				?.label,
		).toBe("New patient");
		expect(rewrites(own)).not.toContain("registration-label-fixed");
	});
});

describe("registration-form-last", () => {
	it("moves a registration offered after an empty search to the end of its menu's forms", () => {
		const doc = afterEmptySearch();
		const [host] = doc.moduleOrder;
		const forms = doc.formOrder[host as string] ?? [];
		const reordered = {
			...doc,
			formOrder: { ...doc.formOrder, [host as string]: [...forms].reverse() },
		};
		const canonical = registrationFormLast(reordered);
		const after = canonical.formOrder[host as string] ?? [];
		expect(canonical.forms[after[after.length - 1] as string]?.name).toBe(
			"Register",
		);
		expect(registrationFormLast(canonical)).toBe(canonical);
	});
});
