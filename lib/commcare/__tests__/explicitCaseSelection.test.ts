import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	mutationCommitVerdict,
	mutationCommitVerdictWithPrevalidation,
} from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { previewMenuCaseContext } from "@/lib/preview/menuProjection";
import { expandDoc } from "../expander";
import {
	entrySessionDatums,
	formLinkProjectionContext,
} from "../formLinkProjection";
import { runValidation } from "../validator/runner";

const FIRST = testUuid("first-parent"),
	SECOND = testUuid("second-parent"),
	CHILD = testUuid("child");
function fixture(registration = false) {
	return buildDoc({
		caseTypes: [
			{ name: "garden", properties: [] },
			{ name: "plot", parent_type: "garden", properties: [] },
		],
		modules: [
			...[FIRST, SECOND].map((uuid) => ({
				uuid,
				name: `Garden ${uuid}`,
				caseType: "garden",
				...(registration && uuid === FIRST
					? {
							forms: [
								{
									name: "Register garden",
									type: "registration" as const,
									fields: [
										f({
											kind: "text",
											id: "garden_name",
											caseWrite: { caseType: "garden", property: "case_name" },
										}),
									],
								},
							],
						}
					: { caseListOnly: true }),
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Garden" },
				]),
			})),
			{
				uuid: CHILD,
				name: "Plots",
				caseType: "plot",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Plot" },
				]),
				forms: [
					{
						name: "Inspect",
						type: "followup",
						fields: [f({ kind: "text", id: "note" })],
					},
				],
			},
		],
	});
}

describe("explicit parent record selection", () => {
	it("reports an invalid containing form without throwing during selection projection", () => {
		const doc = fixture(true);
		doc.moduleOrder = [FIRST, CHILD, SECOND];
		doc.modules[CHILD].parentModuleUuid = FIRST;
		doc.modules[CHILD].parentCaseModuleUuid = SECOND;
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const broken = structuredClone(doc);
		const name = Object.values(broken.fields).find(
			(field) => field.id === "garden_name",
		);
		if (name?.kind !== "text") throw new Error("Missing registration name");
		delete name.caseWrite;
		expect(
			runValidation(broken, LOOKUP_CONTEXT_UNAVAILABLE).map(
				(finding) => finding.code,
			),
		).toContain("CASE_CREATE_NAME_MISSING");
	});
	it("refuses to substitute a containing menu's selection for another chosen module", () => {
		const doc = buildDoc({
			caseTypes: [
				{ name: "garden", properties: [] },
				{ name: "plot", parent_type: "garden", properties: [] },
			],
			modules: [FIRST, CHILD, SECOND].map((uuid) => ({
				uuid,
				name: `Module ${uuid}`,
				caseType: uuid === CHILD ? "plot" : "garden",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note" })],
					},
				],
			})),
		});
		doc.modules[CHILD].parentModuleUuid = FIRST;
		doc.modules[CHILD].parentCaseModuleUuid = SECOND;
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map(
				(finding) => finding.code,
			),
		).toContain("CASE_PARENT_SELECTION_CONFLICT");
		const distinct = structuredClone(doc);
		const config = distinct.modules[FIRST].caseListConfig;
		if (!config) throw new Error("Missing Results");
		config.selection = { kind: "multiple", maximum: 5 };
		expect(runValidation(distinct, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const edit = [
			{ kind: "setCaseListMeta", uuid: FIRST, patch: { selection: null } },
		];
		const verdict = mutationCommitVerdictWithPrevalidation(
			distinct,
			edit,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok)
			expect(verdict.findings.map((finding) => finding.code)).toContain(
				"CASE_PARENT_SELECTION_CONFLICT",
			);
		const repaired = structuredClone(doc);
		repaired.modules[CHILD].parentCaseModuleUuid = FIRST;
		expect(runValidation(repaired, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	});
	it("keeps related records flat until an exact selector is chosen, across wire and Preview", () => {
		const doc = fixture();
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const form = doc.formOrder[CHILD][0];
		expect(
			entrySessionDatums(
				doc,
				formLinkProjectionContext(doc),
				CHILD,
				form,
			).filter((datum) => datum.nodeset !== undefined),
		).toHaveLength(1);
		expect(expandDoc(doc).modules[2].parent_select.active).toBe(false);
		expect(
			previewMenuCaseContext(
				{ ...doc, caseTypes: doc.caseTypes ?? [] },
				CHILD,
				{},
			).requiredParentCase,
		).toBeUndefined();
		const selected = mutationCommitVerdict(
			doc,
			[
				{
					kind: "updateModule",
					uuid: CHILD,
					patch: { parentCaseModuleUuid: SECOND },
				},
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(selected.ok).toBe(true);
		if (!selected.ok) return;
		const next = selected.nextDoc;
		const wire = expandDoc(next);
		expect(wire.modules[2].parent_select.module_id).toBe(
			wire.modules[1].unique_id,
		);
		expect(
			previewMenuCaseContext(
				{ ...next, caseTypes: next.caseTypes ?? [] },
				CHILD,
				{},
			).requiredParentCase,
		).toEqual({ caseType: "garden", moduleUuid: SECOND });
		expect(
			entrySessionDatums(
				next,
				formLinkProjectionContext(next),
				CHILD,
				form,
			).filter((datum) => datum.nodeset !== undefined),
		).toHaveLength(2);
		const flat = mutationCommitVerdict(
			next,
			[
				{
					kind: "updateModule",
					uuid: CHILD,
					patch: { parentCaseModuleUuid: null },
				},
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(flat.ok).toBe(true);
		if (flat.ok)
			expect(expandDoc(flat.nextDoc).modules[2].parent_select.active).toBe(
				false,
			);
	});

	it("refuses invalid selectors and changes that strand an existing route", () => {
		const doc = fixture();
		for (const parentCaseModuleUuid of [CHILD, testUuid("missing")])
			expect(
				mutationCommitVerdict(
					doc,
					[
						{
							kind: "updateModule",
							uuid: CHILD,
							patch: { parentCaseModuleUuid },
						},
					],
					LOOKUP_CONTEXT_UNAVAILABLE,
				).ok,
			).toBe(false);
		doc.modules[CHILD].parentCaseModuleUuid = SECOND;
		for (const mutations of [
			[{ kind: "removeModule", uuid: SECOND }],
			[{ kind: "setCaseTypeMeta", caseType: "plot", parent_type: null }],
			[
				{
					kind: "setCaseTypeMeta",
					caseType: "plot",
					relationship: "extension",
				},
			],
			[{ kind: "updateModule", uuid: SECOND, patch: { caseType: "plot" } }],
		])
			expect(
				mutationCommitVerdict(doc, mutations, LOOKUP_CONTEXT_UNAVAILABLE).ok,
			).toBe(false);
	});
});
