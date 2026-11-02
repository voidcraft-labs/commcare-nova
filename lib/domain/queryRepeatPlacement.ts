// lib/domain/queryRepeatPlacement.ts
//
// Where a query repeat's rows come from. A query repeat has two placements:
//
// - **model iteration** (`"model-iteration"`): the shape HQ's form builder
//   writes for a repeat over a query (Vellum's `src/modeliteration.js`, whose
//   setvalues run at `xforms-ready`). Its rows are the records the query
//   finds when the form opens, and they never follow a later change.
// - **the count placement** (`"count"`): the rows follow the query as the form
//   is filled in. It runs every shape.
//
// Model iteration's rows are the count placement's rows exactly where nothing
// the query reads changes during entry and the repeat is taken once: the
// repeat sits in no other repeat, its query reads no answer of the form, and
// no group around it shows on a condition that can change while the form is
// filled in. Its rows also keep their own records only while no row is
// hidden when a later one is made: model iteration gives a new row the place
// `int(@current_index)`, and `@current_index` is `count(<rows>)`, which
// counts only the relevant rows (`XPathLazyNodeset.java::performEvaluation`),
// so a row made while its condition hides an earlier one takes an earlier
// row's place and record. HQ's form builder writes those setvalues itself on
// every save (Vellum `src/modeliteration.js::getSetValues`), so a repeat with
// a condition needs the count placement, whose rows store their place from
// `position(..)`. Those are the needs below. A held placement (the repeat's stored
// `placement`) wins over the rule; an unheld repeat takes the rule's answer.

import { z } from "zod";
import type { FormStructure } from "./expression/formStructure";
import type { Expression } from "./expression/types";
import {
	expressionCallsNow,
	expressionReadsFormAnswers,
} from "./expression/walk";
import type { Uuid } from "./uuid";

export const QUERY_REPEAT_PLACEMENTS = ["model-iteration", "count"] as const;
export type QueryRepeatPlacement = (typeof QUERY_REPEAT_PLACEMENTS)[number];
export const queryRepeatPlacementSchema = z.enum(QUERY_REPEAT_PLACEMENTS);

/** What model iteration cannot run for a query repeat. */
export type QueryRepeatNeed =
	/** The nearest repeat of any mode around it. */
	| { readonly kind: "nested"; readonly repeatUuid: Uuid }
	/** Its query reads an answer of its own form. */
	| { readonly kind: "query-reads-answers" }
	/** It has a condition, which can hide a row before a later one is made. */
	| { readonly kind: "row-condition" }
	/** The nearest group around it whose condition can change during entry. */
	| { readonly kind: "ancestor-condition-changes"; readonly groupUuid: Uuid };

const needsByForm = new WeakMap<
	FormStructure,
	Map<Uuid, readonly QueryRepeatNeed[]>
>();

/** A condition that can change while the form is filled in reads one of its
 * answers or calls `now()`. `today()` is fixed for one entry in practice. */
function conditionCanChange(condition: Expression | undefined): boolean {
	return (
		condition !== undefined &&
		(expressionReadsFormAnswers(condition) || expressionCallsNow(condition))
	);
}

/** What model iteration cannot run for this query repeat, nearest first: its
 * own query and its own condition, then the nearest repeat and the nearest changing group around it
 * in the order they enclose it. Empty for a field the form does not hold. */
export function queryRepeatPlacementNeeds(
	form: FormStructure,
	uuid: Uuid,
): readonly QueryRepeatNeed[] {
	let forForm = needsByForm.get(form);
	const cached = forForm?.get(uuid);
	if (cached !== undefined) return cached;
	const needs: QueryRepeatNeed[] = [];
	const field = form.fields.get(uuid);
	if (field !== undefined) {
		// In the query itself neither `today()` nor `now()` counts: model
		// iteration takes the moment the form opens.
		const query = form.expressionAt({
			entity: "field",
			uuid,
			slot: "ids_query",
		});
		if (query !== undefined && expressionReadsFormAnswers(query))
			needs.push({ kind: "query-reads-answers" });
		if (
			form.expressionAt({ entity: "field", uuid, slot: "relevant" }) !==
			undefined
		)
			needs.push({ kind: "row-condition" });
		let nested = false;
		let conditionChanges = false;
		const seen = new Set<Uuid>([uuid]);
		let current = field.parent;
		while (current !== form.formUuid && !seen.has(current)) {
			seen.add(current);
			const ancestor = form.fields.get(current);
			if (ancestor === undefined) break;
			if (ancestor.kind === "repeat" && !nested) {
				nested = true;
				needs.push({ kind: "nested", repeatUuid: ancestor.uuid });
			} else if (
				ancestor.kind === "group" &&
				!conditionChanges &&
				conditionCanChange(
					form.expressionAt({
						entity: "field",
						uuid: ancestor.uuid,
						slot: "relevant",
					}),
				)
			) {
				conditionChanges = true;
				needs.push({
					kind: "ancestor-condition-changes",
					groupUuid: ancestor.uuid,
				});
			}
			// A section has no condition, and is never a need.
			current = ancestor.parent;
		}
	}
	if (forForm === undefined) {
		forForm = new Map();
		needsByForm.set(form, forForm);
	}
	forForm.set(uuid, needs);
	return needs;
}

/** The placement every export, Preview and the gate read for a query repeat:
 * the one it holds where it holds one, else model iteration with no need and
 * the count placement with any. */
export function effectiveQueryRepeatPlacement(
	form: FormStructure,
	uuid: Uuid,
): QueryRepeatPlacement {
	const held = form.fields.get(uuid)?.heldQueryPlacement;
	if (held !== undefined) return held;
	return queryRepeatPlacementNeeds(form, uuid).length === 0
		? "model-iteration"
		: "count";
}

/** Whether `placement` can express this repeat as `form` holds it: the count
 * placement always, model iteration exactly when the repeat has no need. */
export function queryRepeatPlacementExpresses(
	form: FormStructure,
	uuid: Uuid,
	placement: QueryRepeatPlacement,
): boolean {
	return (
		placement === "count" || queryRepeatPlacementNeeds(form, uuid).length === 0
	);
}
