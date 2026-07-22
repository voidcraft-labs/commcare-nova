import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { describe, expect, it } from "vitest";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { blueprintDocSchema } from "@/lib/domain";
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
		expect(module?.caseSearchConfig?.searchScreenSubtitle).toBeUndefined();

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

	it("emits the canonical Search / Results / Details paths", () => {
		expect(caseWorkspaceRoutes(APP_ID, CASE_ID)).toEqual({
			search: `/build/${APP_ID}/${CASE_WORKSPACE_SEED.moduleUuid}/search`,
			results: `/build/${APP_ID}/${CASE_WORKSPACE_SEED.moduleUuid}/results`,
			details: `/build/${APP_ID}/${CASE_WORKSPACE_SEED.moduleUuid}/details`,
			firstCase: `/build/${APP_ID}/${CASE_WORKSPACE_SEED.moduleUuid}/cases/${CASE_ID}`,
		});
	});
});
