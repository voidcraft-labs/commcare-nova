/** Schema-admitted shared tool calls through the real workspace and reducer.
 * Controlled host receipts prove local state transitions, not SQL commits. */
import { describe, expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import { matchAll, today } from "@/lib/domain/predicate";
import { addCaseListColumnsTool } from "../addCaseListColumns";
import { MOD_A, makeCaseListDoc, makeCaseListFixture } from "./fixtures";

describe("addCaseListColumns", () => {
	it("appends a single column with a freshly minted uuid", async () => {
		const h = makeCaseListFixture();

		const result = await h.runTool(addCaseListColumnsTool, {
			moduleUuid: MOD_A,
			columns: [{ kind: "plain", field: "case_name", header: "Patient" }],
		});

		expect(result.kind).toBe("mutate");
		const final = h.currentDoc().modules[MOD_A]?.caseListConfig;
		expect(final?.columns).toHaveLength(2);
		const col = final?.columns.at(-1);
		expect(col?.kind).toBe("plain");
		expect(col?.uuid).toBeTruthy();
		if (col?.kind === "plain") {
			expect(col.field).toBe("case_name");
			expect(col.header).toBe("Patient");
		}
	});

	it("adds multiple columns in one call, in order, in one host batch", async () => {
		const h = makeCaseListFixture();
		const result = await h.runTool(addCaseListColumnsTool, {
			moduleUuid: MOD_A,
			columns: [
				{ kind: "plain", field: "case_name", header: "Name" },
				{ kind: "phone", field: "phone", header: "Phone" },
				{ kind: "date", field: "dob", header: "DOB", pattern: "%Y-%m-%d" },
			],
		});

		// One granular `addColumn` per column now (keyed by uuid + an append
		// `order`), not a single wholesale `updateModule{caseListConfig}`.
		expect(result.mutations).toHaveLength(3);
		expect(h.recordMutations).toHaveBeenCalledTimes(1);
		expect(result.mutations.every((m) => m.kind === "addColumn")).toBe(true);
		const final = h.currentDoc().modules[MOD_A]?.caseListConfig;
		expect(final?.columns.map((c) => c.kind)).toEqual([
			"plain",
			"plain",
			"phone",
			"date",
		]);
		if ("error" in result.result) throw new Error(result.result.error);
		// One uuid per column, aligned with input order + the stored columns.
		expect(result.result.uuids).toEqual(
			final?.columns.slice(-3).map((c) => c.uuid),
		);
	});

	it("surfaces each new uuid in the structured result", async () => {
		const h = makeCaseListFixture();
		const result = await h.runTool(addCaseListColumnsTool, {
			moduleUuid: MOD_A,
			columns: [{ kind: "plain", field: "case_name", header: "Patient" }],
		});
		if ("error" in result.result) {
			throw new Error(`unexpected error: ${result.result.error}`);
		}
		const newColumn = h
			.currentDoc()
			.modules[MOD_A]?.caseListConfig?.columns.at(-1);
		expect(result.result.uuids[0]).toBe(newColumn?.uuid);
		expect(result.result.message).toContain("Patient");
	});

	it("preserves filter and searchInputs when adding columns", async () => {
		const baseDoc = makeCaseListDoc();
		const seededInput = simpleSearchInputDef(
			testUuid("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
			"name_search",
			"Name",
			"text",
			"case_name",
		);
		const seededFilter = matchAll();
		const docWithConfig: BlueprintDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: {
					...baseDoc.modules[MOD_A],
					caseListConfig: resolveCaseListConfig({
						columns: baseDoc.modules[MOD_A].caseListConfig?.columns ?? [],
						searchInputs: [seededInput],
						filter: seededFilter,
					}),
				},
			},
		};

		const h = makeCaseListFixture(docWithConfig);
		await h.runTool(addCaseListColumnsTool, {
			moduleUuid: MOD_A,
			columns: [{ kind: "plain", field: "case_name", header: "Patient" }],
		});

		const final = h.currentDoc().modules[MOD_A]?.caseListConfig;
		expect(final?.searchInputs).toEqual([seededInput]);
		expect(final?.filter).toEqual(seededFilter);
	});

	it("appends to an existing columns array without disturbing prior entries", async () => {
		const baseDoc = makeCaseListDoc();
		const existing = plainColumn(
			testUuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
			"existing",
			"Existing",
		);
		const docWithConfig: BlueprintDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: {
					...baseDoc.modules[MOD_A],
					caseListConfig: resolveCaseListConfig({
						columns: [existing],
						searchInputs: [],
					}),
				},
			},
		};

		const h = makeCaseListFixture(docWithConfig);
		await h.runTool(addCaseListColumnsTool, {
			moduleUuid: MOD_A,
			columns: [{ kind: "phone", field: "phone", header: "Phone" }],
		});

		const final = h.currentDoc().modules[MOD_A]?.caseListConfig;
		expect(final?.columns).toHaveLength(2);
		expect(final?.columns[0]).toEqual(existing);
		expect(final?.columns[1]?.kind).toBe("phone");
	});

	it("appends after independently arranged Results and Details", async () => {
		const baseDoc = makeCaseListDoc();
		const first = {
			...plainColumn(
				testUuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
				"first",
				"First",
			),
		};
		const second = {
			...plainColumn(
				testUuid("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
				"second",
				"Second",
			),
		};
		const docWithConfig: BlueprintDoc = {
			...baseDoc,
			modules: {
				[MOD_A]: {
					...baseDoc.modules[MOD_A],
					caseListConfig: resolveCaseListConfig({
						columns: [first, second],
						// The two screens disagree; an append still lands at the end
						// of BOTH.
						listColumnOrder: [second.uuid, first.uuid],
						detailColumnOrder: [first.uuid, second.uuid],
						searchInputs: [],
					}),
				},
			},
		};

		const h = makeCaseListFixture(docWithConfig);
		await h.runTool(addCaseListColumnsTool, {
			moduleUuid: MOD_A,
			columns: [{ kind: "phone", field: "phone", header: "Phone" }],
		});
		const columns =
			h.currentDoc().modules[MOD_A]?.caseListConfig?.columns ?? [];
		const added = columns.find(
			(column) => column.uuid !== first.uuid && column.uuid !== second.uuid,
		);

		const config = h.currentDoc().modules[MOD_A]?.caseListConfig;
		expect(added).toBeDefined();
		expect(config?.listColumnOrder).toEqual([
			second.uuid,
			first.uuid,
			added?.uuid,
		]);
		expect(config?.detailColumnOrder).toEqual([
			first.uuid,
			second.uuid,
			added?.uuid,
		]);
	});

	it("preserves authored content for representative column kinds", async () => {
		const h = makeCaseListFixture();
		const columns = [
			{
				kind: "link" as const,
				field: "phone",
				header: "Link",
				linkText: "Open",
			},
			{ kind: "plain" as const, field: "case_name", header: "Patient" },
			{
				kind: "date" as const,
				field: "dob",
				header: "DOB",
				pattern: "%Y-%m-%d",
			},
			{ kind: "phone" as const, field: "phone", header: "Phone" },
			{
				kind: "id-mapping" as const,
				field: "region_code",
				header: "Region",
				mapping: [
					{ value: "N", label: "North" },
					{ value: "S", label: "South" },
				],
			},
			{
				kind: "interval" as const,
				field: "last_visit",
				header: "Days since visit",
				threshold: 7,
				unit: "days" as const,
				display: "always" as const,
				text: "This week",
			},
			{
				kind: "calculated" as const,
				header: "Today",
				expression: today(),
			},
			{
				kind: "image-map" as const,
				field: "status",
				header: "Status",
				mapping: [
					{
						value: "open",
						assetId: testMediaAssetId("asset-active"),
					},
					{
						value: "closed",
						assetId: testMediaAssetId("asset-closed"),
					},
				],
			},
		];

		await h.runTool(addCaseListColumnsTool, { moduleUuid: MOD_A, columns });

		const finalCols =
			h.currentDoc().modules[MOD_A]?.caseListConfig?.columns ?? [];
		expect(finalCols).toHaveLength(columns.length + 1);
		expect(
			finalCols.slice(-columns.length).map(({ uuid: _uuid, ...body }) => body),
		).toEqual(columns);
	});

	it("returns the canonical UUID-address error for an unknown module", async () => {
		const h = makeCaseListFixture();
		const result = await h.runTool(addCaseListColumnsTool, {
			moduleUuid: testUuid("unknown-module"),
			columns: [{ kind: "plain", field: "case_name", header: "Patient" }],
		});

		expect(result.mutations).toEqual([]);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("No module with UUID");
	});

	it("adds a dormant column that is hidden on both screens", async () => {
		const h = makeCaseListFixture();
		const result = await h.runTool(addCaseListColumnsTool, {
			moduleUuid: MOD_A,
			columns: [
				{
					kind: "plain",
					field: "case_name",
					header: "Patient",
					visibleInList: false,
					visibleInDetail: false,
				},
			],
		});
		expect(result.result).not.toHaveProperty("error");
		expect(
			h.currentDoc().modules[MOD_A]?.caseListConfig?.columns.at(-1),
		).toMatchObject({ visibleInList: false, visibleInDetail: false });
	});
});
