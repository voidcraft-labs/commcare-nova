/**
 * The row and mode verdicts of an export live in a module that reads
 * nothing, so acceptance of an app brought in from CommCare HQ, which the
 * proof lane bundles and runs with no database, reaches the same answers a
 * publish does. Two plausible failures: an import that reaches the
 * database (a helper borrowed from the export seam, or the lookup service),
 * after which the proof lane's bundle cannot load; and a verdict computed
 * too early, so an export of a document whose own verdict refuses it
 * throws instead of saying why.
 */
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	eq,
	matchAll,
	prop,
	tableLookup,
} from "@/lib/domain/expression/builders";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { proseText } from "@/lib/domain/prose";
import { parseLookupRevision } from "@/lib/lookup/schema";
import { prepareExportBoundaryWithReads } from "../boundaryValidation";

const ENTRY = "lib/export/boundaryFindings.ts";

describe("exportCarrierFindings", () => {
	it("reaches no database module, no lookup service and no server-only seam", async () => {
		const { metafile } = await build({
			entryPoints: [ENTRY],
			bundle: true,
			write: false,
			metafile: true,
			platform: "node",
			format: "esm",
			packages: "external",
			logLevel: "silent",
		});
		const inputs = Object.keys(metafile.inputs);
		// The graph is the verdicts' own: the entry and the carriers it builds.
		expect(inputs).toContain(ENTRY);
		expect(inputs).toContain("lib/commcare/hqNestedSelection.ts");
		expect(inputs).toContain("lib/commcare/lookup/workbook.ts");
		expect(inputs.filter((input) => input.startsWith("lib/db/"))).toEqual([]);
		expect(inputs).not.toContain("lib/lookup/service.ts");
		expect(inputs).not.toContain("lib/export/boundaryValidation.ts");
		const packages = new Set(
			Object.values(metafile.inputs).flatMap((input) =>
				input.imports
					.filter((imported) => imported.external === true)
					.map((imported) => imported.path),
			),
		);
		expect(
			["server-only", "pg", "kysely"].filter((name) => packages.has(name)),
		).toEqual([]);
	});

	it("answers a direct upload's missing table with that finding, before the nested selections are walked", async () => {
		const table = lookupTableIdSchema.parse(
			"018f3e8a-7b2c-7def-8abc-1234567890ab",
		);
		const column = lookupColumnIdSchema.parse(
			"018f3e8a-7b2c-7def-8abc-1234567890ad",
		);
		const doc = buildDoc({
			appName: "Visits",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "village", label: proseText("Village") },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: {
						...caseListConfig([{ field: "case_name", header: "Name" }]),
						// The entry's case list reads the table, so walking the
						// entry projection prints a read of it.
						filter: eq(
							prop("patient", "village"),
							tableLookup(table, column, matchAll()),
						),
					},
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [
								f({ kind: "text", id: "note", label: proseText("Note") }),
							],
						},
					],
				},
			],
		});
		// The table is gone from the Project: the snapshot holds none of it.
		const result = await prepareExportBoundaryWithReads(
			{
				mode: "hq-upload",
				access: { projectId: "project-1", role: "owner", actorUserId: "u" },
				doc,
				compiledAtSeq: 1,
				attachmentTarget: null,
			},
			{
				lookupFixtureData: async (scope) => ({
					projectId: scope.projectId,
					projectRevision: parseLookupRevision("3"),
					definitions: [],
					rowsByTable: new Map(),
				}),
				mediaRows: async () => [],
				mediaManifest: async () => {
					throw new Error("A refused export resolves no media bytes.");
				},
			},
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected the missing table's finding");
		expect(result.violations.map((finding) => finding.code)).toContain(
			"LOOKUP_TABLE_NOT_AVAILABLE",
		);
	});
});
