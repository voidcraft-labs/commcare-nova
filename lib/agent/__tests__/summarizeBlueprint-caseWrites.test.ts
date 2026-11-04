/**
 * `summarizeBlueprint` × the case-write lines: a form's open and close
 * conditions print as the form logic `updateForm` takes, through the
 * printer, and each question names where its answer saves. Documents are
 * built through the fixture builder and admitted by the real gate.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	carryVisit,
	HOUSEHOLDS,
	kindFixture,
	publishedAdvanced,
	publishedBasic,
} from "@/lib/doc/__tests__/moduleKindMoveFixture";
import {
	FOLLOWUP,
	holdPlanned,
	holdVisits,
	moveFixture,
	verdict,
} from "@/lib/doc/__tests__/placementMoveFixture";
import { type BlueprintDoc, simpleSearchInputDef } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { summarizeBlueprint } from "../summarizeBlueprint";
import { expectAdmittedDoc } from "./admittedFixture";

function lifecycleDoc(conditions: { open?: string; close?: string }) {
	return expectAdmittedDoc(
		buildDoc({
			appName: "Loans",
			caseTypes: [
				{
					name: "loan",
					properties: [
						{ name: "amount", label: proseText("Amount") },
						{ name: "outcome", label: proseText("Outcome") },
					],
				},
			],
			modules: [
				{
					name: "Loans",
					caseType: "loan",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Register loan",
							type: "registration",
							...(conditions.open !== undefined && {
								openCondition: conditions.open,
							}),
							fields: [
								f({
									id: "borrower",
									kind: "text",
									label: proseText("Borrower"),
									caseWrite: { caseType: "loan", property: "case_name" },
								}),
								f({
									id: "consent",
									kind: "single_select",
									label: proseText("Consent"),
									options: [
										{ value: "yes", label: "Yes" },
										{ value: "no", label: "No" },
									],
								}),
							],
						},
						{
							name: "Close loan",
							type: "close",
							...(conditions.close !== undefined && {
								closeCondition: conditions.close,
							}),
							fields: [
								f({
									id: "outcome",
									kind: "single_select",
									label: proseText("Outcome"),
									options: [
										{ value: "repaid", label: "Repaid" },
										{ value: "written_off", label: "Written off" },
									],
									caseWrite: { caseType: "loan", property: "outcome" },
								}),
							],
						},
					],
				},
			],
		}),
	);
}

/** The summary lines of the form named `name`, up to the next form. */
function formLines(summary: string, name: string): string[] {
	const lines = summary.split("\n");
	const start = lines.findIndex((line) => line.includes(`Form "${name}"`));
	if (start < 0) throw new Error(`Missing form ${name}.`);
	const end = lines.findIndex(
		(line, index) => index > start && line.includes("- Form "),
	);
	return lines.slice(start, end < 0 ? undefined : end);
}

describe("summarizeBlueprint — case writes", () => {
	it("prints a close form's close condition as form logic", () => {
		const summary = summarizeBlueprint(
			lifecycleDoc({ close: "#form/outcome = 'repaid'" }),
		);
		expect(formLines(summary, "Close loan")).toContain(
			"    close when: #form/outcome = 'repaid'",
		);
	});

	it("prints a registration's open condition as form logic", () => {
		const summary = summarizeBlueprint(
			lifecycleDoc({ open: "#form/consent = 'yes'" }),
		);
		expect(formLines(summary, "Register loan")).toContain(
			"    open when: #form/consent = 'yes'",
		);
	});

	it("prints no condition line for a form without one", () => {
		const summary = summarizeBlueprint(lifecycleDoc({}));
		expect(summary).not.toContain("close when:");
		expect(summary).not.toContain("open when:");
	});

	it("names where each question's answer saves, read off the case changes", () => {
		const summary = summarizeBlueprint(lifecycleDoc({}));
		expect(
			formLines(summary, "Register loan").some(
				(line) =>
					line.includes("- borrower ") && line.endsWith("→ loan.case_name"),
			),
		).toBe(true);
		expect(
			formLines(summary, "Close loan").some(
				(line) =>
					line.includes("- outcome ") && line.endsWith("→ loan.outcome"),
			),
		).toBe(true);
	});
});

describe("summarizeBlueprint — what a published app keeps", () => {
	/** The follow-up visit as a publish recorded it: its own case kept where
	 *  the placement planner put it, and its query repeat's rows set when the
	 *  form opens. */
	function published() {
		// A new document object: the fixture holds placements by changing the
		// document it planned them over, and the plans are memoized per
		// document.
		return expectAdmittedDoc({
			...holdVisits(holdPlanned(moveFixture(), FOLLOWUP), "model-iteration"),
		});
	}

	it("says where a form's held own case is kept", () => {
		const followUp = formLines(
			summarizeBlueprint(published()),
			"Follow-up visit",
		);
		expect(followUp).toContain("    own case kept in case management");
		const unheld = summarizeBlueprint(expectAdmittedDoc(moveFixture()));
		expect(unheld).not.toContain("own case kept in");
	});

	it("marks a held query repeat's rows as kept", () => {
		const visits = (summary: string) =>
			formLines(summary, "Follow-up visit").find((line) =>
				line.includes("- visits "),
			);
		expect(visits(summarizeBlueprint(published()))).toMatch(
			/\[rows set when opened, kept\]$/,
		);
		expect(
			visits(summarizeBlueprint(expectAdmittedDoc(moveFixture()))),
		).toMatch(/\[rows set when opened\]$/);
	});
});

describe("summarizeBlueprint — how CommCare HQ receives a menu", () => {
	/** The header line of the module named `name`. */
	function moduleHeader(doc: BlueprintDoc, name: string): string {
		const header = summarizeBlueprint(doc)
			.split("\n")
			.find((line) => line.includes(`- Module "${name}"`));
		if (header === undefined) throw new Error(`Missing module ${name}.`);
		return header;
	}

	/** `doc` after the household visit creates a visit and carries it to
	 *  the visit's review, through the real commit gate. */
	function carried(doc: BlueprintDoc): BlueprintDoc {
		const result = verdict(doc, carryVisit());
		if (!result.ok) throw new Error("The carried create was refused.");
		return result.nextDoc;
	}

	it("marks a menu a carried create makes advanced", () => {
		const doc = carried(kindFixture());
		expect(moduleHeader(doc, "Households")).toMatch(/ \[advanced\]/);
		// The review's menu carries nothing and stays ordinary.
		expect(moduleHeader(doc, "Visits")).not.toContain("[advanced");
	});

	it("marks a menu a published app keeps advanced as kept", () => {
		const doc = expectAdmittedDoc(publishedAdvanced(kindFixture(), HOUSEHOLDS));
		expect(moduleHeader(doc, "Households")).toContain(" [advanced, kept]");
	});

	it("marks no ordinary menu, published or not", () => {
		for (const doc of [
			expectAdmittedDoc(kindFixture()),
			expectAdmittedDoc(publishedBasic(kindFixture(), HOUSEHOLDS)),
		])
			expect(moduleHeader(doc, "Households")).not.toContain("[advanced");
	});
});

describe("summarizeBlueprint — the menu's case list and search", () => {
	/** A patient menu with the case list in it beside its follow-up, a
	 *  search whose forms read it, and a registration from the case list. */
	function searchingDoc(workflow?: "skipToResults"): BlueprintDoc {
		return expectAdmittedDoc(
			buildDoc({
				appName: "Clinic",
				caseTypes: [
					{
						name: "patient",
						properties: [{ name: "case_name", label: proseText("Name") }],
					},
				],
				modules: [
					{
						name: "Patients",
						caseType: "patient",
						caseListMenuItem: {},
						caseListConfig: {
							...caseListConfig([{ field: "case_name", header: "Name" }]),
							searchInputs: [
								simpleSearchInputDef(
									testUuid("summary-name-search"),
									"name",
									"Name",
									"text",
									"case_name",
								),
							],
						},
						caseSearchConfig: {
							formsReadSearch: true,
							...(workflow !== undefined && { workflow }),
						},
						caseListRegistrationForm: {
							formUuid: "summary-registration",
							label: "Register a new patient",
						},
						forms: [
							{
								name: "Visit",
								type: "followup",
								fields: [
									f({ id: "notes", kind: "text", label: proseText("Notes") }),
								],
							},
							{
								uuid: "summary-registration",
								name: "Register",
								type: "registration",
								fields: [
									f({
										id: "name",
										kind: "text",
										label: proseText("Name"),
										caseWrite: { caseType: "patient", property: "case_name" },
									}),
								],
							},
						],
					},
				],
			}),
		);
	}

	it("marks a menu that shows its case list as its own item", () => {
		const header = summarizeBlueprint(searchingDoc())
			.split("\n")
			.find((line) => line.includes('- Module "Patients"'));
		expect(header).toContain(" [case list in menu]");
	});

	it("names the menu's registration from the case list with its button text", () => {
		expect(summarizeBlueprint(searchingDoc()).split("\n")).toContain(
			'    case list registration: Register ("Register a new patient")',
		);
	});

	it("says what the menu opens on, then that its forms read the search", () => {
		const lines = (doc: BlueprintDoc) =>
			summarizeBlueprint(doc)
				.split("\n")
				.filter((line) => line.includes("case_search:"));
		expect(lines(searchingDoc())).toEqual([
			"    case_search: display={none} advanced={none} workflow=searchFirst, forms read it",
		]);
		expect(lines(searchingDoc("skipToResults"))).toEqual([
			"    case_search: display={none} advanced={none} workflow=skipToResults, forms read it",
		]);
	});
});

describe("summarizeBlueprint — after submit", () => {
	const CARE = testUuid("care");
	const START = testUuid("start");
	function linkedDoc(otherwise?: "built-in" | "link"): BlueprintDoc {
		const doc = buildDoc({
			appName: "Clinic",
			caseTypes: [{ name: "patient", properties: [] }],
			modules: [
				{
					uuid: "intake",
					name: "Intake",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: "start",
							name: "Start",
							type: "registration",
							formLinks: [
								{ condition: "1 = 2", target: { type: "this-form" } },
								{ target: { type: "module", moduleUuid: CARE } },
							],
							fields: [
								f({
									id: "case_name",
									kind: "text",
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
							],
						},
					],
				},
				{
					uuid: "care",
					name: "Care",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Note",
							type: "survey",
							fields: [f({ id: "note", kind: "text" })],
						},
					],
				},
			],
		});
		const note = doc.formOrder[CARE]?.[0];
		if (note === undefined) throw new Error("Missing the Care form");
		return expectAdmittedDoc({
			...doc,
			forms: {
				...doc.forms,
				[START]: {
					...doc.forms[START],
					...(otherwise === "built-in" && {
						otherwise: { kind: "destination", destination: "module" },
					}),
					...(otherwise === "link" && {
						otherwise: {
							kind: "link",
							uuid: testUuid("otherwise"),
							target: { type: "form", moduleUuid: CARE, formUuid: note },
						},
					}),
				},
			},
		});
	}

	it("lists the destinations in the order they run, then the otherwise", () => {
		const lines = (doc: BlueprintDoc) =>
			summarizeBlueprint(doc)
				.split("\n")
				.filter((line) => line.includes("destinations:"));
		expect(lines(linkedDoc())).toEqual([
			'    destinations: this form again, module "Care"',
		]);
		expect(lines(linkedDoc("built-in"))).toEqual([
			'    destinations: this form again, module "Care"; otherwise: module',
		]);
		expect(lines(linkedDoc("link"))).toEqual([
			'    destinations: this form again, module "Care"; otherwise: form "Note"',
		]);
	});
});
