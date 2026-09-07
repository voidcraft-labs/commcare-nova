import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import {
	advancedSearchInputDef,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import { matchAll } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { assertAdmittedDoc } from "./admittedDoc";

describe("Search-input final mutation shape", () => {
	it("diffs and replays add, update, remove, and reorder across both exact arms", () => {
		const moduleUuid = testUuid("search-input-final-shape-module");
		const columnUuid = testUuid("search-input-final-shape-column");
		const firstUuid = testUuid("search-input-final-shape-first");
		const updatedUuid = testUuid("search-input-final-shape-updated");
		const addedUuid = testUuid("search-input-final-shape-added");
		const retainedUuid = testUuid("search-input-final-shape-retained");
		const previous = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: "case_name",
							label: proseText("Name"),
							data_type: "text",
						},
						{
							name: "phone",
							label: proseText("Phone"),
							data_type: "text",
						},
						{
							name: "date_opened",
							label: proseText("Opened"),
							data_type: "date",
						},
						{
							name: "region",
							label: proseText("Region"),
							data_type: "text",
						},
					],
				},
			],
			modules: [
				{
					uuid: moduleUuid,
					name: "Patients",
					caseType: "patient",
					caseListOnly: true,
					caseListConfig: resolveCaseListConfig({
						columns: [plainColumn(columnUuid, "case_name", "Patient name")],
						searchInputs: [
							simpleSearchInputDef(
								firstUuid,
								"name",
								"Name",
								"text",
								"case_name",
							),
							simpleSearchInputDef(
								updatedUuid,
								"phone",
								"Phone",
								"text",
								"phone",
							),
							simpleSearchInputDef(
								retainedUuid,
								"region",
								"Region",
								"text",
								"region",
							),
						],
					}),
				},
			],
		});
		const next = produce(previous, (draft) => {
			const config = draft.modules[moduleUuid].caseListConfig;
			if (config === undefined) throw new Error("fixture has no case list");
			config.searchInputs = [
				simpleSearchInputDef(
					retainedUuid,
					"region",
					"Region",
					"text",
					"region",
				),
				simpleSearchInputDef(
					addedUuid,
					"date_opened",
					"Opened",
					"date-range",
					"date_opened",
				),
				advancedSearchInputDef(
					updatedUuid,
					"phone",
					"Phone",
					"text",
					matchAll(),
				),
			];
		});

		assertAdmittedDoc(previous);
		assertAdmittedDoc(next);
		const forward = admitMutationBatch(
			JSON.parse(JSON.stringify(diffDocsToMutations(previous, next))),
		);
		expect(forward.map((mutation) => mutation.kind)).toEqual(
			expect.arrayContaining([
				"addSearchInput",
				"updateSearchInput",
				"removeSearchInput",
				"moveSearchInput",
			]),
		);
		const forwardVerdict = mutationCommitVerdict(
			previous,
			forward,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(forwardVerdict.ok ? [] : forwardVerdict.findings).toEqual([]);
		const replayed = forwardVerdict.nextDoc;
		expect(toPersistableDoc(replayed)).toEqual(toPersistableDoc(next));

		const reverse = admitMutationBatch(
			JSON.parse(JSON.stringify(diffDocsToMutations(next, previous))),
		);
		const reverseVerdict = mutationCommitVerdict(
			next,
			reverse,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(reverseVerdict.ok ? [] : reverseVerdict.findings).toEqual([]);
		const restored = reverseVerdict.nextDoc;
		expect(toPersistableDoc(restored)).toEqual(toPersistableDoc(previous));
	});
});
