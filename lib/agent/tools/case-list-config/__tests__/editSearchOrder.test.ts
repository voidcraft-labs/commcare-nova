import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { literal, term } from "@/lib/domain/expression";
import { editSearchFilterTool } from "../editSearchFilter";
import { MOD_A, makeCaseListFixture } from "./fixtures";

it("edits the selected order and recovers from a second owner exclusion without losing either row", async () => {
	const h = makeCaseListFixture();
	const orderId = testUuid("request-priority");
	const ownersId = testUuid("search-owners");
	const call = (
		change: Parameters<typeof editSearchFilterTool.execute>[0]["change"],
	) => h.runTool(editSearchFilterTool, { moduleUuid: MOD_A, change });
	const byDate = {
		property: "last_visit",
		comparison: "date",
		direction: "ascending",
	} as const;
	const latestFirst = { ...byDate, direction: "descending" } as const;
	const owners = {
		kind: "excluded-owners",
		placement: "search-setting",
	} as const;
	expect(
		(await call({ operation: "add-order", uuid: orderId, order: [byDate] }))
			.result,
	).toMatchObject({ ok: true });
	expect(
		(
			await call({
				operation: "add",
				uuid: ownersId,
				after: orderId,
				target: owners,
				value: term(literal("retired-team")),
			})
		).result,
	).toMatchObject({ ok: true });
	expect(
		(
			await call({
				operation: "add",
				target: { kind: "excluded-owners" },
				value: term(literal("standby-team")),
			})
		).result,
	).toMatchObject({ error: expect.stringContaining("one rule") });
	expect(
		(
			await call({
				operation: "edit-order",
				uuid: orderId,
				order: [latestFirst],
			})
		).result,
	).toMatchObject({ ok: true });
	const both = term(literal("retired-team standby-team"));
	expect(
		(await call({ operation: "edit", uuid: ownersId, value: both })).result,
	).toMatchObject({ ok: true });
	expect(h.currentDoc().modules[MOD_A]?.caseListConfig?.searchFilters).toEqual([
		{ kind: "order", uuid: orderId, order: [latestFirst] },
		{ uuid: ownersId, target: owners, value: both },
	]);
});
