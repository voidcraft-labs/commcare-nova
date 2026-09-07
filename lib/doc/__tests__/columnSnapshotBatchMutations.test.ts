import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { type BlueprintDoc, type Column, plainColumn } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import {
	columnAddMutation,
	columnSnapshotBatchMutations,
} from "../caseListColumnMutations";
import { mutationCommitVerdict } from "../commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "../lookupReferences";
import { type Mutation, mutationSchema } from "../types";
import { assertAdmittedDoc } from "./admittedDoc";

function fixture() {
	const config = caseListConfig([
		{ field: "case_name", header: "Name" },
		{ field: "dob", header: "Birth date" },
	]);
	config.detailColumnOrder.reverse();
	const doc = buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name"), data_type: "text" },
					{ name: "dob", label: proseText("Birth date"), data_type: "date" },
					{ name: "region", label: proseText("Region"), data_type: "text" },
					{ name: "stage", label: proseText("Stage"), data_type: "text" },
				],
			},
		],
		modules: [
			{
				name: "Clients",
				caseType: "patient",
				caseListOnly: true,
				caseListConfig: config,
			},
		],
	});
	assertAdmittedDoc(doc);
	const moduleUuid = doc.moduleOrder[0];
	const current = doc.modules[moduleUuid].caseListConfig;
	if (!current) throw new Error("Missing admitted case list");
	return { doc, moduleUuid, current };
}
function commit(doc: BlueprintDoc, mutations: Mutation[]) {
	const wire = mutations.map((m) =>
		mutationSchema.parse(JSON.parse(JSON.stringify(m))),
	);
	const verdict = mutationCommitVerdict(doc, wire, LOOKUP_CONTEXT_UNAVAILABLE);
	expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
	if (!verdict.ok) throw new Error(JSON.stringify(verdict));
	assertAdmittedDoc(verdict.nextDoc);
	return verdict.nextDoc;
}
function hidden(property: string, priority?: number): Column {
	return {
		...plainColumn(testUuid(`order-${property}`), property, property),
		visibleInList: false,
		visibleInDetail: false,
		...(priority === undefined
			? {}
			: { sort: { direction: "asc" as const, priority } }),
	};
}
describe("column snapshot births", () => {
	it("adds sorting-only information to both independent permutations in one admitted commit", () => {
		const { doc, moduleUuid, current } = fixture();
		const region = hidden("region", 0),
			stage = hidden("stage", 1);
		const mutations = columnSnapshotBatchMutations(moduleUuid, current, [
			...current.columns,
			region,
			stage,
		]);
		const next = commit(doc, mutations).modules[moduleUuid].caseListConfig;
		expect(next).toEqual({
			...current,
			columns: [...current.columns, region, stage],
			listColumnOrder: [...current.listColumnOrder, region.uuid, stage.uuid],
			detailColumnOrder: [
				...current.detailColumnOrder,
				region.uuid,
				stage.uuid,
			],
		});
	});
	it("replays a birth without losing peer labels, peer rows, or omitted existing definitions", () => {
		const { doc, moduleUuid, current } = fixture();
		const region = hidden("region", 0),
			peer = hidden("stage");
		const authored = columnSnapshotBatchMutations(moduleUuid, current, [
			current.columns[0],
			region,
		]);
		const withPeer = commit(doc, [
			{
				kind: "updateColumn",
				moduleUuid,
				uuid: current.columns[0].uuid,
				column: { kind: "plain", field: "case_name", header: "Peer name" },
			},
			columnAddMutation(moduleUuid, peer, {
				afterInList: current.listColumnOrder.at(-1) ?? null,
				afterInDetail: current.detailColumnOrder.at(-1) ?? null,
			}),
		]);
		const next = commit(withPeer, authored).modules[moduleUuid].caseListConfig;
		expect(next?.columns).toEqual([
			{ ...current.columns[0], header: "Peer name" },
			current.columns[1],
			peer,
			region,
		]);
		expect(next?.listColumnOrder).toEqual([
			...current.listColumnOrder,
			region.uuid,
			peer.uuid,
		]);
		expect(next?.detailColumnOrder).toEqual([
			...current.detailColumnOrder,
			region.uuid,
			peer.uuid,
		]);
	});
});
