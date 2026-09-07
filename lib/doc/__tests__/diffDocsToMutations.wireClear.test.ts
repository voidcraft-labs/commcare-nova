/** JSON transport must preserve clears between admitted endpoints. This exercises
 * the parser, planner and commit gate, not the authenticated HTTP route. */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { mutationSchema } from "@/lib/doc/types";
import { type BlueprintDoc, plainColumn } from "@/lib/domain";
import { eq, literal, prop } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { assertAdmittedDoc } from "./admittedDoc";

function surveyDoc(): BlueprintDoc {
	return buildDoc({
		appName: "Organization",
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [{ kind: "text", id: "notes", label: proseText("Notes") }],
					},
				],
			},
		],
	});
}
function replayOverWire(prev: BlueprintDoc, next: BlueprintDoc): BlueprintDoc {
	assertAdmittedDoc(prev);
	assertAdmittedDoc(next);
	const onWire: unknown = JSON.parse(
		JSON.stringify(diffDocsToMutations(prev, next)),
	);
	if (!Array.isArray(onWire)) throw new Error("Expected mutation array");
	const parsed = onWire.map((mutation) => mutationSchema.parse(mutation));
	const verdict = mutationCommitVerdict(
		prev,
		parsed,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	return verdict.nextDoc;
}

describe("diffDocsToMutations — clearing an optional slot survives the wire", () => {
	it("clears a form's closeCondition (conditional close → always close)", () => {
		const prev = buildDoc({
			appName: "Clinic",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: "visit_status",
							label: proseText("Status"),
							data_type: "text",
						},
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: {
						columns: [
							plainColumn(testUuid("close-column"), "case_name", "Name"),
						],
						searchInputs: [],
					},
					forms: [
						{
							name: "Close visit",
							type: "close",
							closeCondition: { field: "done", answer: "yes" },
							fields: [{ kind: "text", id: "done", label: proseText("Done?") }],
						},
					],
				},
			],
		});
		const formUuid = Object.keys(prev.forms)[0];
		expect(prev.forms[formUuid].closeCondition).toBeDefined();

		// The CloseConditionSection dispatch: switch the conditional close back
		// to "always close" by blanking `closeCondition`.
		const next = produce(prev, (d) => {
			delete d.forms[formUuid].closeCondition;
		});

		const replayed = replayOverWire(prev, next);

		// GONE — not present, not `null`.
		expect("closeCondition" in replayed.forms[formUuid]).toBe(false);
		expect(toPersistableDoc(replayed)).toEqual(toPersistableDoc(next));
	});

	it("clears a module's caseListConfig.filter", () => {
		const prev = buildDoc({
			appName: "Clinic",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: "visit_status",
							label: proseText("Status"),
							data_type: "text",
						},
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListOnly: true,
					caseListConfig: {
						columns: [
							plainColumn(testUuid("filter-column"), "case_name", "Name"),
						],
						searchInputs: [],
						filter: eq(prop("patient", "visit_status"), literal("active")),
					},
				},
			],
		});
		const moduleUuid = Object.keys(prev.modules)[0];
		expect(prev.modules[moduleUuid].caseListConfig?.filter).toBeDefined();

		// Clear just the nested `filter` — the surrounding `caseListConfig`
		// survives. The granular metadata mutation carries an explicit `null`
		// for the filter so the clear survives JSON serialization.
		const next = produce(prev, (d) => {
			const config = d.modules[moduleUuid].caseListConfig;
			if (config) delete config.filter;
		});

		const replayed = replayOverWire(prev, next);

		const config = replayed.modules[moduleUuid].caseListConfig;
		expect(config).toBeDefined();
		expect(config && "filter" in config).toBe(false);
		expect(toPersistableDoc(replayed)).toEqual(toPersistableDoc(next));
	});

	it("clears a module's caseType (a top-level optional slot)", () => {
		const prev = buildDoc({
			appName: "Clinic",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: "visit_status",
							label: proseText("Status"),
							data_type: "text",
						},
					],
				},
			],
			modules: [
				{
					name: "Records",
					caseType: "patient",
					caseListConfig: {
						columns: [
							plainColumn(testUuid("clear-column"), "case_name", "Name"),
						],
						searchInputs: [],
					},
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								{ kind: "text", id: "notes", label: proseText("Notes") },
							],
						},
					],
				},
			],
		});
		const moduleUuid = Object.keys(prev.modules)[0];
		expect(prev.modules[moduleUuid].caseType).toBe("patient");

		const next = produce(prev, (d) => {
			delete d.modules[moduleUuid].caseType;
			delete d.modules[moduleUuid].caseListOnly;
			delete d.modules[moduleUuid].caseListConfig;
		});

		const replayed = replayOverWire(prev, next);

		expect("caseType" in replayed.modules[moduleUuid]).toBe(false);
		expect(toPersistableDoc(replayed)).toEqual(toPersistableDoc(next));
	});
});

describe("diffDocsToMutations — organization sequence admission", () => {
	it("refuses an existing-level reorder instead of silently emitting no diff", () => {
		const region = testUuid("11111111-1111-4111-8111-111111111111");
		const facility = testUuid("22222222-2222-4222-8222-222222222222");
		const prev = surveyDoc();
		prev.organizationLevels = {
			[region]: {
				uuid: region,
				code: "region",
				name: "Region",
				caseFlow: { workers: "none", ownsCases: false },
				addressBook: { reach: "own-branch" },
			},
			[facility]: {
				uuid: facility,
				code: "facility",
				name: "Facility",
				parentLevelUuid: region,
				caseFlow: { workers: "none", ownsCases: true },
				addressBook: { reach: "own-branch" },
			},
		};
		prev.organizationLevelOrder = [region, facility];
		const next = produce(prev, (draft) => {
			draft.organizationLevelOrder = [facility, region];
		});

		assertAdmittedDoc(prev);
		assertAdmittedDoc(next);
		expect(() => diffDocsToMutations(prev, next)).toThrow(
			/Reordering existing organization levels/,
		);
	});

	it("adds a new parent before reparenting an existing level to it", () => {
		const region = testUuid("11111111-1111-4111-8111-111111111111");
		const facility = testUuid("22222222-2222-4222-8222-222222222222");
		const district = testUuid("33333333-3333-4333-8333-333333333333");
		const prev = surveyDoc();
		prev.organizationLevels = {
			[region]: {
				uuid: region,
				code: "region",
				name: "Region",
				caseFlow: { workers: "none", ownsCases: false },
				addressBook: { reach: "own-branch" },
			},
			[facility]: {
				uuid: facility,
				code: "facility",
				name: "Facility",
				parentLevelUuid: region,
				caseFlow: { workers: "none", ownsCases: true },
				addressBook: { reach: "own-branch" },
			},
		};
		prev.organizationLevelOrder = [region, facility];
		const next = produce(prev, (draft) => {
			draft.organizationLevels ??= {};
			draft.organizationLevels[district] = {
				uuid: district,
				code: "district",
				name: "District",
				parentLevelUuid: region,
				caseFlow: { workers: "none", ownsCases: false },
				addressBook: { reach: "own-branch" },
			};
			draft.organizationLevels[facility].parentLevelUuid = district;
			draft.organizationLevelOrder = [region, facility, district];
		});

		const mutations = diffDocsToMutations(prev, next);
		expect(mutations.map((mutation) => mutation.kind)).toEqual([
			"addOrganizationLevel",
			"updateOrganizationLevel",
		]);
		expect(toPersistableDoc(replayOverWire(prev, next))).toEqual(
			toPersistableDoc(next),
		);
	});
});
