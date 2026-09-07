import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { loadApp } from "@/lib/db/apps";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { Predicate } from "@/lib/domain/predicate";
import {
	CASE_STATUS_FILTER_REPAIR_TARGETS,
	runCaseStatusFilterRepair,
} from "../caseStatusFilterRepair";

const h = setupAppStateTestDb();
const FIRST_APP = "NJEsUdfCjbgBqAv3nXDN";
const SECOND_APP = "vPgekIpjxRVLyVhJORw6";
function fixture(appId: string) {
	return buildDoc({
		appId,
		appName: "Sample tracking",
		caseTypes: [
			{
				name: "rdt_sample",
				properties: [
					{ name: "case_name", label: "Sample ID", data_type: "text" },
					{
						name: "status_value",
						label: "Sample status",
						data_type: "single_select",
						options: [
							{ value: "collected", label: "Collected" },
							{ value: "delivered", label: "Delivered" },
						],
					},
				],
			},
		],
		modules: CASE_STATUS_FILTER_REPAIR_TARGETS.filter(
			(target) => target.appId === appId,
		).map((target) => ({
			uuid: target.moduleUuid,
			name: target.value,
			caseType: "rdt_sample",
			caseListOnly: true,
			caseListConfig: {
				...caseListConfig([{ field: "case_name", header: "Sample" }]),
				filter: {
					kind: "eq",
					left: {
						kind: "term",
						term: {
							kind: "prop",
							caseType: "rdt_sample",
							property: "status",
							via: { kind: "self" },
						},
					},
					right: {
						kind: "term",
						term: {
							kind: "literal",
							value: target.value,
							data_type: target.literalDataType,
						},
					},
				} satisfies Predicate,
			},
		})),
	});
}

describe("case-status historical repair through the guarded writer", () => {
	it("repairs all three reviewed filters in both apps, preserves the documents and writes history once", async () => {
		const documents = [fixture(FIRST_APP), fixture(SECOND_APP)];
		await h.seedAppWithBlueprint(fixture(FIRST_APP), {
			id: "outside-reviewed-scope",
		});
		for (const doc of documents)
			await h.seedAppWithBlueprint(doc, { id: doc.appId });
		expect(await runCaseStatusFilterRepair()).toEqual({
			scannedApps: 2,
			repairedApps: 2,
			repairedFilters: 3,
			cleanFilters: 0,
			supersededFilters: 0,
			blockedFilters: 0,
		});
		for (const original of documents) {
			const expected = structuredClone(original);
			for (const module of Object.values(expected.modules)) {
				const filter = module.caseListConfig?.filter;
				if (
					filter?.kind !== "eq" ||
					filter.left.kind !== "term" ||
					filter.left.term.kind !== "prop"
				)
					throw new Error("Missing fixture filter");
				filter.left.term.property = "status_value";
			}
			expect((await loadApp(original.appId))?.blueprint).toEqual(
				toPersistableDoc(expected),
			);
		}
		const history = await h
			.db()
			.selectFrom("app_changes")
			.select(["app_id", "kind", "actor_id", "seq"])
			.orderBy("app_id")
			.execute();
		expect(history).toEqual([
			{
				app_id: FIRST_APP,
				kind: "blueprint-migration",
				actor_id: "system:case-status-filter-cutover",
				seq: "1",
			},
			{
				app_id: SECOND_APP,
				kind: "blueprint-migration",
				actor_id: "system:case-status-filter-cutover",
				seq: "1",
			},
		]);
		expect(await runCaseStatusFilterRepair()).toEqual({
			scannedApps: 2,
			repairedApps: 0,
			repairedFilters: 0,
			cleanFilters: 3,
			supersededFilters: 0,
			blockedFilters: 0,
		});
		expect(
			await h
				.db()
				.selectFrom("app_changes")
				.select(["app_id", "kind", "actor_id", "seq"])
				.orderBy("app_id")
				.execute(),
		).toEqual(history);
	});

	it("keeps a later user correction while repairing the remaining reviewed filter", async () => {
		const doc = fixture(FIRST_APP);
		const module = doc.modules[doc.moduleOrder[0]];
		if (module.caseListConfig === undefined) throw new Error("Missing list");
		module.caseListConfig.filter = { kind: "match-all" };
		await h.seedAppWithBlueprint(doc, { id: FIRST_APP });
		expect(await runCaseStatusFilterRepair()).toMatchObject({
			repairedApps: 1,
			repairedFilters: 1,
			supersededFilters: 1,
		});
		expect(
			(await loadApp(FIRST_APP))?.blueprint.modules[module.uuid].caseListConfig
				?.filter,
		).toEqual({ kind: "match-all" });
	});

	it("refuses the whole app before writing when a reviewed destination is missing", async () => {
		const doc = fixture(FIRST_APP);
		const property = doc.caseTypes?.[0]?.properties.find(
			(candidate) => candidate.name === "status_value",
		);
		if (property === undefined) throw new Error("Missing property");
		property.options = [
			{
				value: "collected",
				label: { parts: [{ kind: "text", text: "Collected" }] },
			},
		];
		await h.seedAppWithBlueprint(doc, { id: FIRST_APP });
		const before = await h
			.db()
			.selectFrom("blueprint_entities")
			.selectAll()
			.orderBy("uuid")
			.execute();
		await expect(runCaseStatusFilterRepair()).rejects.toThrow(
			"status_value no longer declares the delivered option",
		);
		expect(
			await h
				.db()
				.selectFrom("blueprint_entities")
				.selectAll()
				.orderBy("uuid")
				.execute(),
		).toEqual(before);
		expect(
			await h.db().selectFrom("app_changes").selectAll().execute(),
		).toEqual([]);
	});
});
