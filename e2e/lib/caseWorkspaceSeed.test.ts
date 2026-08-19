import { describe, expect, it } from "vitest";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	blueprintDocSchema,
	isOwnerOnlyCaseSearchConfig,
	tileGroupHeaderRowChoices,
} from "@/lib/domain";
import { splitTileGridByGroupHeader } from "@/lib/preview/caseTileGrouping";
import { projectTileGrid } from "@/lib/preview/caseTileLayout";
import {
	buildCaseWorkspaceBlueprint,
	CASE_WORKSPACE_SEED,
	caseWorkspaceCaseRows,
	caseWorkspaceRoutes,
} from "./caseWorkspaceSeed";

const APP_ID = "493ac633-4fcd-4be0-8403-8fa08f6415af";
const CASE_ID = "019ba67f-13d7-7a20-9547-7f39012e8a4c";

describe("case workspace visual-QA seed", () => {
	it("is a valid, canonical, deterministic patient workspace", () => {
		const doc = buildCaseWorkspaceBlueprint(APP_ID);
		const persistable = toPersistableDoc(doc);
		expect(blueprintDocSchema.parse(persistable)).toEqual(persistable);
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);

		const module = doc.modules[CASE_WORKSPACE_SEED.moduleUuid];
		expect(module).toBeDefined();
		expect(module?.caseListOnly).toBe(true);
		const searchConfig = module?.caseSearchConfig;
		expect(
			searchConfig === undefined || isOwnerOnlyCaseSearchConfig(searchConfig)
				? undefined
				: searchConfig.searchScreenSubtitle,
		).toBeUndefined();

		const columns = module?.caseListConfig?.columns ?? [];
		expect(
			columns
				.filter((column) => column.visibleInList !== false)
				.map((column) => (column.kind === "calculated" ? null : column.field)),
		).toEqual([
			"case_name",
			"external_id",
			"village",
			"last_visit",
			"care_priority",
		]);
		expect(
			columns
				.filter((column) => column.visibleInList === false)
				.map((column) => (column.kind === "calculated" ? null : column.field)),
		).toEqual(["phone_number", "date_of_birth"]);

		const authoredProperties = [
			...columns.flatMap((column) =>
				column.kind === "calculated" ? [] : [column.field],
			),
			...(module?.caseListConfig?.searchInputs ?? []).flatMap((input) =>
				input.kind === "simple" ? [input.property] : [],
			),
		];
		expect(authoredProperties).toContain("case_name");
		expect(authoredProperties).toContain("external_id");
		expect(authoredProperties).not.toContain("name");
		expect(authoredProperties).not.toContain("external-id");

		const fixedIds = [
			CASE_WORKSPACE_SEED.moduleUuid,
			...Object.values(CASE_WORKSPACE_SEED.columns),
			...Object.values(CASE_WORKSPACE_SEED.searchInputs),
			CASE_WORKSPACE_SEED.tile.moduleUuid,
			CASE_WORKSPACE_SEED.tile.formUuid,
			...Object.values(CASE_WORKSPACE_SEED.tile.columns),
		];
		expect(new Set(fixedIds).size).toBe(fixedIds.length);
		for (const id of fixedIds) {
			expect(id).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			);
		}
	});

	it("provides eight realistic rows without shadow standard-property aliases", () => {
		const rows = caseWorkspaceCaseRows();
		expect(rows).toHaveLength(CASE_WORKSPACE_SEED.caseCount);
		expect(new Set(rows.map((row) => row.case_name)).size).toBe(rows.length);
		expect(new Set(rows.map((row) => row.external_id)).size).toBe(rows.length);
		for (const row of rows) {
			expect(row.case_type).toBe(CASE_WORKSPACE_SEED.caseType);
			expect(row.status).toBe("open");
			expect(row.properties).not.toHaveProperty("name");
			expect(row.properties).not.toHaveProperty("case_name");
			expect(row.properties).not.toHaveProperty("external_id");
			expect(row.properties).not.toHaveProperty("external-id");
			expect(row.properties).not.toHaveProperty("status");
		}
	});

	it("emits the canonical Search / Results / Details / condition / tile paths", () => {
		const tile = CASE_WORKSPACE_SEED.tile;
		expect(caseWorkspaceRoutes(APP_ID, CASE_ID)).toEqual({
			search: `/build/${APP_ID}/${CASE_WORKSPACE_SEED.moduleUuid}/search`,
			results: `/build/${APP_ID}/${CASE_WORKSPACE_SEED.moduleUuid}/results`,
			details: `/build/${APP_ID}/${CASE_WORKSPACE_SEED.moduleUuid}/details`,
			condition: `/build/${APP_ID}/${CASE_WORKSPACE_SEED.moduleUuid}/condition`,
			firstCase: `/build/${APP_ID}/${CASE_WORKSPACE_SEED.moduleUuid}/cases/${CASE_ID}`,
			tileResults: `/build/${APP_ID}/${tile.moduleUuid}/results`,
			groupedResults: `/build/${APP_ID}/${CASE_WORKSPACE_SEED.grouped.moduleUuid}/results`,
			tileForm: `/build/${APP_ID}/${tile.formUuid}`,
			projectData: `/build/${APP_ID}/project-data`,
			// A selected field serializes as its own uuid, so the smoke's deep
			// link into the options-source editor is one segment, not two.
			selectField: `/build/${APP_ID}/${tile.selectFieldUuid}`,
		});
	});

	it("groups the visit module on a heading depth that cuts its tile cleanly", () => {
		const doc = buildCaseWorkspaceBlueprint(APP_ID);
		const grouped = CASE_WORKSPACE_SEED.grouped;
		const config = doc.modules[grouped.moduleUuid]?.caseListConfig;
		expect(config?.tile?.grouping).toEqual({
			identifier: "parent",
			headerRows: grouped.headerRows,
		});

		// The offered depths and the seeded one have to agree, or the fixture
		// is a document the builder would never have produced.
		const cells = (config?.columns ?? []).flatMap((column) =>
			column.tile === undefined ? [] : [column.tile],
		);
		expect(tileGroupHeaderRowChoices(cells)).toContain(grouped.headerRows);

		// One heading cell drawn once per group, two body cells drawn per
		// visit — the shape every assertion in the smoke reads.
		const split = splitTileGridByGroupHeader(
			projectTileGrid(config?.columns ?? []),
			grouped.headerRows,
		);
		expect(split.header.cells).toHaveLength(1);
		expect(split.body.cells).toHaveLength(2);
	});

	it("lays the tile module out on a six-column grid whose only boxed cell is the one that asked", () => {
		const doc = buildCaseWorkspaceBlueprint(APP_ID);
		const module = doc.modules[CASE_WORKSPACE_SEED.tile.moduleUuid];
		const config = module?.caseListConfig;
		expect(config?.tile).toEqual({ persistOnForms: true });

		const columns = config?.columns ?? [];
		// Every column the tile shows has a square — the running renderer
		// derives its grid from exactly these.
		expect(columns.every((column) => column.tile !== undefined)).toBe(true);
		const projection = projectTileGrid(columns);
		expect(projection).toMatchObject({ columns: 6, rows: 3 });
		expect(projection.cells.map((cell) => cell.mode)).toEqual([
			"inset",
			"boxed",
			"inset",
			"inset",
			"inset",
		]);

		// Details is deliberately empty, so the running tile continues
		// straight into the follow-up form.
		expect(columns.every((column) => column.visibleInDetail === false)).toBe(
			true,
		);
		const formUuids = doc.formOrder[CASE_WORKSPACE_SEED.tile.moduleUuid] ?? [];
		expect(formUuids).toEqual([CASE_WORKSPACE_SEED.tile.formUuid]);
		expect(doc.forms[CASE_WORKSPACE_SEED.tile.formUuid]?.type).toBe("followup");
	});
});
