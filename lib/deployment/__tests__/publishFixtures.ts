/**
 * Apps Nova's publish tests send to CommCare HQ, shared so that the proof
 * harness's capture of a publish (`proof/corpus/publish.ts`) and the real
 * `publishAppToHq` are compared on the same app. Neither test file imports
 * the other; both build their documents here.
 */

import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, MediaAssetId } from "@/lib/domain";
import { proseText } from "@/lib/domain";
import type { LookupTableDefinition } from "@/lib/lookup/types";

/** One survey with one text question: the app every publish path sends first. */
export function clinicVisitsDocument(): BlueprintDoc {
	return buildDoc({
		appName: "Clinic visits",
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [{ id: "note", kind: "text" }],
					},
				],
			},
		],
	});
}

/**
 * A profile an HQ project space holds for the app, with settings HQ owns
 * beside Nova's derived Search key, so an update must keep the first and
 * may change only the second.
 */
export const TARGET_OWNED_PROFILE = {
	features: { custom: true },
	properties: { restore: "daily" },
	custom_properties: { unrelated: { keep: [1, "two"] } },
};

export const TARGET_PROFILE_WITH_DERIVED_KEY = {
	...TARGET_OWNED_PROFILE,
	custom_properties: {
		...TARGET_OWNED_PROFILE.custom_properties,
		"cc-index-case-search-results": "yes",
	},
};

/**
 * A case list with Search whose follow-up form uses every input the publish
 * assembly reads besides the document: an uploaded image on a question
 * (the media manifest), a select over a Project lookup table (the lookup
 * naming and workbook), and a scan saved to the case as a link (the
 * attachment target). `table` needs a `code` and a `name` column.
 */
export function searchLookupMediaDocument(
	table: Pick<LookupTableDefinition, "id" | "columns">,
	image: MediaAssetId,
): BlueprintDoc {
	const code = table.columns.find((column) => column.wireName === "code");
	const name = table.columns.find((column) => column.wireName === "name");
	if (code === undefined || name === undefined) {
		throw new Error("The lookup table needs a code and a name column.");
	}
	return buildDoc({
		appName: "Patient follow-up",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "scan_url", label: proseText("Scan") },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseSearchConfig: {},
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({ kind: "text", id: "note", label_media: { image } }),
							f({
								kind: "single_select",
								id: "facility",
								optionsSource: {
									kind: "lookup",
									tableId: table.id,
									valueColumnId: code.id,
									labelColumnId: name.id,
								},
							}),
							f({
								kind: "file",
								id: "scan",
								label: proseText("Scan"),
								caseWrite: {
									caseType: "patient",
									property: "scan_url",
									mode: "url",
								},
							}),
						],
					},
				],
			},
		],
	});
}
