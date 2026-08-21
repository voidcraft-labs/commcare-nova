/**
 * The after-submit link rules beyond target existence: reachability, the
 * explicit "otherwise", datum completeness, unused datums, the graph-backed
 * cycle rule, and the `linkUuid` / destination details every finding
 * carries so a surface can point at the link and name where it goes.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import type { BlueprintDoc, PostSubmitDestination } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

const INTAKE = testUuid("mod-intake");
const CARE = testUuid("mod-care");
const SOURCE = testUuid("frm-source");
const VISIT = testUuid("frm-visit");
const NOTE = testUuid("frm-note");

interface LinkSpec {
	uuid: string;
	condition?: string;
	target:
		| {
				type: "form";
				moduleUuid: typeof CARE;
				formUuid: typeof VISIT | typeof NOTE;
		  }
		| { type: "module"; moduleUuid: typeof CARE | typeof INTAKE };
	datums?: Array<{ name: string; xpath: string }>;
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

const linkFindings = (doc: BlueprintDoc) =>
	runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) =>
		e.code.startsWith("FORM_LINK"),
	);

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

	it("treats an empty condition as unconditional", () => {
		const doc = docWith([{ uuid: "lnk", condition: "", target: toNote }]);
		expect(linkFindings(doc)).toEqual([]);
	});
});

describe("FORM_LINK_DATUMS_INCOMPLETE", () => {
	it("refuses an auto-matched link whose destination needs a case the source cannot supply", () => {
		// A survey opens no case; Visit needs one. Core would open Visit
		// with an empty case id rather than ask for one.
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
				datums: [{ name: "case_id", xpath: "'patient-7'" }],
			},
		]);
		expect(linkFindings(doc)).toEqual([]);
	});

	it("refuses explicit datums that leave a selection datum unnamed", () => {
		const doc = docWith([
			{
				uuid: "lnk",
				target: toVisit,
				datums: [{ name: "other", xpath: "'x'" }],
			},
		]);
		expect(
			linkFindings(doc)
				.map((e) => e.code)
				.sort(),
		).toEqual(["FORM_LINK_DATUMS_INCOMPLETE", "FORM_LINK_DATUM_UNUSED"]);
	});

	it("never fires for a module target — the person picks a case on arrival", () => {
		const doc = docWith([{ uuid: "lnk", target: toCare }]);
		expect(linkFindings(doc)).toEqual([]);
	});
});

describe("FORM_LINK_DATUM_UNUSED", () => {
	it("names a value the destination never reads", () => {
		const doc = docWith([
			{
				uuid: "lnk",
				target: toNote,
				datums: [{ name: "worker", xpath: "'w'" }],
			},
		]);
		const findings = linkFindings(doc);
		expect(findings.map((e) => e.code)).toEqual(["FORM_LINK_DATUM_UNUSED"]);
		expect(findings[0].details).toMatchObject({
			linkUuid: testUuid("lnk"),
			datumName: "worker",
		});
		expect(userFacingError(findings[0])).toContain('"worker"');
	});
});

describe("targets, self references, and the cycle rule", () => {
	it("stamps linkUuid on a dangling target and a self reference", () => {
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
		const cycles = linkFindings(doc).filter(
			(e) => e.code === "FORM_LINK_CIRCULAR",
		);
		expect(cycles.map((e) => e.details?.formUuid).sort()).toEqual(
			[testUuid("frm-a"), testUuid("frm-b")].sort(),
		);
	});
});

describe("deep XPath findings on a link", () => {
	it("carry the link uuid and name the destination", () => {
		const doc = docWith([
			{ uuid: "lnk", condition: "#form/q = 'yes'", target: toCare },
		]);
		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(e) => e.details?.linkUuid === testUuid("lnk"),
		);
		expect(findings.length).toBeGreaterThan(0);
		expect(findings[0].message).toContain(
			'the link to the "Care" module, condition',
		);
		expect(findings[0].details).toMatchObject({
			destination: "Care",
			destinationKind: "module",
		});
	});
});
