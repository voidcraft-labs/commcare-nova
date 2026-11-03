/**
 * The after-submit link rules over every link of a form, its destinations
 * and its otherwise link alike: targets CommCare HQ offers, carried values,
 * the otherwise's own rules, and the link identity and role that let a
 * surface point at the affected route.
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	type DocSpec,
	f,
} from "@/lib/__tests__/docHelpers";
import type { ValidationErrorCode } from "@/lib/commcare/validator/errors";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import {
	type BlueprintDoc,
	blueprintDocSchema,
	type FormLinkDatumName,
	type FormOtherwise,
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
const SUB = testUuid("mod-sub");

interface LinkSpec {
	uuid: string;
	condition?: string | Expression;
	target:
		| {
				type: "form";
				moduleUuid: typeof CARE;
				formUuid: typeof VISIT | typeof NOTE;
		  }
		| { type: "module"; moduleUuid: typeof CARE | typeof INTAKE | typeof SUB }
		| { type: "this-form" };
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
		otherwise?: FormOtherwise;
		sourceType?: "survey" | "registration";
		/** Adds "Sub", a submenu of "Care" holding one survey. */
		withSubmenu?: boolean;
	} = {},
): BlueprintDoc {
	const sourceType = opts.sourceType ?? "survey";
	const spec: DocSpec = {
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
						...(links.length > 0 && { formLinks: links }),
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
			...(opts.withSubmenu === true
				? [
						{
							uuid: "mod-sub",
							name: "Sub",
							forms: [
								{
									uuid: "frm-sub",
									name: "Sub form",
									type: "survey" as const,
									fields: [f({ kind: "text", id: "s", label: proseText("S") })],
								},
							],
						},
					]
				: []),
		],
	};
	return buildDoc(spec, (doc) => {
		const sub = doc.modules[SUB];
		if (sub !== undefined) sub.parentModuleUuid = CARE;
		const source = doc.forms[SOURCE];
		if (source !== undefined && opts.otherwise !== undefined)
			source.otherwise = opts.otherwise;
	});
}

const linkFindings = (doc: BlueprintDoc) => {
	blueprintDocSchema.parse(toPersistableDoc(doc));
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
};

const toVisit = { type: "form", moduleUuid: CARE, formUuid: VISIT } as const;
const toNote = { type: "form", moduleUuid: CARE, formUuid: NOTE } as const;
const toCare = { type: "module", moduleUuid: CARE } as const;
const toSub = { type: "module", moduleUuid: SUB } as const;
const conditional = { uuid: "lnk-cond", condition: "1 = 1", target: toNote };
const codes = (doc: BlueprintDoc) =>
	linkFindings(doc)
		.map((e) => e.code)
		.sort();

describe("the retired codes", () => {
	it("are gone from ValidationErrorCode", () => {
		expectTypeOf<
			Extract<
				ValidationErrorCode,
				"FORM_LINK_UNREACHABLE" | "FORM_LINK_NO_FALLBACK" | "FORM_LINK_CIRCULAR"
			>
		>().toEqualTypeOf<never>();
	});

	it("admit an every-time destination before another, and a destination with nothing after it", () => {
		expect(
			codes(
				docWith([
					{ uuid: "lnk-a", target: toCare },
					{ uuid: "lnk-b", condition: "1 = 1", target: toNote },
				]),
			),
		).toEqual([]);
		expect(codes(docWith([conditional]))).toEqual([]);
	});

	it("admit a link cycle between two forms", () => {
		const doc = buildDoc({
			appName: "Cycle",
			modules: [
				{
					uuid: "mod-intake",
					name: "Intake",
					forms: ["a", "b"].map((name, index, all) => ({
						uuid: `frm-${name}`,
						name: name.toUpperCase(),
						type: "survey" as const,
						formLinks: [
							{
								uuid: `lnk-${name}`,
								target: {
									type: "form" as const,
									moduleUuid: INTAKE,
									formUuid: testUuid(`frm-${all[1 - index]}`),
								},
							},
						],
						fields: [f({ kind: "text", id: "q", label: proseText("Q") })],
					})),
				},
			],
		});
		expect(codes(doc)).toEqual([]);
	});
});

describe("FORM_LINK_SELF_REFERENCE", () => {
	it("refuses a form target naming the source form, and admits this-form", () => {
		const self = docWith([
			{
				uuid: "lnk-self",
				target: { type: "form", moduleUuid: INTAKE, formUuid: SOURCE },
			} as unknown as LinkSpec,
		]);
		const findings = linkFindings(self);
		expect(findings.map((e) => e.code)).toEqual(["FORM_LINK_SELF_REFERENCE"]);
		expect(findings[0].details).toMatchObject({
			linkUuid: testUuid("lnk-self"),
			role: "destination",
		});
		expect(findings[0].message).toBe(
			'"Source" the link to "Source" names "Source" itself as a form target. Use the target {"type":"this-form"}, which starts this form again and keeps meaning this form if it moves.',
		);
		expect(userFacingError(findings[0])).toBe(
			'In "Source", the link to "Source" points back at this form by name. You can choose Start this form again, which keeps working if the form moves.',
		);
		expect(
			codes(docWith([{ uuid: "lnk-this", target: { type: "this-form" } }])),
		).toEqual([]);
	});
});

describe("FORM_LINK_TARGET_NOT_OFFERED", () => {
	it("refuses a submenu from a root menu's form, on a destination", () => {
		const findings = linkFindings(
			docWith([{ uuid: "lnk", target: toSub }], { withSubmenu: true }),
		);
		expect(findings.map((e) => e.code)).toEqual([
			"FORM_LINK_TARGET_NOT_OFFERED",
		]);
		expect(findings[0].details).toMatchObject({
			linkUuid: testUuid("lnk"),
			role: "destination",
			menuName: "Sub",
			parentName: "Care",
			targetModuleUuid: SUB,
		});
		expect(findings[0].message).toBe(
			'"Source" the link to the "Sub" module opens "Sub", a submenu CommCare HQ doesn\'t offer as a link target from "Intake": a submenu is a target only from a submenu whose parent has the same case type as its own parent. Point the link at "Care", which holds it, or at a form inside "Sub".',
		);
		expect(userFacingError(findings[0])).toBe(
			'In "Source", the link to the "Sub" module opens "Sub", a submenu CommCare HQ can\'t link to from here. You can point it at "Care", which holds it, or at a form inside it.',
		);
	});

	it("refuses the same target on the otherwise link, naming it as the otherwise", () => {
		const findings = linkFindings(
			docWith([conditional], {
				withSubmenu: true,
				otherwise: { kind: "link", uuid: testUuid("lnk-else"), target: toSub },
			}),
		);
		expect(findings.map((e) => e.code)).toEqual([
			"FORM_LINK_TARGET_NOT_OFFERED",
		]);
		expect(findings[0].details).toMatchObject({
			linkUuid: testUuid("lnk-else"),
			role: "otherwise",
		});
		expect(findings[0].message).toContain(
			'"Source" the otherwise link to the "Sub" module opens "Sub"',
		);
		expect(userFacingError(findings[0])).toContain(
			'In "Source", its Otherwise opens "Sub"',
		);
	});

	it("stops firing once the link opens the parent menu", () => {
		expect(
			codes(docWith([{ uuid: "lnk", target: toCare }], { withSubmenu: true })),
		).toEqual([]);
		expect(
			codes(
				docWith([conditional], {
					withSubmenu: true,
					otherwise: {
						kind: "link",
						uuid: testUuid("lnk-else"),
						target: toCare,
					},
				}),
			),
		).toEqual([]);
	});
});

describe("FORM_LINK_MENU_DATUMS", () => {
	const carried = [
		{
			name: { kind: "selected-case" as const, module: CARE },
			xpath: term(literal("patient-7")),
		},
	];

	it("refuses carried values on a menu target, on a destination and on the otherwise link", () => {
		const destination = linkFindings(
			docWith([{ uuid: "lnk", target: toCare, datums: carried }]),
		).filter((e) => e.code === "FORM_LINK_MENU_DATUMS");
		expect(destination).toHaveLength(1);
		expect(destination[0].details).toMatchObject({
			linkUuid: testUuid("lnk"),
			role: "destination",
			menuName: "Care",
		});
		expect(destination[0].message).toBe(
			'"Source" the link to the "Care" module carries values to the module "Care", whose form list asks for none. Remove the link\'s datums, or point it at a form in "Care" that reads them.',
		);
		expect(userFacingError(destination[0])).toBe(
			'In "Source", the link to the "Care" module carries values to "Care", and a module\'s form list asks for none. You can remove the carried values, or send the link to a form inside it.',
		);

		const otherwise = linkFindings(
			docWith([conditional], {
				otherwise: {
					kind: "link",
					uuid: testUuid("lnk-else"),
					target: toCare,
					datums: carried,
				},
			}),
		).filter((e) => e.code === "FORM_LINK_MENU_DATUMS");
		expect(otherwise).toHaveLength(1);
		expect(otherwise[0].details).toMatchObject({
			linkUuid: testUuid("lnk-else"),
			role: "otherwise",
		});
	});

	it("stops firing without carried values", () => {
		expect(codes(docWith([{ uuid: "lnk", target: toCare }]))).toEqual([]);
	});
});

describe("FORM_OTHERWISE_UNREACHABLE", () => {
	it("refuses an otherwise beside destinations that each run every time", () => {
		const findings = linkFindings(
			docWith([{ uuid: "lnk", target: toCare }], {
				otherwise: { kind: "destination", destination: "module" },
			}),
		);
		expect(findings.map((e) => e.code)).toEqual(["FORM_OTHERWISE_UNREACHABLE"]);
		expect(findings[0].details).toMatchObject({
			role: "otherwise",
			arm: "every-destination-runs",
		});
		expect(findings[0].message).toBe(
			'"Source" sets an otherwise, but every destination runs each time, so the otherwise never runs. Give a destination a condition or a carried case, or remove the otherwise with set_form_otherwise null.',
		);
		expect(userFacingError(findings[0])).toBe(
			'"Source"\'s Otherwise can never run, because every destination runs each time. You can give a destination a condition, or remove the Otherwise.',
		);
	});

	it("names the otherwise link's uuid when the otherwise is a link", () => {
		const findings = linkFindings(
			docWith([{ uuid: "lnk", target: toNote }], {
				otherwise: { kind: "link", uuid: testUuid("lnk-else"), target: toCare },
			}),
		);
		expect(findings.map((e) => e.code)).toEqual(["FORM_OTHERWISE_UNREACHABLE"]);
		expect(findings[0].details).toMatchObject({
			linkUuid: testUuid("lnk-else"),
			role: "otherwise",
		});
	});

	it("refuses an otherwise on a form with no destinations", () => {
		const findings = linkFindings(
			docWith([], {
				otherwise: { kind: "destination", destination: "module" },
			}),
		);
		expect(findings.map((e) => e.code)).toEqual(["FORM_OTHERWISE_UNREACHABLE"]);
		expect(findings[0].details?.arm).toBe("no-destinations");
		expect(findings[0].message).toBe(
			'"Source" sets an otherwise but has no destinations. Add a destination, or remove the otherwise.',
		);
		expect(userFacingError(findings[0])).toBe(
			'"Source"\'s Otherwise can never run, because the form has no destinations. You can add a destination, or remove the Otherwise.',
		);
	});

	it("stops firing once a destination may not run", () => {
		expect(
			codes(
				docWith([{ uuid: "lnk", target: toCare }, conditional], {
					otherwise: { kind: "destination", destination: "module" },
				}),
			),
		).toEqual([]);
	});
});

describe("FORM_OTHERWISE_NOT_OFFERED", () => {
	it("refuses a built-in otherwise the form's menu does not offer", () => {
		const findings = linkFindings(
			docWith([conditional], {
				otherwise: { kind: "destination", destination: "parentMenu" },
			}),
		);
		expect(findings.map((e) => e.code)).toEqual(["FORM_OTHERWISE_NOT_OFFERED"]);
		const finding = findings[0];
		expect(finding.details).toMatchObject({
			role: "otherwise",
			slot: "otherwise",
			reason: "no-parent-menu",
			destination: "parentMenu",
		});
		expect(finding.details?.offered?.split(",")).not.toContain("app_home");
		expect(finding.message).toMatch(
			/^"Source" goes to the parent module when no destination runs, but "Intake" has no parent module\. Choose one of: .*, or remove the otherwise so the app home follows\.$/,
		);
		const sentence = userFacingError(finding);
		expect(sentence).toMatch(
			/^"Source" goes to the parent module when no destination runs, but "Intake" has no parent module\. Choose one of: .*\. You can also remove the Otherwise, and the app home follows\.$/,
		);
		expect(sentence).not.toContain("App home");
	});

	it("stops firing for an offered otherwise", () => {
		expect(
			codes(
				docWith([conditional], {
					otherwise: { kind: "destination", destination: "module" },
				}),
			),
		).toEqual([]);
	});
});

describe("POST_SUBMIT_BESIDE_FORM_LINKS", () => {
	it("refuses post_submit on a form with destinations, and not without them", () => {
		const findings = linkFindings(
			docWith([conditional], { postSubmit: "module" }),
		);
		expect(findings.map((e) => e.code)).toEqual([
			"POST_SUBMIT_BESIDE_FORM_LINKS",
		]);
		expect(findings[0].message).toBe(
			'"Source" has after-submit destinations and also sets post_submit, which only a form without destinations uses. Remove post_submit, and set where it goes when no destination runs with set_form_otherwise.',
		);
		expect(userFacingError(findings[0])).toBe(
			'"Source" has destinations and a separate After submit setting, which only a form without destinations uses. You can remove the setting and choose an Otherwise instead.',
		);
		expect(codes(docWith([], { postSubmit: "module" }))).toEqual([]);
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
			role: "destination",
			destination: "Visit",
			destinationKind: "form",
			datumIds: "case_id",
		});
		expect(userFacingError(findings[0])).toContain('the link to "Visit"');
	});

	it("refuses the same otherwise link, naming it as the otherwise", () => {
		const doc = docWith([conditional], {
			otherwise: { kind: "link", uuid: testUuid("lnk-else"), target: toVisit },
		});
		const findings = linkFindings(doc);
		expect(findings.map((e) => e.code)).toEqual([
			"FORM_LINK_DATUMS_INCOMPLETE",
		]);
		expect(findings[0].details).toMatchObject({
			linkUuid: testUuid("lnk-else"),
			role: "otherwise",
			datumIds: "case_id",
		});
		expect(findings[0].message).toContain('the otherwise link to "Visit"');
		expect(userFacingError(findings[0])).toContain(
			'In "Source", its Otherwise can\'t hand over the case',
		);
	});

	it("accepts the same link from a form that creates the case type", () => {
		const doc = docWith([{ uuid: "lnk", target: toVisit }], {
			sourceType: "registration",
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
					caseListMenuItem: {},
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
		const findings = linkFindings(doc);
		expect(findings.map((e) => e.code)).toEqual(["INVALID_REF"]);
		expect(findings[0].message).toContain(
			"This runs after the form has closed, so it can't read the form's answers.",
		);
		expect(findings[0].details).toMatchObject({
			linkUuid: testUuid("lnk"),
			role: "destination",
		});
		expect(findings[0].location).toMatchObject({
			formUuid: SOURCE,
			field: "form_link_condition",
		});
	});
});

describe("expression findings on the otherwise link", () => {
	it("carry the otherwise's uuid and role", () => {
		const doc = docWith([conditional], {
			otherwise: {
				kind: "link",
				uuid: testUuid("lnk-else"),
				target: toNote,
				datums: [
					{
						name: { kind: "selected-case", module: INTAKE },
						xpath: term(literal("patient-7")),
					},
				],
			},
		});
		const findings = linkFindings(doc);
		expect(findings.map((e) => e.code)).toEqual(["FORM_LINK_DATUM_UNUSED"]);
		expect(findings[0].details).toMatchObject({
			linkUuid: testUuid("lnk-else"),
			role: "otherwise",
			slot: "form_link_datum_xpath",
		});
		expect(userFacingError(findings[0])).toContain(
			'In "Source", its Otherwise carries a case',
		);
	});
});

describe("HIDDEN_MENU_NOT_A_DESTINATION on the otherwise link", () => {
	it("refuses an otherwise link to a menu off the menu, with its role", () => {
		const doc = docWith([conditional], {
			otherwise: { kind: "link", uuid: testUuid("lnk-else"), target: toCare },
		});
		const care = doc.modules[CARE];
		if (care === undefined) throw new Error("Missing Care");
		care.hiddenFromMenu = true;
		const hidden = linkFindings(doc).filter(
			(e) => e.code === "HIDDEN_MENU_NOT_A_DESTINATION",
		);
		expect(hidden).toHaveLength(1);
		expect(hidden[0].details).toMatchObject({
			arm: "link",
			linkUuid: testUuid("lnk-else"),
			role: "otherwise",
			targetModuleUuid: CARE,
		});
	});
});
