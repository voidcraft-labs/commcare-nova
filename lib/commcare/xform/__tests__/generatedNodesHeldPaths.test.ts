/**
 * The allocator reserves every held Save to Case path before it names
 * anything: a published block's names never move, and an unheld node whose
 * base a held segment takes steps around it. Catches a held path that a
 * later edit silently renames, and an unheld block written over a held one.
 */
import { describe, expect, it } from "vitest";
import { FormPath } from "@/lib/commcare/xform/formPath";
import { planGeneratedNodes } from "@/lib/commcare/xform/generatedNodes";
import type { CaseOperation } from "@/lib/domain";
import {
	OP,
	own,
	placementFixture,
	read,
	U,
} from "../../__tests__/placementFixture";

const update = (
	key: string,
	extra: Partial<CaseOperation> = {},
): CaseOperation =>
	({
		uuid: OP(key),
		id: key,
		action: "update",
		caseType: "patient",
		target: { kind: "session" },
		writes: [{ property: "status", value: read("status") }],
		...extra,
	}) as CaseOperation;

describe("held Save to Case paths", () => {
	it("steps an unheld node around a held segment of another owner", () => {
		const { doc, formUuid } = placementFixture("followup", {
			operations: () => [
				own(),
				update("a", {
					placement: {
						kind: "save-to-case",
						path: ["nova_operations", "nova_condition_b"],
					},
				}),
				update("b", { condition: read("flag") }),
			],
		});
		const plan = planGeneratedNodes(doc, formUuid);
		expect(plan.condition(OP("b"))).toBe("nova_condition_b_1");
	});

	it("keeps the held owner's own names and the scope's one operations group", () => {
		const { doc, formUuid } = placementFixture("followup", {
			operations: () => [
				own(),
				update("a", {
					condition: read("flag"),
					placement: {
						kind: "save-to-case",
						path: ["nova_operations", "nova_condition_a", "a"],
					},
				}),
			],
		});
		const plan = planGeneratedNodes(doc, formUuid);
		expect(plan.condition(OP("a"))).toBe("nova_condition_a");
		expect(plan.operations(FormPath.root())).toBe("nova_operations");
	});

	it("reserves a held path in its repeat's scope", () => {
		const { doc, formUuid } = placementFixture("followup", {
			operations: () => [
				own(),
				update("a", {
					forEach: { repeat: U("kids") },
					placement: {
						kind: "save-to-case",
						repeat: U("kids"),
						path: ["nova_operations", "nova_condition_b"],
					},
				}),
				update("b", {
					forEach: { repeat: U("kids") },
					condition: read("flag"),
				}),
				update("c", { condition: read("flag") }),
			],
		});
		const plan = planGeneratedNodes(doc, formUuid);
		expect(plan.condition(OP("b"))).toBe("nova_condition_b_1");
		// The root's operations namespace holds no segment of the repeat's path.
		expect(plan.condition(OP("c"))).toBe("nova_condition_c");
	});

	it("keeps a held own close and steps the unheld close around another owner's", () => {
		const { doc, formUuid } = placementFixture("close", {
			operations: () => [
				own(),
				update("a", {
					placement: {
						kind: "save-to-case",
						path: ["nova_operations", "nova_close"],
					},
				}),
			],
		});
		expect(planGeneratedNodes(doc, formUuid).close()).toBe("nova_close_1");
		const held = placementFixture("close", {
			operations: () => [own()],
			form: {
				ownClosePlacement: {
					kind: "save-to-case",
					path: ["nova_operations", "nova_condition_close", "nova_close"],
				},
			},
		});
		const plan = planGeneratedNodes(held.doc, held.formUuid);
		expect(plan.conditionClose()).toBe("nova_condition_close");
		expect(plan.close()).toBe("nova_close");
	});

	it("reserves a held first segment among the scope's questions' siblings", () => {
		const { doc, formUuid } = placementFixture("followup", {
			operations: () => [
				own({
					writes: [
						{
							property: "photo_url",
							value: {
								kind: "term",
								term: { kind: "capture-link", field: U("photo") },
							},
						},
					],
				}),
				update("a", {
					placement: { kind: "save-to-case", path: ["nova_url_photo", "a"] },
				}),
			],
		});
		expect(planGeneratedNodes(doc, formUuid).url(U("photo"))).toBe(
			"nova_url_photo_1",
		);
	});
});
