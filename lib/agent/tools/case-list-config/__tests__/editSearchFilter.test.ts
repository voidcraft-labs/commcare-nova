/** Real shared search-filter tool, workspace gate and reducer over admitted
 * fixtures with a controlled host. This proves document transitions: the
 * filter rows a menu holds, in order, and the edits the gate refuses. */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	plainColumn,
	simpleSearchInputDef,
	type Uuid,
} from "@/lib/domain";
import { literal, term } from "@/lib/domain/expression";
import { editSearchFilterTool } from "../editSearchFilter";
import { MOD_A, makeCaseListDoc, makeCaseListFixture } from "./fixtures";

const FIRST = testUuid("edit-search-filter-first");
const SECOND = testUuid("edit-search-filter-second");
const THIRD = testUuid("edit-search-filter-third");
const MOD_B = testUuid("edit-search-filter-other-menu");
const FOREIGN = testUuid("edit-search-filter-foreign");

const onProperty = (property: string) =>
	({ kind: "property", property }) as const;

/** The fixture with a second menu holding one filter of its own. */
function withOtherMenu(): BlueprintDoc {
	const doc = makeCaseListDoc();
	const mod = doc.modules[MOD_A];
	return {
		...doc,
		modules: {
			...doc.modules,
			[MOD_B]: {
				...mod,
				uuid: MOD_B,
				id: "patient_search",
				name: "Patient search",
				caseListMenuItem: {},
				caseSearchConfig: {},
				caseListConfig: {
					...resolveCaseListConfig({
						columns: [
							plainColumn(
								testUuid("edit-search-filter-other-column"),
								"case_name",
								"Patient",
							),
						],
						searchInputs: [],
					}),
					searchFilters: [
						{
							uuid: FOREIGN,
							target: onProperty("region"),
							value: term(literal("north")),
						},
					],
				},
			},
		},
		moduleOrder: [...doc.moduleOrder, MOD_B],
		formOrder: { ...doc.formOrder, [MOD_B]: [] },
	};
}

describe("editSearchFilter", () => {
	const run = async (
		h: ReturnType<typeof makeCaseListFixture>,
		change: Record<string, unknown>,
	) => h.runTool(editSearchFilterTool, { moduleUuid: MOD_A, change });
	const rows = (h: ReturnType<typeof makeCaseListFixture>) =>
		h
			.currentDoc()
			.modules[MOD_A].caseListConfig?.searchFilters?.map((row) => row.uuid);

	it("adds a first filter to a menu with no search and turns its search on", async () => {
		const h = makeCaseListFixture();
		expect(h.currentDoc().modules[MOD_A].caseSearchConfig).toBeUndefined();
		const result = await run(h, {
			operation: "add",
			uuid: FIRST,
			target: onProperty("region"),
			value: term(literal("north")),
		});
		if ("error" in result.result) throw new Error(result.result.error);
		expect(result.result.uuid).toBe(FIRST);
		const mod = h.currentDoc().modules[MOD_A];
		expect(mod.caseSearchConfig).toEqual({});
		expect(mod.caseListConfig?.searchFilters).toEqual([
			{
				uuid: FIRST,
				target: onProperty("region"),
				value: term(literal("north")),
			},
		]);
	});

	it("places, edits, moves and removes rows, dropping the list with its last row", async () => {
		const h = makeCaseListFixture();
		const add = async (uuid: Uuid, property: string, after?: Uuid | null) => {
			const result = await run(h, {
				operation: "add",
				uuid,
				target: onProperty(property),
				value: term(literal("x")),
				...(after !== undefined && { after }),
			});
			if ("error" in result.result) throw new Error(result.result.error);
		};
		await add(FIRST, "region");
		// `null` puts a row first; a row's uuid puts it right after that row.
		await add(SECOND, "status", null);
		await add(THIRD, "phone", SECOND);
		expect(rows(h)).toEqual([SECOND, THIRD, FIRST]);

		const edited = await run(h, {
			operation: "edit",
			uuid: THIRD,
			value: term(literal("555")),
		});
		if ("error" in edited.result) throw new Error(edited.result.error);
		expect(
			h
				.currentDoc()
				.modules[MOD_A].caseListConfig?.searchFilters?.find(
					(row) => row.uuid === THIRD,
				),
		).toEqual({
			uuid: THIRD,
			target: onProperty("phone"),
			value: term(literal("555")),
		});

		const moved = await run(h, {
			operation: "move",
			uuid: SECOND,
			after: FIRST,
		});
		if ("error" in moved.result) throw new Error(moved.result.error);
		expect(rows(h)).toEqual([THIRD, FIRST, SECOND]);

		for (const uuid of [THIRD, FIRST, SECOND]) {
			const removed = await run(h, { operation: "remove", uuid });
			if ("error" in removed.result) throw new Error(removed.result.error);
		}
		expect(h.currentDoc().modules[MOD_A].caseListConfig).not.toHaveProperty(
			"searchFilters",
		);
	});

	it("refuses rows another menu owns, and an unknown row to follow", async () => {
		const h = makeCaseListFixture(withOtherMenu());
		await run(h, {
			operation: "add",
			uuid: FIRST,
			target: onProperty("region"),
			value: term(literal("north")),
		});
		const before = structuredClone(h.currentDoc());
		for (const change of [
			{ operation: "edit", uuid: FOREIGN, value: term(literal("south")) },
			{ operation: "remove", uuid: FOREIGN },
			{ operation: "move", uuid: FIRST, after: FOREIGN },
			{
				operation: "add",
				uuid: SECOND,
				target: onProperty("status"),
				value: term(literal("open")),
				after: testUuid("edit-search-filter-nowhere"),
			},
		]) {
			const result = await run(h, change);
			expect(result.result).toHaveProperty("error");
			expect(result.mutations).toEqual([]);
		}
		expect(h.currentDoc()).toEqual(before);
	});

	it("refuses a filter that sends what a search field already sends", async () => {
		const doc = makeCaseListDoc();
		const config = doc.modules[MOD_A].caseListConfig;
		if (config === undefined) throw new Error("fixture config missing");
		const h = makeCaseListFixture({
			...doc,
			modules: {
				[MOD_A]: {
					...doc.modules[MOD_A],
					caseListConfig: {
						...config,
						searchInputs: [
							simpleSearchInputDef(
								testUuid("edit-search-filter-phone-field"),
								"phone",
								"Phone",
								"text",
								"phone",
							),
						],
					},
				},
			},
		});
		const before = structuredClone(h.currentDoc());
		const result = await run(h, {
			operation: "add",
			uuid: FIRST,
			target: onProperty("phone"),
			value: term(literal("555")),
		});
		if (!("error" in result.result)) throw new Error("expected a refusal");
		expect(result.result.error).toContain(
			'Search filter 1 on "Patient" sends "phone", which a search field there already sends.',
		);
		expect(h.currentDoc()).toEqual(before);
	});
});
