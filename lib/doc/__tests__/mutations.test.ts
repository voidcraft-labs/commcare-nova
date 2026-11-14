import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { type Mutation, mutationSchema } from "@/lib/doc/types";
import { emptyCaseListConfig } from "@/lib/domain";

const uuid = testUuid("mutation-grammar-subject");
const columnUuid = testUuid("mutation-grammar-column");
const column = { kind: "plain", field: "case_name", header: "Name" };
const input = {
	kind: "simple",
	name: "name",
	label: "Name",
	type: "text",
	property: "case_name",
};

// Reachable commands are parsed, serialized and committed in their owning behavior
// suites. This boundary suite rejects ambiguous or obsolete grammar without stripping
// it into a different accepted command; it is not a parallel mutation inventory.
describe("canonical mutation grammar", () => {
	it.each([
		{
			kind: "updateModule",
			uuid,
			patch: { caseListConfig: emptyCaseListConfig() },
			ensureCaseListConfig: true,
		},
		{
			kind: "updateModule",
			uuid,
			patch: { caseSearchConfig: { searchScreenTitle: "Old" } },
			caseSearchConfigPatch: { searchScreenTitle: "New" },
		},
		{
			kind: "updateColumn",
			moduleUuid: uuid,
			uuid: columnUuid,
			column,
			sortPatch: { direction: "desc", priority: 0 },
		},
		{
			kind: "updateColumn",
			moduleUuid: uuid,
			uuid: columnUuid,
			column,
			visibilityPatch: { surface: "list", visible: false },
		},
		{
			kind: "updateColumn",
			moduleUuid: uuid,
			uuid: columnUuid,
			column: { ...column, listOrder: "obsolete" },
		},
		{
			kind: "updateColumn",
			moduleUuid: uuid,
			uuid: columnUuid,
			visibilityPatch: { surface: "list", visible: true, notOnList: true },
		},
		{
			kind: "updateColumn",
			moduleUuid: uuid,
			uuid: columnUuid,
			visibilityPatch: { surface: "detail", visible: false, notOnList: true },
		},
		{
			kind: "updateColumn",
			moduleUuid: uuid,
			uuid: columnUuid,
			column: { ...column, notOnList: true },
		},
		{
			kind: "moveColumn",
			moduleUuid: uuid,
			uuid: columnUuid,
			surfaceOrderPatch: { surface: "list", order: "obsolete" },
		},
		{
			kind: "updateSearchInput",
			moduleUuid: uuid,
			uuid: columnUuid,
			searchInput: input,
			renamedTo: "alternate",
		},
		{
			kind: "updateSearchInput",
			moduleUuid: uuid,
			uuid: columnUuid,
			searchInput: {
				...input,
				type: "date-range",
				property: "date_opened",
				mode: { kind: "range" },
				default: { kind: "today" },
			},
		},
		{ kind: "totallyMadeUp", uuid },
	])("refuses the complete non-canonical payload %j", (payload) => {
		expect(mutationSchema.safeParse(payload).success).toBe(false);
		expect(() =>
			admitMutationBatch([payload as unknown as Mutation]),
		).toThrow();
	});
});

describe("a column's list state", () => {
	it.each([
		{ surface: "list", visible: false, notOnList: true },
		{ surface: "list", visible: false, notOnList: false },
	])("admits hiding a column from Results with notOnList %j", (patch) => {
		const payload = {
			kind: "updateColumn",
			moduleUuid: uuid,
			uuid: columnUuid,
			visibilityPatch: patch,
		};
		expect(mutationSchema.safeParse(payload).success).toBe(true);
	});
});
