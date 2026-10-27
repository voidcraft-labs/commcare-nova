/**
 * A data table read in a question's logic, a Connect block or an
 * after-submit link joins the same reference registry as every other lookup
 * carrier, so the table is kept, pushed and embedded exactly as for a lookup
 * select.
 *
 * The registry makes one extractor per expression slot of the field, form
 * and module registries (`PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS`), so these
 * reads need no extractor of their own. What follows each occurrence is
 * observed through its production consumer: the reference set the edge
 * tables store (`lookupReferenceEdges.ts`, which governance reads before a
 * table or column is removed), the validator's finding for a table that is
 * gone, and the export boundary's embedded fixture and HQ workbook.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import {
	INSTANCE_READS,
	instanceReadFixture,
} from "@/lib/commcare/__tests__/instanceReadFixture";
import { runValidation } from "@/lib/commcare/validator/runner";
import {
	extractLookupReferenceOccurrences,
	extractLookupReferenceTargets,
	PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
} from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import type { Uuid } from "@/lib/domain";
import { prepareExportBoundaryWithReads } from "@/lib/export/boundaryValidation";
import { parseLookupRevision } from "@/lib/lookup/schema";
import type { LookupFixtureDataSnapshot } from "@/lib/lookup/types";

const PROJECT = "project-form-logic-lookups";

function fieldUuid(
	doc: ReturnType<typeof instanceReadFixture>["doc"],
	id: string,
): Uuid {
	const field = Object.values(doc.fields).find((field) => field.id === id);
	if (field === undefined) throw new Error(`No field ${id}`);
	return field.uuid;
}

describe("a data table read in form logic, Connect or a link", () => {
	it("is one occurrence per read, owned by its own carrier and slot", () => {
		const { doc, table } = instanceReadFixture();
		const [value, label] = table.columns;
		const occurrences = extractLookupReferenceOccurrences(
			doc,
			PRODUCTION_LOOKUP_REFERENCE_EXTRACTORS,
		).map((occurrence) => [
			occurrence.registrySlot,
			occurrence.carrierUuid,
			occurrence.subpath,
			occurrence.columnId ?? null,
		]);
		expect(occurrences).toEqual([
			[
				"calculate",
				fieldUuid(doc, "region_label"),
				"/k:resultColumnId",
				label.id,
			],
			[
				"calculate",
				fieldUuid(doc, "region_label"),
				"/k:table-lookup/k:where/k:left/k:columnId",
				value.id,
			],
			[
				"calculate",
				fieldUuid(doc, "region_count"),
				"/k:count/k:via/k:tableId",
				null,
			],
			[
				"calculate",
				fieldUuid(doc, "region_labels"),
				"/k:call/k:args/i:1/k:project/k:of/k:tableId",
				null,
			],
			[
				"calculate",
				fieldUuid(doc, "region_labels"),
				"/k:call/k:args/i:1/k:project/k:value/k:columnId",
				label.id,
			],
			[
				"deliver_entity_name",
				INSTANCE_READS.visitForm,
				"/k:resultColumnId",
				label.id,
			],
			[
				"deliver_entity_name",
				INSTANCE_READS.visitForm,
				"/k:table-lookup/k:where/k:left/k:columnId",
				value.id,
			],
			[
				"form_link_condition",
				INSTANCE_READS.tableLink,
				"/k:left/k:count/k:via/k:tableId",
				null,
			],
		]);
		expect(extractLookupReferenceTargets(doc)).toEqual({
			tableIds: [table.id],
			columnTargets: [value.id, label.id]
				.sort()
				.map((columnId) => ({ tableId: table.id, columnId })),
		});
	});

	it("names each read when the table is gone from the Project", () => {
		const { doc } = instanceReadFixture();
		const gone = runValidation(doc, {
			kind: "available",
			projectId: PROJECT,
			projectRevision: parseLookupRevision("2"),
			definitions: [],
		}).filter((finding) => finding.code === "LOOKUP_TABLE_NOT_AVAILABLE");
		expect(
			gone.map((finding) => [
				finding.location.fieldId ?? finding.scope,
				finding.location.formUuid,
			]),
		).toEqual([
			["region_label", INSTANCE_READS.visitForm],
			["region_count", INSTANCE_READS.visitForm],
			["region_labels", INSTANCE_READS.visitForm],
			["form", INSTANCE_READS.visitForm],
			["form", INSTANCE_READS.visitForm],
		]);
	});

	it.each(["ccz", "hq-json", "hq-upload"] as const)(
		"carries the table's rows with a %s export",
		async (mode) => {
			const fixture = instanceReadFixture();
			const { table, rows } = fixture;
			// The fixture's several-case and search-first menus run in Web Apps
			// alone and its Connect app on Android alone, so no export holds all
			// three; the export of its Connect app keeps the menu that reads the
			// table and runs on Android.
			const doc = produce(fixture.doc, (draft) => {
				applyMutations(draft, [
					{ kind: "removeModule", uuid: INSTANCE_READS.batchModule },
					{ kind: "removeModule", uuid: INSTANCE_READS.searchModule },
					{ kind: "setAppSettings", settings: { runsOnlyOn: "android" } },
				]);
			});
			const snapshot: LookupFixtureDataSnapshot = {
				projectId: PROJECT,
				projectRevision: parseLookupRevision("1"),
				definitions: [table],
				rowsByTable: new Map([[table.id, rows]]),
			};
			const result = await prepareExportBoundaryWithReads(
				{
					mode,
					access: { projectId: PROJECT, role: "owner", actorUserId: "owner" },
					doc,
					compiledAtSeq: 1,
					attachmentTarget: null,
				},
				{
					lookupFixtureData: async (_scope, tableIds) => {
						expect(tableIds).toEqual([table.id]);
						return snapshot;
					},
					mediaRows: async () => [],
					mediaManifest: async () => new Map(),
				},
			);
			if (!result.ok) throw new Error(JSON.stringify(result.violations));
			const { prepared } = result;
			if (mode === "ccz")
				expect(
					prepared.lookupWire?.fixtures.fixtures.map((fixture) => fixture.xml),
				).toEqual([
					'<fixture id="item-list:regions"><regions_list><regions><value>north</value><label>Northland</label></regions><regions><value>south</value><label>Southland</label></regions></regions_list></fixture>',
				]);
			else
				expect(prepared.lookupWorkbook?.tables).toEqual([
					{ tableId: table.id, tag: "regions", columnCount: 2, rowCount: 2 },
				]);
		},
	);
});
