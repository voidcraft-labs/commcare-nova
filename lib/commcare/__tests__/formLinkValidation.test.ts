/**
 * The after-submit link rules beyond target existence: reachability, the
 * explicit "otherwise", datum completeness, unused datums, the graph-backed
 * cycle rule, and the link identity that lets a surface point at the
 * affected route.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	type FormLinkDatumName,
	type PostSubmitDestination,
} from "@/lib/domain";
import {
	type Expression,
	eq,
	formField,
	literal,
	term,
} from "@/lib/domain/expression";
import { proseText } from "@/lib/domain/prose";

const INTAKE = testUuid("mod-intake");
const CARE = testUuid("mod-care");
const SOURCE = testUuid("frm-source");
const VISIT = testUuid("frm-visit");
const NOTE = testUuid("frm-note");

interface LinkSpec {
	uuid: string;
	condition?: string | Expression;
	target:
		| {
				type: "form";
				moduleUuid: typeof CARE;
				formUuid: typeof VISIT | typeof NOTE;
		  }
		| { type: "module"; moduleUuid: typeof CARE | typeof INTAKE };
	datums?: Array<{ name: FormLinkDatumName; xpath: string | Expression }>;
}

/**
 * Intake → [Source (survey, the links live here)]; Care (patient) →
 * [Visit (followup: needs a case), Note (survey: needs nothing)].
 */
function docWith(
	links: LinkSpec[],
	opts: {
		postSubmit?: PostSubmitDestination;
		sourceType?: "survey" | "registration";
	} = {},
): BlueprintDoc {
	const sourceType = opts.sourceType ?? "survey";
	return buildDoc({
		appName: "Links",
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "mood", label: proseText("Mood") }],
			},
		],
		modules: [
			{
				uuid: "mod-intake",
				name: "Intake",
				...(sourceType === "registration" && {
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
				}),
				forms: [
					{
						uuid: "frm-source",
						name: "Source",
						type: sourceType,
						...(opts.postSubmit !== undefined && {
							postSubmit: opts.postSubmit,
						}),
						formLinks: links,
						fields: [
							sourceType === "registration"
								? f({
										kind: "text",
										id: "case_name",
										label: proseText("Name"),
										caseWrite: { caseType: "patient", property: "case_name" },
									})
								: f({ kind: "text", id: "q", label: proseText("Q") }),
						],
					},
				],
			},
			{
				uuid: "mod-care",
				name: "Care",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "frm-visit",
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "mood",
								label: proseText("Mood"),
								caseWrite: { caseType: "patient", property: "mood" },
							}),
						],
					},
					{
						uuid: "frm-note",
						name: "Note",
						type: "survey",
						fields: [f({ kind: "text", id: "n", label: proseText("N") })],
					},
				],
			},
		],
	});
}

const linkFindings = (doc: BlueprintDoc) => {
	blueprintDocSchema.parse(toPersistableDoc(doc));
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
};

const toVisit = { type: "form", moduleUuid: CARE, formUuid: VISIT } as const;
const toNote = { type: "form", moduleUuid: CARE, formUuid: NOTE } as const;
const toCare = { type: "module", moduleUuid: CARE } as const;

describe("FORM_LINK_UNREACHABLE", () => {
	it("flags every link after an unconditional one, naming the winner and the loser", () => {
		const doc = docWith([
			{ uuid: "lnk-else", target: toCare },
			{ uuid: "lnk-late", condition: "1 = 1", target: toNote },
		]);
		const findings = linkFindings(doc);
		expect(findings.map((e) => e.code)).toEqual(["FORM_LINK_UNREACHABLE"]);
		const finding = findings[0];
		expect(finding.details?.linkUuid).toBe(testUuid("lnk-late"));
		expect(finding.details?.destination).toBe("Note");
		expect(finding.message).toContain('the link to "Note"');
		expect(finding.message).toContain('the link to the "Care" module');
		expect(userFacingError(finding)).toBe(
			'In "Source", the link to "Note" can never be used: an earlier link has no condition, so it always wins. Move this link above it, or give that link a condition.',
		);
	});
});

describe("FORM_LINK_NO_FALLBACK", () => {
	it("fires when the last link is conditional and no postSubmit is set", () => {
		const doc = docWith([{ uuid: "lnk", condition: "1 = 1", target: toNote }]);
		expect(linkFindings(doc).map((e) => e.code)).toEqual([
			"FORM_LINK_NO_FALLBACK",
		]);
	});

	it("is satisfied by a terminal unconditional link (the exhaustive else)", () => {
		const doc = docWith([
			{ uuid: "lnk-cond", condition: "1 = 1", target: toNote },
			{ uuid: "lnk-else", target: toCare },
		]);
		expect(linkFindings(doc)).toEqual([]);
	});

	it("is satisfied by an explicit postSubmit", () => {
		const doc = docWith([{ uuid: "lnk", condition: "1 = 1", target: toNote }], {
			postSubmit: "module",
		});
		expect(linkFindings(doc)).toEqual([]);
	});
});

describe("FORM_LINK_DATUMS_INCOMPLETE", () => {
	it("refuses an auto-matched link whose destination needs a case the source cannot supply", () => {
		// A survey opens no case; Visit needs one. Core cannot supply Visit
		// with a valid case and will not prompt to choose one.
		const doc = docWith([{ uuid: "lnk", target: toVisit }]);
		const findings = linkFindings(doc);
		expect(findings.map((e) => e.code)).toEqual([
			"FORM_LINK_DATUMS_INCOMPLETE",
		]);
		expect(findings[0].details).toMatchObject({
			linkUuid: testUuid("lnk"),
			destination: "Visit",
			destinationKind: "form",
			datumIds: "case_id",
		});
		expect(userFacingError(findings[0])).toContain('the link to "Visit"');
	});

	it("accepts the same link from a form that creates the case type", () => {
		const doc = docWith([{ uuid: "lnk", target: toVisit }], {
			sourceType: "registration",
			postSubmit: "app_home",
		});
		expect(linkFindings(doc)).toEqual([]);
	});

	it("accepts explicit datums that name every selection datum", () => {
		const doc = docWith([
			{
				uuid: "lnk",
				target: toVisit,
				datums: [
					{
						name: { kind: "selected-case", module: CARE },
						xpath: "'patient-7'",
					},
				],
			},
		]);
		expect(linkFindings(doc)).toEqual([]);
	});

	it("refuses explicit datums that leave a selection datum unnamed", () => {
		const household = testUuid("mod-household");
		const doc = buildDoc({
			caseTypes: [
				{ name: "household", properties: [] },
				{ name: "patient", parent_type: "household", properties: [] },
			],
			modules: [
				{
					uuid: INTAKE,
					name: "Intake",
					forms: [
						{
							uuid: SOURCE,
							name: "Source",
							type: "survey",
							fields: [f({ kind: "text", id: "q" })],
							formLinks: [
								{
									uuid: "lnk",
									target: toVisit,
									datums: [
										{
											name: { kind: "selected-case", module: CARE },
											xpath: "'patient-7'",
										},
									],
								},
							],
						},
					],
				},
				{
					uuid: household,
					name: "Households",
					caseType: "household",
					caseListOnly: true,
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
				},
				{
					uuid: CARE,
					name: "Care",
					caseType: "patient",
					parentCaseModuleUuid: household,
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: VISIT,
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "answer" })],
						},
					],
				},
			],
		});
		expect(
			linkFindings(doc)
				.map((e) => e.code)
				.sort(),
		).toEqual(["FORM_LINK_DATUMS_INCOMPLETE"]);
	});

	it("never fires for a module target — the person picks a case on arrival", () => {
		const doc = docWith([{ uuid: "lnk", target: toCare }]);
		expect(linkFindings(doc)).toEqual([]);
	});
});

describe("unrequested form-link selections", () => {
	it.each([
		{ target: toVisit, module: INTAKE },
		{ target: toNote, module: CARE },
	])(
		"refuses a selected record the destination never requests: $target.formUuid",
		({ target, module }) => {
			const doc = docWith([
				{
					uuid: "lnk",
					target,
					datums: [
						{
							name: { kind: "selected-case", module },
							xpath: term(literal("patient-7")),
						},
					],
				},
			]);
			const findings = linkFindings(doc);
			expect(findings.map((e) => e.code)).toEqual(["FORM_LINK_DATUM_UNUSED"]);
			expect(findings[0].details).toMatchObject({
				linkUuid: testUuid("lnk"),
				checkCode: "datum-not-supplied",
				slot: "form_link_datum_xpath",
				reason: "target-not-requested",
			});
			expect(userFacingError(findings[0])).toContain(
				"carries a case its destination no longer asks for",
			);
		},
	);
});

describe("targets, self references, and the cycle rule", () => {
	it("admits a module target and attributes self-reference plus cycle findings", () => {
		const doc = docWith([
			{ uuid: "lnk-ghost", target: { type: "module", moduleUuid: INTAKE } },
		]);
		const selfDoc = buildDoc({
			appName: "Self",
			modules: [
				{
					uuid: "mod-intake",
					name: "Intake",
					forms: [
						{
							uuid: "frm-source",
							name: "Source",
							type: "survey",
							formLinks: [
								{
									uuid: "lnk-self",
									target: {
										type: "form",
										moduleUuid: INTAKE,
										formUuid: SOURCE,
									},
								},
							],
							fields: [f({ kind: "text", id: "q", label: proseText("Q") })],
						},
					],
				},
			],
		});
		// Intake exists, so the module target is fine; the self doc refuses.
		expect(linkFindings(doc)).toEqual([]);
		const findings = linkFindings(selfDoc);
		expect(findings.map((e) => e.code).sort()).toEqual([
			"FORM_LINK_CIRCULAR",
			"FORM_LINK_SELF_REFERENCE",
		]);
		const self = findings.find((e) => e.code === "FORM_LINK_SELF_REFERENCE");
		expect(self?.details?.linkUuid).toBe(testUuid("lnk-self"));
		const cycle = findings.find((e) => e.code === "FORM_LINK_CIRCULAR");
		expect(cycle?.details?.formUuid).toBe(SOURCE);
		expect(cycle?.message).toContain("Source → Source");
	});

	it("reports a two-form cycle once per form that reaches itself", () => {
		const doc = buildDoc({
			appName: "Cycle",
			modules: [
				{
					uuid: "mod-intake",
					name: "Intake",
					forms: [
						{
							uuid: "frm-a",
							name: "A",
							type: "survey",
							formLinks: [
								{
									uuid: "lnk-a",
									target: {
										type: "form",
										moduleUuid: INTAKE,
										formUuid: testUuid("frm-b"),
									},
								},
							],
							fields: [f({ kind: "text", id: "q", label: proseText("Q") })],
						},
						{
							uuid: "frm-b",
							name: "B",
							type: "survey",
							formLinks: [
								{
									uuid: "lnk-b",
									target: {
										type: "form",
										moduleUuid: INTAKE,
										formUuid: testUuid("frm-a"),
									},
								},
							],
							fields: [f({ kind: "text", id: "q", label: proseText("Q") })],
						},
					],
				},
			],
		});
		const cycles = linkFindings(doc);
		expect(cycles.map((e) => e.code)).toEqual([
			"FORM_LINK_CIRCULAR",
			"FORM_LINK_CIRCULAR",
		]);
		expect(cycles.map((e) => e.details?.formUuid).sort()).toEqual(
			[testUuid("frm-a"), testUuid("frm-b")].sort(),
		);
	});
});

describe("expression findings on a link", () => {
	it("carry the link uuid and the exact condition slot", () => {
		const doc = docWith([{ uuid: "lnk", condition: "true()", target: toCare }]);
		const field = Object.values(doc.fields).find(
			(candidate) => candidate.id === "q",
		);
		const link = doc.forms[SOURCE]?.formLinks?.[0];
		if (field === undefined || link === undefined)
			throw new Error("Missing source field or link");
		link.condition = eq(formField(field.uuid), literal("yes"));
		const all = linkFindings(doc);
		expect(all.map((e) => e.code)).toEqual([
			"FORM_LINK_NO_FALLBACK",
			"INVALID_REF",
		]);
		const findings = all.filter((e) => e.code !== "FORM_LINK_NO_FALLBACK");
		expect(findings[0].message).toContain(
			"This runs after the form has closed, so it can't read the form's answers.",
		);
		expect(findings[0].details).toMatchObject({
			linkUuid: testUuid("lnk"),
		});
		expect(findings[0].location).toMatchObject({
			formUuid: SOURCE,
			field: "form_link_condition",
		});
	});
});
