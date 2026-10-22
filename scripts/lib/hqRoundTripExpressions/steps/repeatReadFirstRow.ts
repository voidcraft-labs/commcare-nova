/**
 * Step 6, `repeat-read-first-row` (part 09 §5; part 03 §3.4): a structural
 * several-value read, a repeat's answer read from outside the repeat where
 * one value is needed (the checker's `many-values`, reason `repeat`), gains
 * `FieldStepFilter { step: <repeat>, where: [1] }` on its repeat step,
 * printed `[1]`: the only value Core reads without stopping the form. The
 * slot is then checked again, and the rewrite stays only where it settles
 * every such finding. A read in a prose part has no filter, so it stays a
 * `target-gate` finding (`XPATH_MANY_VALUES`) for the author.
 */

import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { slotContext } from "@/lib/domain/expression/context";
import { mapExpressionAst } from "@/lib/domain/expression/mapAst";
import { checkExpression } from "@/lib/domain/expression/typeChecker";
import type {
	CheckPath,
	Expression,
	FormStepFilter,
	Term,
} from "@/lib/domain/expression/types";
import { walkExpression } from "@/lib/domain/expression/walk";
import type { Uuid } from "@/lib/domain/uuid";
import type { DocumentChange, ExpressionsStep } from "../types";
import { entityName, noticeText, slotForm } from "./shared";

function within(doc: BlueprintDoc, field: Uuid, repeat: Uuid): boolean {
	const seen = new Set<string>();
	let cursor: string | undefined = doc.fieldParent[field];
	while (cursor !== undefined && !seen.has(cursor)) {
		if (cursor === repeat) return true;
		seen.add(cursor);
		cursor = doc.fieldParent[cursor as Uuid];
	}
	return false;
}

function startsWith(path: CheckPath, prefix: CheckPath): boolean {
	return (
		prefix.length <= path.length &&
		prefix.every((segment, index) => path[index] === segment)
	);
}

const FIRST_ROW: Expression = {
	kind: "term",
	term: { kind: "literal", value: 1 },
};

/**
 * The tree with `[1]` on the repeat step of every field read under `at`
 * that crosses `repeat`, and the fields it filtered.
 */
export function takeFirstRow(
	expression: Expression,
	doc: BlueprintDoc,
	at: CheckPath,
	repeat: Uuid,
): { readonly value: Expression; readonly fields: readonly Uuid[] } {
	const targets = new Set<Term>();
	walkExpression(expression, {
		visitTerm: (term, path) => {
			if (
				term.kind === "field" &&
				startsWith(path, at) &&
				within(doc, term.uuid, repeat) &&
				!term.filters?.some(
					(filter) =>
						filter.step.kind === "field" && filter.step.uuid === repeat,
				)
			)
				targets.add(term);
		},
	});
	const fields: Uuid[] = [];
	const value = mapExpressionAst(expression, {
		mapTerm: (term) => {
			if (!targets.has(term) || term.kind !== "field") return undefined;
			fields.push(term.uuid);
			const filter: FormStepFilter = {
				step: { kind: "field", uuid: repeat },
				where: [FIRST_ROW],
			};
			return { ...term, filters: [...(term.filters ?? []), filter] };
		},
	});
	return { value, fields };
}

export const repeatReadFirstRowStep: ExpressionsStep = {
	id: "repeat-read-first-row",
	apply(doc) {
		const target = doc.target();
		if (!target.ok)
			return { changes: [], blockers: [], classes: [], places: [] };
		const lookupTypes = doc.lookupTypes();
		const changes: DocumentChange[] = [];
		let rows = 0;
		for (const slot of doc.slots()) {
			if (slot.ruleSet !== "form" || slot.lifted === false) continue;
			const expression = slot.lifted.value;
			if (expression === undefined) continue;
			const slotCtx = slotContext(target.doc, slot.ref, lookupTypes);
			if (slotCtx === undefined) continue;
			const many = checkExpression(expression, slotCtx).errors.filter(
				(error) =>
					error.code === "many-values" && error.several?.reason === "repeat",
			);
			if (many.length === 0) continue;
			let value = expression;
			const reads: { field: Uuid; repeat: Uuid }[] = [];
			for (const error of many) {
				if (error.several?.reason !== "repeat") continue;
				const repeat = error.several.repeat;
				const taken = takeFirstRow(value, target.doc, error.path, repeat);
				value = taken.value;
				for (const field of taken.fields) reads.push({ field, repeat });
			}
			const settled = !checkExpression(value, slotCtx).errors.some(
				(error) =>
					error.code === "many-values" && error.several?.reason === "repeat",
			);
			if (!settled || reads.length === 0) continue;
			doc.lift(slot, value, "repeat-read-first-row", new Set(["first-row"]));
			const form = slotForm(doc.raw, slot);
			for (const read of reads) {
				rows += 1;
				changes.push({
					reason: "repeat-read-takes-first-row",
					entity: {
						type: slot.owner.entity === "field" ? "field" : "form",
						uuid: slot.owner.uuid,
						nameAtMigration: entityName(
							doc.raw,
							slot.owner.entity,
							slot.owner.uuid,
						),
					},
					detail: {
						...(form === undefined || slot.owner.entity !== "field"
							? {}
							: { form: entityName(doc.raw, "form", form) }),
						question: noticeText(entityName(doc.raw, "field", read.field)),
						repeat: noticeText(entityName(doc.raw, "field", read.repeat)),
					},
				});
			}
		}
		return {
			changes,
			blockers: [],
			classes:
				rows === 0
					? []
					: [
							{
								step: "repeat-read-first-row",
								class: "first-row",
								count: rows,
							},
						],
			places: [],
		};
	},
};
