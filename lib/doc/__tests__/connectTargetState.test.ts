import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { applyMutations } from "@/lib/doc/mutations";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import { proseText } from "@/lib/domain/prose";
import { planConnectTargetState } from "../connectTargetState";

function fixture() {
	const doc = buildDoc({
		appName: "Connect planner",
		modules: [
			{
				name: "Main",
				forms: [
					{
						name: "First",
						type: "survey",
						fields: [
							f({ kind: "text", id: "first", label: proseText("First") }),
						],
					},
					{
						name: "Second",
						type: "survey",
						fields: [
							f({ kind: "text", id: "second", label: proseText("Second") }),
						],
					},
				],
			},
		],
	});
	const moduleUuid = doc.moduleOrder[0];
	if (!moduleUuid) throw new Error("fixture module missing");
	const first = doc.formOrder[moduleUuid]?.[0];
	const second = doc.formOrder[moduleUuid]?.[1];
	if (!first || !second) throw new Error("fixture forms missing");
	return {
		doc,
		first,
		second,
	};
}

const learn = (id: string) => ({
	learn_module: {
		id,
		name: "Learn",
		description: "Learning",
		time_estimate: 5,
	},
});

const deliver = (id: string) => ({
	deliver_unit: { id, name: "Delivery" },
});

const apply = (doc: BlueprintDoc, mutations: readonly Mutation[]) =>
	produce(doc, (draft) => {
		applyMutations(draft, mutations);
	});

describe("planConnectTargetState", () => {
	it("enables a mode and its complete participant set in one batch", () => {
		const { doc, first } = fixture();
		const plan = planConnectTargetState(doc, {
			mode: "learn",
			participants: [{ formUuid: first, connect: learn("first_learn") }],
		});
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.mutations.map((mutation) => mutation.kind)).toEqual([
			"setConnectType",
			"updateForm",
		]);
		const next = apply(doc, plan.mutations);
		expect(next.connectType).toBe("learn");
		expect(next.forms[first]?.connect).toEqual(learn("first_learn"));
	});

	it("switches modes, replaces participants, and clears every unlisted block", () => {
		const { doc, first, second } = fixture();
		const enabled = planConnectTargetState(doc, {
			mode: "learn",
			participants: [
				{ formUuid: first, connect: learn("first_learn") },
				{ formUuid: second, connect: learn("second_learn") },
			],
		});
		if (!enabled.ok) throw new Error(enabled.messages.join("\n"));
		const current = apply(doc, enabled.mutations);

		const switched = planConnectTargetState(current, {
			mode: "deliver",
			participants: [{ formUuid: second, connect: deliver("second_delivery") }],
		});
		if (!switched.ok) throw new Error(switched.messages.join("\n"));
		const next = apply(current, switched.mutations);
		expect(next.connectType).toBe("deliver");
		expect(next.forms[first]?.connect).toBeUndefined();
		expect(next.forms[second]?.connect).toEqual(deliver("second_delivery"));
	});

	it("replaces the same mode's participant set without retaining a dormant config", () => {
		const { doc, first, second } = fixture();
		const enabled = planConnectTargetState(doc, {
			mode: "learn",
			participants: [{ formUuid: first, connect: learn("first_learn") }],
		});
		if (!enabled.ok) throw new Error(enabled.messages.join("\n"));
		const current = apply(doc, enabled.mutations);

		const replacement = planConnectTargetState(current, {
			mode: "learn",
			participants: [{ formUuid: second, connect: learn("second_learn") }],
		});
		if (!replacement.ok) throw new Error(replacement.messages.join("\n"));
		const next = apply(current, replacement.mutations);
		expect(next.forms[first]?.connect).toBeUndefined();
		expect(next.forms[second]?.connect).toEqual(learn("second_learn"));
	});

	it("disables Connect by clearing the mode and every form block", () => {
		const { doc, first } = fixture();
		const enabled = planConnectTargetState(doc, {
			mode: "learn",
			participants: [{ formUuid: first, connect: learn("first_learn") }],
		});
		if (!enabled.ok) throw new Error(enabled.messages.join("\n"));
		const current = apply(doc, enabled.mutations);
		const disabled = planConnectTargetState(current, { mode: null });
		if (!disabled.ok) throw new Error(disabled.messages.join("\n"));
		const next = apply(current, disabled.mutations);
		expect(next.connectType).toBeNull();
		expect(Object.values(next.forms).every((form) => !form?.connect)).toBe(
			true,
		);
	});

	it.each([
		{
			label: "empty participation",
			target: { mode: "learn" as const, participants: [] },
			fragment: "at least one",
		},
		{
			label: "foreign form",
			target: {
				mode: "learn" as const,
				participants: [
					{
						formUuid: "01911111-1111-7111-8111-111111111111",
						connect: learn("foreign"),
					},
				],
			},
			fragment: "not a form",
		},
	])("rejects $label before constructing mutations", ({ target, fragment }) => {
		const { doc } = fixture();
		const plan = planConnectTargetState(doc, target);
		expect(plan.ok).toBe(false);
		if (plan.ok) return;
		expect(plan.messages.join(" ")).toContain(fragment);
	});

	it("rejects duplicate participants, wrong-mode configs, and duplicate ids", () => {
		const { doc, first, second } = fixture();
		for (const target of [
			{
				mode: "learn" as const,
				participants: [
					{ formUuid: first, connect: learn("one") },
					{ formUuid: first, connect: learn("two") },
				],
			},
			{
				mode: "learn" as const,
				participants: [{ formUuid: first, connect: deliver("wrong") }],
			},
			{
				mode: "learn" as const,
				participants: [
					{ formUuid: first, connect: learn("duplicate") },
					{ formUuid: second, connect: learn("duplicate") },
				],
			},
		]) {
			const plan = planConnectTargetState(doc, target);
			expect(plan.ok).toBe(false);
		}
	});
});
