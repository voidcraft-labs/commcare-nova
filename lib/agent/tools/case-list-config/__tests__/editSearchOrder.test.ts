import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { mutationTargetsInvalid } from "@/lib/doc/mutationTargetAdmission";
import { literal, term } from "@/lib/domain/expression";
import { searchRequestOrderSchema } from "@/lib/domain/modules";
import {
	editSearchFilterInputSchema,
	editSearchFilterTool,
} from "../editSearchFilter";
import { MOD_A, makeCaseListDoc, makeCaseListFixture } from "./fixtures";

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

// An edit changes a row of its own kind: an order patched as a value filter,
// or a value filter patched as an order, would merge into a row of neither
// shape. The tool says which operation the row takes, and the shared target
// admission refuses the same batch from any other editor.
it("refuses an edit of one filter kind on a row of the other", async () => {
	const h = makeCaseListFixture();
	const orderId = testUuid("kind-order");
	const ownersId = testUuid("kind-owners");
	const call = (
		change: Parameters<typeof editSearchFilterTool.execute>[0]["change"],
	) => h.runTool(editSearchFilterTool, { moduleUuid: MOD_A, change });
	const byName = {
		property: "case_name",
		comparison: "text",
		direction: "ascending",
	} as const;
	const owners = {
		kind: "excluded-owners",
		placement: "search-setting",
	} as const;
	await call({ operation: "add-order", uuid: orderId, order: [byName] });
	await call({
		operation: "add",
		uuid: ownersId,
		target: owners,
		value: term(literal("retired-team")),
	});
	expect(
		(
			await call({
				operation: "edit",
				uuid: orderId,
				value: term(literal("x")),
			})
		).result,
	).toMatchObject({
		error:
			"That filter is an order. Use edit-order to change it, or remove it and add a filter.",
	});
	expect(
		(await call({ operation: "edit-order", uuid: ownersId, order: [byName] }))
			.result,
	).toMatchObject({
		error:
			"That filter matches a value. Use edit to change it, or remove it and add an order.",
	});
	const doc = h.currentDoc();
	expect(doc.modules[MOD_A]?.caseListConfig?.searchFilters).toEqual([
		{ kind: "order", uuid: orderId, order: [byName] },
		{ uuid: ownersId, target: owners, value: term(literal("retired-team")) },
	]);
	expect(
		mutationTargetsInvalid(doc, [
			{
				kind: "setCaseListMeta",
				uuid: MOD_A,
				patch: {
					searchFilterEdit: {
						operation: "edit",
						uuid: orderId,
						patch: { value: term(literal("x")) },
					},
				},
			},
		]),
	).toBe(true);
	expect(
		mutationTargetsInvalid(doc, [
			{
				kind: "setCaseListMeta",
				uuid: MOD_A,
				patch: {
					searchFilterEdit: {
						operation: "edit",
						uuid: ownersId,
						patch: { order: [byName] },
					},
				},
			},
		]),
	).toBe(true);
});

it("authors one index fallback as an order filter and refuses a second without altering the first", async () => {
	const doc = makeCaseListDoc();
	doc.modules[MOD_A].caseSearchConfig = { workflow: "skipToResults" };
	const h = makeCaseListFixture(doc);
	const reset = {
		property: "last_visit",
		comparison: "indexed-fallback",
		direction: "ascending",
	} as const;
	const uuid = testUuid("search-fallback-filter");
	expect(
		editSearchFilterInputSchema.safeParse({
			moduleUuid: MOD_A,
			change: { operation: "add-order", uuid, order: [reset] },
		}).success,
	).toBe(true);
	expect(
		editSearchFilterInputSchema.safeParse({
			moduleUuid: MOD_A,
			change: { operation: "add-order", uuid, order: [reset, reset] },
		}).success,
	).toBe(false);
	expect(searchRequestOrderSchema.safeParse([reset]).success).toBe(false);
	const call = (id: typeof uuid) =>
		h.runTool(editSearchFilterTool, {
			moduleUuid: MOD_A,
			change: { operation: "add-order", uuid: id, order: [reset] },
		});
	expect((await call(uuid)).result).toMatchObject({ ok: true });
	expect(
		(await call(testUuid("second-search-fallback-filter"))).result,
	).toMatchObject({
		error: expect.stringContaining(
			"Keep index fallbacks together in one order",
		),
	});
	expect(h.currentDoc().modules[MOD_A].caseListConfig?.searchFilters).toEqual([
		{ uuid, kind: "order", order: [reset] },
	]);
});
