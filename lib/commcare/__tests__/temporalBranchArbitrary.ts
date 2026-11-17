/**
 * fast-check arbitrary over the workflow corpus (`suiteDocArbitrary`) whose
 * documents also hold a value-giving branch (`if`, `coalesce`, `switch`)
 * around a case property of a date or a date and time, in the record slots
 * that read the menu's case: a case list's filter, a form's display
 * condition and a calculated column. Every module's case type declares the
 * corpus's property pool, `last_seen` a date and time and `visit_date` a
 * date, beside `full_name`, text.
 *
 * Each draw places one shape in each slot it can: the comparison in a case
 * list's filter where the menu has no search (a search restates its list's
 * filter in CSQL), and in a form's display condition where every form of the
 * menu loads its case; the compared value as a calculated column. A document
 * the commit gate refuses after the placement is drawn without it, so the
 * corpus stays admitted documents.
 */

import * as fc from "fast-check";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import { calculatedColumn } from "@/lib/domain";
import {
	coalesce,
	datetimeCoerce,
	type Expression,
	gt,
	ifExpr,
	isBlank,
	literal,
	lte,
	now,
	prop,
	switchCase,
	switchExpr,
	term,
	today,
} from "@/lib/domain/expression";
import type { Uuid } from "@/lib/domain/uuid";
import { suiteDocArbitrary } from "./suiteDocArbitrary";

/** A comparison whose left side is a value-giving branch around a date or a
 *  date and time property of `caseType`. */
type Shape = (caseType: string) => Expression;

const seen = (caseType: string) => term(prop(caseType, "last_seen"));
const visited = (caseType: string) => term(prop(caseType, "visit_date"));
const named = (caseType: string) => term(prop(caseType, "full_name"));
const moment = (value: string) =>
	term({ kind: "literal", value, data_type: "datetime" });

export const TEMPORAL_BRANCH_SHAPES: readonly Shape[] = [
	(type) => gt(coalesce(seen(type), now()), now()),
	(type) => gt(coalesce(now(), seen(type)), now()),
	(type) => lte(ifExpr(isBlank(named(type)), seen(type), now()), now()),
	(type) => gt(ifExpr(isBlank(named(type)), seen(type), seen(type)), now()),
	(type) =>
		gt(
			switchExpr(
				named(type),
				[
					switchCase(literal("a"), seen(type)),
					switchCase(literal("b"), moment("2026-01-02T10:00:00+01:00")),
				],
				now(),
			),
			now(),
		),
	(type) => gt(coalesce(seen(type), moment("2026-01-01T00:00:00Z")), now()),
	(type) =>
		gt(
			coalesce(seen(type), datetimeCoerce(term(literal("2026-01-01")))),
			now(),
		),
	(type) => gt(coalesce(visited(type), today()), today()),
];

/** Every placement of `shape` in `doc`: each slot it can stand in. */
function placements(
	doc: BlueprintDoc,
	shape: Shape,
): ((draft: BlueprintDoc) => void)[] {
	const out: ((draft: BlueprintDoc) => void)[] = [];
	for (const moduleUuid of doc.moduleOrder) {
		const module = doc.modules[moduleUuid];
		const caseType = module?.caseType;
		if (module === undefined || caseType === undefined) continue;
		const condition = shape(caseType);
		const value = (condition as { readonly left: Expression }).left;
		if (
			module.caseListConfig !== undefined &&
			module.caseSearchConfig === undefined
		)
			out.push((draft) => {
				const config = draft.modules[moduleUuid]?.caseListConfig;
				if (config !== undefined) config.filter = condition;
			});
		const forms = doc.formOrder[moduleUuid] ?? [];
		if (
			forms.length > 0 &&
			forms.every((formUuid) => {
				const type = doc.forms[formUuid]?.type;
				return type === "followup" || type === "close";
			})
		)
			out.push((draft) => {
				const form = draft.forms[forms[0] as Uuid];
				if (form !== undefined) form.displayCondition = condition;
			});
		if (module.caseListConfig !== undefined)
			out.push((draft) => {
				const config = draft.modules[moduleUuid]?.caseListConfig;
				if (config === undefined) return;
				const column = calculatedColumn(
					`${moduleUuid.slice(0, -4)}cafe` as Uuid,
					"Seen",
					value,
				);
				config.columns.push(column);
				config.listColumnOrder.push(column.uuid);
				config.detailColumnOrder.push(column.uuid);
			});
	}
	return out;
}

/** `doc`, a fresh copy, with `places` applied and its derived reference
 *  index left to be built again. */
function placed(
	doc: BlueprintDoc,
	places: readonly ((draft: BlueprintDoc) => void)[],
): BlueprintDoc {
	const { refIndex: _derived, ...persisted } = doc;
	const next = structuredClone(persisted) as BlueprintDoc;
	for (const place of places) place(next);
	return next;
}

/** `doc` with `shape` in each slot it can hold it: every placement at once
 *  where the gate admits that, else each placement in turn that the gate
 *  admits beside those kept before it. */
function withShape(doc: BlueprintDoc, shape: Shape): BlueprintDoc {
	const admitted = (next: BlueprintDoc) =>
		runValidation(next, LOOKUP_CONTEXT_UNAVAILABLE).length === 0;
	const all = placements(doc, shape);
	const whole = placed(doc, all);
	if (admitted(whole)) return whole;
	const kept: ((draft: BlueprintDoc) => void)[] = [];
	for (const place of all)
		if (admitted(placed(doc, [...kept, place]))) kept.push(place);
	return placed(doc, kept);
}

export const temporalBranchDocArbitrary: fc.Arbitrary<BlueprintDoc> = fc
	.tuple(
		suiteDocArbitrary,
		fc.integer({ min: 0, max: TEMPORAL_BRANCH_SHAPES.length - 1 }),
	)
	.map(([doc, index]) =>
		withShape(doc, TEMPORAL_BRANCH_SHAPES[index] as Shape),
	);
