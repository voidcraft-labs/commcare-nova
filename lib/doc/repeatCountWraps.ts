/**
 * The defect 30 rule the fuzz mapping and the cutover share: every
 * count-bound repeat whose count the checker refuses as not a whole number
 * (`typeChecker.ts::repeatCountRefusal`, reasons `whole-number-count`,
 * `count-choice-not-whole`, `count-choices-unknown`) has its count wrapped in
 * `int(...)`, which keeps the count's whole part.
 *
 * CommCare reads a repeat's count as `IntegerData().cast(count.uncast())`
 * (commcare-core `FormEntryModel.createModelForGroup`,
 * `FormDef.canCreateRepeat`), and `IntegerData.cast` is `Integer.parseInt`,
 * so a count that isn't whole text stops the form. `int(...)` truncates toward
 * zero (`FunctionUtils.toInt`), and the checker types it `int` over every
 * argument, so a wrapped count is admitted.
 *
 * Pure and deterministic: the same document plans the same mutations, in
 * field uuid order, and a document it has already wrapped plans none.
 */

import type { BlueprintDoc } from "@/lib/domain/blueprint";
import {
	expressionFacts,
	type LookupTypeIndex,
	slotContext,
} from "@/lib/domain/expression/context";
import { checkExpression } from "@/lib/domain/expression/typeChecker";
import type { Expression } from "@/lib/domain/expression/types";
import type { Mutation } from "./types";

/** The checker's reasons for a count that isn't a whole number. */
const NOT_WHOLE_REASONS: ReadonlySet<string> = new Set([
	"whole-number-count",
	"count-choice-not-whole",
	"count-choices-unknown",
]);

/** One `updateField` per count-bound repeat whose count the checker refuses
 * as not a whole number, carrying the count wrapped in `int(...)`. A count the
 * checker cannot type because of an earlier error is left as it is: the
 * checker raises nothing about its wholeness, and the earlier error is the
 * author's to fix. */
export function planRepeatCountWraps(
	doc: BlueprintDoc,
	lookupTables: LookupTypeIndex = new Map(),
): Mutation[] {
	const facts = expressionFacts(doc);
	const mutations: Mutation[] = [];
	const repeats = Object.values(doc.fields)
		.filter((field) => field.kind === "repeat")
		.sort((a, b) => (a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0));
	for (const field of repeats) {
		if (field.repeat_mode !== "count_bound") continue;
		const count = field.repeat_count;
		if (count === undefined) continue;
		const ctx = slotContext(
			doc,
			{ entity: "field", uuid: field.uuid, slot: "repeat_count" },
			lookupTables,
			{ facts },
		);
		if (ctx === undefined) continue;
		const refused = checkExpression(count, ctx).errors.some(
			(error) =>
				error.code === "expected-value" &&
				error.reason !== undefined &&
				NOT_WHOLE_REASONS.has(error.reason),
		);
		if (!refused) continue;
		const wrapped: Expression = { kind: "call", fn: "int", args: [count] };
		mutations.push({
			kind: "updateField",
			uuid: field.uuid,
			targetKind: "repeat",
			patch: { repeat_count: wrapped },
		});
	}
	return mutations;
}
