/**
 * What each export mode carries of a lookup table CommCare HQ manages, and
 * what it says about one.
 *
 * A direct upload must never write a managed table in the project space that
 * manages it, so the workbook it pushes holds no sheet for it; a managed table
 * of another project space goes, and is made there from Nova's copy. The HQ
 * app file is made for no project space, so it puts the tables Nova manages
 * in one workbook and each project space's managed tables in one of their
 * own, and the `.ccz` embeds every one. A finding about a managed table
 * must not send a person to Project data, which refuses every edit to it.
 *
 * The lookup and media reads are the IO seam the boundary takes; the
 * validator, the carriers, the workbook bytes and the findings are real.
 */
import AdmZip from "adm-zip";
import { findAll } from "domutils";
import { parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { hqImportFileGuide } from "@/lib/commcare/multimedia/hqJsonExportArchive";
import type { ValidationError } from "@/lib/commcare/validator/errors";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import {
	lookupColumnIdSchema,
	lookupRowIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { proseText } from "@/lib/domain/prose";
import { parseLookupRevision } from "@/lib/lookup/schema";
import type {
	LookupFixtureDataSnapshot,
	LookupHqOrigin,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import type { ExportMode, LookupTarget } from "../boundaryFindings";
import {
	type PreparedExportBoundary,
	prepareExportBoundaryWithReads,
} from "../boundaryValidation";

const ACCESS = {
	projectId: "project-1",
	role: "owner",
	actorUserId: "user-1",
} as const;

const HERE = { server: "www", domain: "acme-health" } as const;
const ELSEWHERE = { server: "www", domain: "acme-north" } as const;

const ORIGIN: LookupHqOrigin = {
	...HERE,
	remoteId: "0a1b2c3d4e5f",
	managedBy: "commcare-hq",
	broughtInAt: "2026-11-01T09:00:00.000Z",
	refreshedAt: "2026-11-03T22:15:00.000Z",
	takenOverAt: null,
	takenOverBy: null,
	goneColumnIds: [],
};

function table(
	tag: string,
	n: number,
	hq?: LookupHqOrigin,
): LookupTableDefinition {
	return {
		id: lookupTableIdSchema.parse(`018f3e8a-7b2c-7def-8abc-0000000000${n}0`),
		name: tag[0].toUpperCase() + tag.slice(1),
		tag,
		definitionRevision: parseLookupRevision("1"),
		columns: [
			{
				id: lookupColumnIdSchema.parse(
					`018f3e8a-7b2c-7def-8abc-0000000000${n}1`,
				),
				wireName: "value",
				label: "Value",
				dataType: "text",
			},
			{
				id: lookupColumnIdSchema.parse(
					`018f3e8a-7b2c-7def-8abc-0000000000${n}2`,
				),
				wireName: "label",
				label: "Label",
				dataType: "text",
			},
		],
		...(hq !== undefined && { hq }),
	};
}

const VISITS = table("visits", 1);
const DISTRICTS = table("districts", 2, ORIGIN);
const CLINICS = table("clinics", 3, ORIGIN);
const WARDS = table("wards", 4, { ...ORIGIN, ...ELSEWHERE });

/** A survey whose form reads each table through a choice list. */
function docReading(tables: readonly LookupTableDefinition[]) {
	return buildDoc({
		appName: "Visits",
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: tables.map((definition) =>
							f({
								kind: "single_select",
								id: `${definition.tag}_choice`,
								label: proseText(definition.name),
								optionsSource: {
									kind: "lookup",
									tableId: definition.id,
									valueColumnId: definition.columns[0].id,
									labelColumnId: definition.columns[1].id,
								},
							}),
						),
					},
				],
			},
		],
	});
}

/** Two rows per table; `label` is the second row's label, as stored. */
function snapshot(
	tables: readonly LookupTableDefinition[],
	label = "South",
): LookupFixtureDataSnapshot {
	return {
		projectId: ACCESS.projectId,
		projectRevision: parseLookupRevision("9"),
		definitions: tables,
		rowsByTable: new Map(
			tables.map((definition, index) => [
				definition.id,
				[
					{
						id: lookupRowIdSchema.parse(
							`018f3e8a-7b2c-7def-8abc-00000000${index}a01`,
						),
						values: {
							[definition.columns[0].id]: "north",
							[definition.columns[1].id]: "North",
						},
					},
					{
						id: lookupRowIdSchema.parse(
							`018f3e8a-7b2c-7def-8abc-00000000${index}a02`,
						),
						values: {
							[definition.columns[0].id]: "south",
							[definition.columns[1].id]: label,
						},
					},
				],
			]),
		),
	};
}

function prepare(
	mode: ExportMode,
	tables: readonly LookupTableDefinition[],
	options: {
		readonly lookupTarget?: LookupTarget;
		readonly label?: string;
	} = {},
) {
	return prepareExportBoundaryWithReads(
		{
			mode,
			access: ACCESS,
			doc: docReading(tables),
			compiledAtSeq: 3,
			attachmentTarget: null,
			...(options.lookupTarget !== undefined && {
				lookupTarget: options.lookupTarget,
			}),
		},
		{
			lookupFixtureData: async () => snapshot(tables, options.label),
			mediaRows: async () => [],
			mediaManifest: async () => new Map(),
		},
	);
}

async function prepared(
	...args: Parameters<typeof prepare>
): Promise<PreparedExportBoundary> {
	const result = await prepare(...args);
	if (!result.ok)
		throw new Error(
			`Expected the export to pass, and it was refused: ${result.violations
				.map((finding) => finding.code)
				.join(", ")}`,
		);
	return result.prepared;
}

async function refused(
	...args: Parameters<typeof prepare>
): Promise<readonly ValidationError[]> {
	const result = await prepare(...args);
	if (result.ok) throw new Error("Expected the export to be refused");
	return result.violations;
}

/** The sheet names a workbook's bytes hold, read from its own XML. */
function sheetNames(bytes: Uint8Array | undefined): string[] {
	if (bytes === undefined) throw new Error("Expected a workbook");
	const xml = new AdmZip(Buffer.from(bytes)).readAsText("xl/workbook.xml");
	return findAll(
		(node) => node.name === "sheet",
		parseDocument(xml, { xmlMode: true }).children,
	).map((sheet) => sheet.attribs.name);
}

describe("a direct upload of a table CommCare HQ manages", () => {
	it("leaves a table managed in its own project space out of every sheet and lists it", async () => {
		const result = await prepared("hq-upload", [VISITS, DISTRICTS], {
			lookupTarget: HERE,
		});
		expect(sheetNames(result.lookupWorkbook?.bytes)).toEqual([
			"types",
			"visits",
		]);
		expect(result.lookupWorkbook?.tables.map((t) => t.tag)).toEqual(["visits"]);
		expect(result.managedLookupTables).toEqual([
			{
				tableId: DISTRICTS.id,
				tag: "districts",
				name: "Districts",
				server: "www",
				domain: "acme-health",
				refreshedAt: "2026-11-03T22:15:00.000Z",
			},
		]);
		expect(result.managedLookupWorkbooks).toEqual([]);
		/* The app is emitted under every table's name, whatever carries it. */
		expect(result.lookupNaming?.tables.map((t) => t.tag).sort()).toEqual([
			"districts",
			"visits",
		]);
	});

	it("sends the same table to another project space, and to a server of the same domain name", async () => {
		for (const lookupTarget of [
			ELSEWHERE,
			{ server: "india", domain: HERE.domain },
		]) {
			const result = await prepared("hq-upload", [VISITS, DISTRICTS], {
				lookupTarget,
			});
			expect(sheetNames(result.lookupWorkbook?.bytes)).toEqual([
				"types",
				"districts",
				"visits",
			]);
			expect(result.managedLookupTables).toEqual([]);
		}
	});

	it("builds no workbook where every table is managed in its own project space", async () => {
		const result = await prepared("hq-upload", [DISTRICTS, CLINICS], {
			lookupTarget: HERE,
		});
		expect(result.lookupWorkbook).toBeUndefined();
		expect(result.managedLookupTables.map((t) => t.tag)).toEqual([
			"districts",
			"clinics",
		]);
	});

	it("never judges a cell CommCare HQ would trim in a table it does not send", async () => {
		const result = await prepared("hq-upload", [DISTRICTS], {
			lookupTarget: HERE,
			label: "South ",
		});
		expect(result.managedLookupTables.map((t) => t.tag)).toEqual(["districts"]);
	});

	it("offers a separate table for a copy tagged types it sends to another project space, and never its tag's ways out", async () => {
		/* A reading brings in a project space's table tagged `types` as a copy
		 * CommCare HQ manages, whose indexes CommCare HQ never showed. No
		 * workbook carries the tag, and the JSON resources need the indexes.
		 * Nova refuses every edit of the copy, so a new export tag is no way
		 * out either: Create a separate table is, and it alone is named. */
		const base = table("types", 5);
		const types: LookupTableDefinition = {
			...base,
			columns: base.columns.map((column) => ({
				...column,
				index: "unobserved",
			})),
			hq: {
				...ORIGIN,
				source: {
					inventory: "complete",
					distribution: "global",
					indexEvidence: "unobserved",
				},
			},
		};
		const findings = await refused("hq-upload", [types], {
			lookupTarget: ELSEWHERE,
		});
		expect(findings.map((finding) => finding.code)).toEqual([
			"LOOKUP_WORKER_SOURCE_UNAVAILABLE",
		]);
		expect(findings[0].details).toMatchObject({
			tableId: types.id,
			separable: "yes",
		});
		const line = userFacingError(findings[0]);
		expect(line).toContain("create a separate table");
		expect(line).not.toContain("export tag");
		expect(line).not.toContain("direct publish");

		/* Where CommCare HQ manages it, a direct upload never writes it. */
		const here = await prepared("hq-upload", [types], { lookupTarget: HERE });
		expect(here.managedLookupTables.map((t) => t.tag)).toEqual(["types"]);
	});

	it("ends the trimmed-cell finding with the managed remedy where it sends a managed table, and with Project data for a plain one", async () => {
		const [managed] = await refused("hq-upload", [DISTRICTS], {
			lookupTarget: ELSEWHERE,
			label: "South ",
		});
		expect(managed.code).toBe("LOOKUP_CELL_TEXT_CHANGED_BY_HQ");
		expect(managed.message).toBe(
			`The "Label" column in "Districts" has leading or trailing whitespace in 1 row(s) that CommCare HQ would remove. CommCare HQ manages this table in acme-health. You can take that white space out there, then refresh Nova's copy on the table's page.`,
		);
		expect(managed.details?.managedInDomain).toBe("acme-health");
		expect(userFacingError(managed)).toBe(
			`The "Label" column in "Districts" has leading or trailing whitespace that CommCare HQ would remove. CommCare HQ manages this table in acme-health. You can take that white space out there, then refresh Nova's copy on the table's page.`,
		);
		for (const sentence of [managed.message, userFacingError(managed)])
			expect(sentence).not.toContain("Project data");

		/* A plain table goes through CommCare HQ's JSON resources on a direct
		 * upload, which keep the space; the HQ app file's workbook cannot. */
		const direct = await prepared("hq-upload", [VISITS], {
			lookupTarget: HERE,
			label: "South ",
		});
		expect(direct.jsonLookupTables?.map((t) => t.tag)).toEqual(["visits"]);
		const [plain] = await refused("hq-json", [VISITS], {
			label: "South ",
		});
		expect(plain.code).toBe("LOOKUP_CELL_TEXT_CHANGED_BY_HQ");
		expect(plain.message).toMatch(/ Remove that whitespace in Project data\.$/);
		expect(plain.details).not.toHaveProperty("managedInDomain");
		expect(userFacingError(plain)).toMatch(
			/ You can remove that whitespace in Project data\.$/,
		);
	});

	it("ends the unrepresentable-cell finding with the managed remedy in every mode", async () => {
		for (const mode of ["ccz", "hq-json", "hq-upload"] as const) {
			const findings = await refused(mode, [DISTRICTS], {
				lookupTarget: HERE,
				label: "South\u0001",
			});
			const finding = findings.find(
				(item) => item.code === "LOOKUP_CELL_TEXT_UNREPRESENTABLE",
			);
			expect(finding?.message).toMatch(
				/ CommCare HQ manages this table in acme-health\. You can take those characters out there, then refresh Nova's copy on the table's page\.$/,
			);
			if (finding === undefined) throw new Error("Expected the finding");
			expect(userFacingError(finding)).not.toContain("Project data");
		}
	});
});

describe("the HQ app file's workbooks", () => {
	it("keeps the prepared table in its source workbook and names each remaining source in the manual guide", async () => {
		const uncertain = {
			...DISTRICTS,
			columns: DISTRICTS.columns.map((col) => ({
				...col,
				index: "unobserved" as const,
			})),
		};
		const assigned = {
			...WARDS,
			hq: {
				...ORIGIN,
				...ELSEWHERE,
				source: {
					inventory: "complete" as const,
					distribution: "assigned" as const,
					indexEvidence: "workbook" as const,
				},
			},
		};
		const result = await prepared("hq-json", [uncertain, CLINICS, assigned]);
		expect(
			result.managedLookupWorkbooks.map((file) =>
				sheetNames(file.workbook.bytes),
			),
		).toEqual([["types", "clinics"]]);
		const steps = hqImportFileGuide({
			...result,
			appName: result.doc.appName,
			lookupWorkbook: result.lookupWorkbook,
			lookupNaming: result.lookupNaming,
		});
		const binding = steps.find((step) => step.kind === "bind-project-data");
		expect(binding?.lines.join(" ")).toContain(
			"“districts” uses the existing table in acme-health",
		);
		expect(binding?.lines.join(" ")).toContain(
			"“wards” uses the existing table in acme-north",
		);
		const workbook = steps.find(
			(step) => step.kind === "managed-lookup-tables",
		);
		expect(workbook?.lines.join(" ")).toContain("clinics");
		expect(workbook?.lines.join(" ")).not.toContain("districts");
		expect(
			(await refused("ccz", [assigned])).map((issue) => issue.code),
		).toContain("LOOKUP_WORKER_SOURCE_UNAVAILABLE");
	});
	it("puts each table in exactly one: the managed ones in a workbook of the project space that manages them", async () => {
		const result = await prepared("hq-json", [
			VISITS,
			DISTRICTS,
			WARDS,
			CLINICS,
		]);
		expect(sheetNames(result.lookupWorkbook?.bytes)).toEqual([
			"types",
			"visits",
		]);
		expect(
			result.managedLookupWorkbooks.map((managed) => [
				managed.server,
				managed.domain,
				sheetNames(managed.workbook.bytes),
			]),
		).toEqual([
			["www", "acme-health", ["types", "clinics", "districts"]],
			["www", "acme-north", ["types", "wards"]],
		]);
		expect(result.managedLookupTables.map((t) => [t.tag, t.domain])).toEqual([
			["districts", "acme-health"],
			["wards", "acme-north"],
			["clinics", "acme-health"],
		]);
	});

	it("judges a managed workbook's cells too, with the managed remedy", async () => {
		const findings = await refused("hq-json", [VISITS, DISTRICTS], {
			label: "South ",
		});
		expect(
			findings.map((item) => [
				item.code,
				item.details?.tableName,
				item.details?.managedInDomain,
			]),
		).toEqual([
			["LOOKUP_CELL_TEXT_CHANGED_BY_HQ", "Visits", undefined],
			["LOOKUP_CELL_TEXT_CHANGED_BY_HQ", "Districts", "acme-health"],
		]);
	});

	it("builds no managed workbook where no table is managed", async () => {
		const result = await prepared("hq-json", [VISITS]);
		expect(result.managedLookupWorkbooks).toEqual([]);
		expect(result.managedLookupTables).toEqual([]);
	});
});

describe("a downloadable app", () => {
	it("embeds every table's fixture, the managed ones included, and leaves none out", async () => {
		const result = await prepared("ccz", [VISITS, DISTRICTS]);
		expect(result.lookupWorkbook).toBeUndefined();
		expect(result.managedLookupWorkbooks).toEqual([]);
		expect(result.managedLookupTables).toEqual([]);
		expect(result.lookupWire?.naming.tables.map((t) => t.tag).sort()).toEqual([
			"districts",
			"visits",
		]);
		expect(result.lookupWire?.fixtures.totalRows).toBe(4);
	});
});
