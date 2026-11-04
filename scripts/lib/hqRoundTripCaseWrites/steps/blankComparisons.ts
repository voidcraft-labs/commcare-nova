/**
 * Step `blank-comparisons` (part 09 §7.12): a comparison of a question's
 * answer with the blank text `''` becomes a blank test where the head types
 * that answer as something text can't be compared with.
 *
 * At `main` a Hidden Value that no field's own Saves to wrote was untyped,
 * so `#form/x = ''` and `#form/x != ''` type-checked over it. The head types
 * a Hidden Value by the operations that save it (part 01, decision 32), so
 * one saved to a number, date, time or location property is that type, and
 * the checker refuses its comparison with text. `eq(x, '')` becomes
 * `is-blank(x)` and `neq(x, '')` becomes `not(is-blank(x))`, in either
 * operand order, wherever the checker refuses the comparison: in any
 * expression slot of any question, form and menu, and in practice the slots
 * of case operations, which compare as Nova's case store does.
 *
 * On a device both spellings ask the same question of every value the answer
 * can hold except a yes/no. Core reads the node through
 * `XPathPathExpr.java::unpackValue`: blank or not relevant reads `""`, a
 * number a `Double`, a date or a date and time a `Date`, a choice, a time,
 * a location and text a `String`, and a `BooleanData` a `Boolean`.
 * `XPathEqExpr.java::testEquality` then compares a `Double` with `''` as
 * numbers, and `FunctionUtils.java::toNumeric` reads `''` as `NaN`, so no
 * number equals it; a `Date` or a `String` is compared as text
 * (`FunctionUtils.java::toString`), which is `""` only for the blank read.
 * `is-blank` prints `string-length(string(x)) = 0`
 * (`lib/commcare/xpath/wire/fromExpression.ts`), true exactly for that blank
 * read too, since `toString` of a `Double` or a `Date` is never empty. A
 * `Boolean` is different: `testEquality` reads `''` as `false`, so a false
 * answer equals `''` while its text is `"false"`. The rewrite therefore asks
 * that the answer never holds one: a visible question's answer class is its
 * kind's, a starting value is cast through its bind's class
 * (`SetValueAction.java::processAction`), and a calculation is stored by
 * `Recalculate.java::wrapData`, which makes a `BooleanData` only of a
 * `Boolean` result under Nova's text and date-and-time binds. So a Hidden
 * Value's calculation qualifies where every result it can end with types as
 * a value that is not yes/no, or reads a question that qualifies in turn.
 * Anything else stays as it is, and the gate refuses it at `judge-target`
 * for its author.
 *
 * The step rewrites the registered expression slots in place
 * (`lib/domain/referenceSlots.ts::rewriteExpressionSlotValues`, the
 * registry's migration writer), since one rewrite reaches every slot kind
 * and no one mutation addresses an expression by its slot. The same
 * condition runs, so no notice: the change is the report's alone.
 */

import { lookupTypeIndex } from "@/lib/commcare/validator/lookupTypeContext";
import { descendantFieldUuids } from "@/lib/doc/fieldWalk";
import {
	type BlueprintDoc,
	type ExpressionCarrierRef,
	expressionSlotValue,
	expressionSlotValues,
	rewriteExpressionSlotValues,
	type Uuid,
} from "@/lib/domain";
import {
	type LookupTypeIndex,
	slotContext,
} from "@/lib/domain/expression/context";
import { ANY_TYPE, typesCompatible } from "@/lib/domain/expression/ruleSets";
import {
	checkExpression,
	expressionContextAtPath,
	scalarDataType,
	typeOf,
	visitAssignmentOutputs,
} from "@/lib/domain/expression/typeChecker";
import type {
	CheckPath,
	ComparisonKind,
	Expression,
	ExpressionSlotRef,
} from "@/lib/domain/expression/types";
import { walkExpression } from "@/lib/domain/expression/walk";
import type { PlannedChange, StepContext } from "../types";
import { formsInMenuOrder, type StepResult } from "./apply";

const STEP = "blank-comparisons";

/** The change kind this step plans, as the report's `steps` line counts it. */
export const BLANK_COMPARISONS_CHANGE = "blank-test-written";

/** A comparison with `''` this step rewrites: its node and its question's
 *  side. */
interface Site {
	/** An `eq` or `neq` node. */
	readonly node: Extract<Expression, { kind: ComparisonKind }>;
	readonly side: "left" | "right";
}

/** A bare read of one question's answer, as an operand: its uuid. */
function bareAnswer(expression: Expression): Uuid | undefined {
	if (expression.kind !== "term" || expression.term.kind !== "field")
		return undefined;
	const term = expression.term;
	if (term.role !== undefined || term.filters !== undefined) return undefined;
	return term.uuid;
}

function isBlankText(expression: Expression): boolean {
	return (
		expression.kind === "term" &&
		expression.term.kind === "literal" &&
		expression.term.value === "" &&
		expression.term.data_type === undefined
	);
}

/** What the step reads once per document. */
interface Reading {
	readonly doc: BlueprintDoc;
	readonly lookups: LookupTypeIndex;
	/** Whether a question's answer never unpacks to a `Boolean`, by uuid. */
	readonly neverYesNo: Map<Uuid, boolean>;
}

/**
 * Whether question `uuid`'s answer never holds a `BooleanData`: a visible
 * question always; a Hidden Value without a calculation (a starting value is
 * cast through its bind's class); a calculation whose every result types as
 * a value that is not yes/no, a read of another qualifying question standing
 * for that question. A cycle qualifies nothing.
 */
function neverYesNo(
	reading: Reading,
	uuid: Uuid,
	visiting: ReadonlySet<Uuid> = new Set(),
): boolean {
	const known = reading.neverYesNo.get(uuid);
	if (known !== undefined) return known;
	const field = reading.doc.fields[uuid];
	if (field === undefined || visiting.has(uuid)) return false;
	if (field.kind !== "hidden" || field.calculate === undefined) {
		reading.neverYesNo.set(uuid, true);
		return true;
	}
	const calculate = field.calculate;
	const ctx = slotContext(
		reading.doc,
		{ entity: "field", uuid, slot: "calculate" },
		reading.lookups,
	);
	let every = ctx !== undefined;
	if (ctx !== undefined) {
		const inside = new Set([...visiting, uuid]);
		visitAssignmentOutputs(calculate, [], (output, path) => {
			if (!every) return;
			const read = bareAnswer(output);
			if (read !== undefined) {
				every = neverYesNo(reading, read, inside);
				return;
			}
			const data = scalarDataType(
				typeOf(output, expressionContextAtPath(calculate, ctx, path))?.data,
			);
			every = data !== undefined && data !== ANY_TYPE && data !== "boolean";
		});
	}
	reading.neverYesNo.set(uuid, every);
	return every;
}

/** The comparisons with `''` in one slot's expression this step rewrites:
 *  each one the checker refuses as incomparable there. */
function sitesIn(
	reading: Reading,
	ref: ExpressionSlotRef,
	expression: Expression,
): readonly Site[] {
	const candidates: {
		node: Site["node"];
		side: Site["side"];
		path: CheckPath;
	}[] = [];
	walkExpression(expression, {
		visitExpression(node, path) {
			if (node.kind !== "eq" && node.kind !== "neq") return;
			const side = isBlankText(node.right)
				? "left"
				: isBlankText(node.left)
					? "right"
					: undefined;
			if (side === undefined || bareAnswer(node[side]) === undefined) return;
			candidates.push({ node, side, path });
		},
	});
	if (candidates.length === 0) return [];
	const ctx = slotContext(reading.doc, ref, reading.lookups);
	if (ctx === undefined) return [];
	const refused = new Set(
		checkExpression(expression, ctx)
			.errors.filter((error) => error.code === "incompatible-values")
			.map((error) => JSON.stringify(error.path)),
	);
	const sites: Site[] = [];
	for (const { node, side, path } of candidates) {
		if (!refused.has(JSON.stringify(path))) continue;
		const type = typeOf(
			node[side],
			expressionContextAtPath(expression, ctx, [...path, side]),
		);
		const data = type?.data;
		// One answer, of a type text can't be compared with.
		if (typeof data === "object" && data.cardinality !== "one") continue;
		const scalar = scalarDataType(data);
		if (
			scalar === undefined ||
			scalar === ANY_TYPE ||
			scalar === "boolean" ||
			typesCompatible(scalar, "text")
		)
			continue;
		const uuid = bareAnswer(node[side]);
		if (uuid === undefined || !neverYesNo(reading, uuid)) continue;
		sites.push({ node, side });
	}
	return sites;
}

/** `expression` with each site's comparison written as a blank test; the
 *  same reference where it holds none. */
function rewritten(
	value: unknown,
	sites: ReadonlyMap<Expression, Site>,
): unknown {
	if (Array.isArray(value)) {
		const next = value.map((item) => rewritten(item, sites));
		return next.every((item, index) => item === value[index]) ? value : next;
	}
	if (value === null || typeof value !== "object") return value;
	const site = sites.get(value as Expression);
	if (site !== undefined) {
		const blank: Expression = { kind: "is-blank", left: site.node[site.side] };
		return site.node.kind === "eq" ? blank : { kind: "not", clause: blank };
	}
	let changed = false;
	const next: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		next[key] = rewritten(item, sites);
		if (next[key] !== item) changed = true;
	}
	return changed ? next : value;
}

/** Every expression carrier of the document, menu by menu: each form's
 *  questions, the form, then the menu. */
function carriers(doc: BlueprintDoc): readonly ExpressionCarrierRef[] {
	const owners: ExpressionCarrierRef[] = [];
	const forms = new Set(formsInMenuOrder(doc));
	for (const moduleUuid of doc.moduleOrder) {
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			if (!forms.has(formUuid)) continue;
			for (const uuid of descendantFieldUuids(doc, formUuid))
				owners.push({ entity: "field", uuid });
			owners.push({ entity: "form", uuid: formUuid });
		}
		if (doc.modules[moduleUuid] !== undefined)
			owners.push({ entity: "module", uuid: moduleUuid });
	}
	return owners;
}

/** Step `blank-comparisons` over the document the earlier steps left. */
export function blankComparisonsStep(
	doc: BlueprintDoc,
	ctx: Pick<StepContext, "lookupContext">,
): StepResult {
	const reading: Reading = {
		doc,
		lookups: lookupTypeIndex(ctx.lookupContext),
		neverYesNo: new Map(),
	};
	const fields = { ...doc.fields };
	const forms = { ...doc.forms };
	const modules = { ...doc.modules };
	const changes: PlannedChange[] = [];
	for (const owner of carriers(doc)) {
		const sites = new Map<Expression, Site>();
		for (const { ref, expression } of expressionSlotValues(doc, owner))
			for (const site of sitesIn(reading, ref, expression))
				sites.set(site.node, site);
		if (sites.size === 0) continue;
		// The owner is copied before the registry writes into it, and each
		// slot's new value is built from the document's own expression, where
		// the sites are.
		if (owner.entity === "field")
			fields[owner.uuid] = structuredClone(doc.fields[owner.uuid]);
		else if (owner.entity === "form")
			forms[owner.uuid] = structuredClone(doc.forms[owner.uuid]);
		else modules[owner.uuid] = structuredClone(doc.modules[owner.uuid]);
		rewriteExpressionSlotValues(
			{ fields, forms, modules },
			owner,
			(value, ref) => {
				const original = expressionSlotValue(doc, ref);
				if (original === undefined) return value;
				const next = rewritten(original, sites);
				return next === original ? value : next;
			},
		);
		changes.push({
			step: STEP,
			kind: BLANK_COMPARISONS_CHANGE,
			entityUuid: owner.uuid,
			detail: { comparisons: sites.size },
		});
	}
	if (changes.length === 0) return { doc, changes, notice: [], blockers: [] };
	const { refIndex: _refIndex, ...rest } = doc;
	return {
		doc: { ...rest, fields, forms, modules } as BlueprintDoc,
		changes,
		notice: [],
		blockers: [],
	};
}
