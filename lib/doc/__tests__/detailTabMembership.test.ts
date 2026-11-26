import { describe, expect, it } from "vitest";
import {
	removeColumnMutation,
	reorderColumnsMutation,
	updateColumnMutation,
} from "@/lib/agent/blueprintHelpers";
import { tileFixture } from "@/lib/commcare/__tests__/tileFixture";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { detailTabMembership } from "@/lib/domain/detailTabs";

describe("field changes on a tabbed case detail", () => {
	it("moves a field ahead of its tab's original anchor without changing either group or Results order", () => {
		const doc = tileFixture("detail-tabs");
		const menu = doc.modules[doc.moduleOrder[0]];
		const config = menu.caseListConfig;
		if (!config) throw new Error("The fixture menu has no case list.");
		const [name, village, visit] = config.detailColumnOrder;
		const plan = reorderColumnsMutation(menu, [village, name, visit], "detail");
		if ("error" in plan) throw Error(plan.error);
		const result = mutationCommitVerdict(
			doc,
			plan.mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(result.ok ? [] : result.findings).toEqual([]);
		const changed = result.nextDoc.modules[menu.uuid].caseListConfig;
		if (!changed) throw new Error("The committed menu lost its case list.");
		expect(changed.listColumnOrder).toEqual(config.listColumnOrder);
		expect(changed.detailTabs?.map((t) => [t.uuid, t.startColumnUuid])).toEqual(
			[
				[config.detailTabs?.[0].uuid, village],
				[config.detailTabs?.[1].uuid, visit],
			],
		);
		expect(detailTabMembership(changed).get(name)?.title).toBe("Visit");
		const raw = mutationCommitVerdict(
			doc,
			[
				{
					kind: "moveColumn",
					moduleUuid: menu.uuid,
					uuid: village,
					surface: "detail",
					after: visit,
				},
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(raw.ok ? [] : raw.findings.map((f) => f.code)).toContain(
			"CASE_DETAIL_TAB_MOVE_NEEDS_GROUP",
		);
	});

	it("keeps the next field as the first one and clears an empty group on both hiding and deletion", () => {
		const doc = tileFixture("detail-tabs");
		const menu = doc.modules[doc.moduleOrder[0]];
		const [name, village, visit] = menu.caseListConfig?.columns ?? [];
		if (!name || !village || !visit)
			throw new Error("The detail-tabs fixture has three fields.");
		const hidden = updateColumnMutation(menu, name.uuid, {
			...name,
			visibleInDetail: false,
		});
		if ("error" in hidden) throw Error(hidden.error);
		const result = mutationCommitVerdict(
			doc,
			hidden.mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(result.ok ? [] : result.findings).toEqual([]);
		const changed = result.nextDoc.modules[menu.uuid];
		expect(changed.caseListConfig?.detailTabs?.[0].startColumnUuid).toBe(
			village.uuid,
		);
		const removed = removeColumnMutation(changed, visit.uuid);
		if ("error" in removed) throw Error(removed.error);
		const next = mutationCommitVerdict(
			result.nextDoc,
			removed.mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(next.ok ? [] : next.findings).toEqual([]);
		expect(
			next.nextDoc.modules[menu.uuid].caseListConfig?.detailTabs?.map(
				(t) => t.title,
			),
		).toEqual(["Visit"]);
	});
});
