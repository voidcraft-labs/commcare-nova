/** The cases a repeat can capture at its opening event. A form answer being
 * read is ordinary input. A limitation needs an effect we can establish:
 * the query requires an ID the worker has not given, an earlier answer
 * hides the only count assignment, or a later row can be made while an
 * already-created row is hidden. */
import type { QueryRepeatNeed } from "../queryRepeatPlacement";
import type { Uuid } from "../uuid";
import { selectAnswerTokens } from "./choiceValue";
import type { FormStructure } from "./formStructure";
import type { Expression } from "./types";

type OpeningOrder = (field: Uuid) => boolean;

interface OpeningPosition {
	readonly scope: Uuid;
	readonly position: number;
}

const openingPositions = new WeakMap<
	FormStructure,
	ReadonlyMap<Uuid, OpeningPosition>
>();

/** Roots run at form ready. Children of a repeat run at that row's own
 * insertion. A worker can have answered another page by then. */
function positions(form: FormStructure): ReadonlyMap<Uuid, OpeningPosition> {
	const cached = openingPositions.get(form);
	if (cached !== undefined) return cached;
	const result = new Map<Uuid, OpeningPosition>();
	const add = (parent: Uuid, scope: Uuid): void => {
		for (const uuid of form.fieldOrder.get(parent) ?? []) {
			if (result.has(uuid)) continue;
			result.set(uuid, { scope, position: result.size });
			add(uuid, form.fields.get(uuid)?.kind === "repeat" ? uuid : scope);
		}
	};
	add(form.formUuid, form.formUuid);
	openingPositions.set(form, result);
	return result;
}

function directField(value: Expression): Uuid | undefined {
	return value.kind === "term" &&
		value.term.kind === "field" &&
		value.term.filters === undefined &&
		value.term.role === undefined
		? value.term.uuid
		: undefined;
}

function literal(value: Expression | undefined): string | number | undefined {
	if (value?.kind !== "term" || value.term.kind !== "literal") return undefined;
	return typeof value.term.value === "string" ||
		typeof value.term.value === "number"
		? value.term.value
		: undefined;
}

function caseId(value: Expression): boolean {
	return (
		value.kind === "term" &&
		value.term.kind === "prop" &&
		value.term.property === "case_id" &&
		value.term.via === undefined
	);
}

/** A case ID is never empty. A comparison with an empty text property
 * has no such guarantee, and a fallback or a disjunction can still
 * return cases when a referenced field is empty. */
function requiresMissingId(
	value: Expression,
	blank: (uuid: Uuid) => boolean,
): boolean {
	const field = directField(value);
	if (field !== undefined) return blank(field);
	if (value.kind === "call" && value.fn === "string" && value.args.length === 1)
		return requiresMissingId(value.args[0], blank);
	if (value.kind !== "project" || value.of.kind !== "cases") return false;
	return value.of.where.some((predicate) => {
		if (predicate.kind !== "eq") return false;
		const key = caseId(predicate.left)
			? directField(predicate.right)
			: caseId(predicate.right)
				? directField(predicate.left)
				: undefined;
		return key !== undefined && blank(key);
	});
}

/** Whether an earlier assignment certainly made the condition false.
 * Unknown values, including a worker's data, are evaluated at entry. */
function suppressedAtCapture(
	form: FormStructure,
	group: Uuid,
	earlier: OpeningOrder,
): boolean {
	const condition = form.expressionAt({
		entity: "field",
		uuid: group,
		slot: "relevant",
	});
	if (
		condition === undefined ||
		!("left" in condition) ||
		!("right" in condition)
	)
		return false;
	const field = directField(condition.left);
	if (field === undefined || !earlier(field)) return false;
	const kind = form.fields.get(field)?.kind;
	// Only compare a literal whose stored value survives the target question's
	// cast. A date, a chosen value, an attachment or an incoming case value
	// needs the actual reader and the entry's data.
	if (
		kind !== "text" &&
		kind !== "secret" &&
		kind !== "int" &&
		kind !== "decimal"
	)
		return false;
	const seed = literal(
		form.expressionAt({ entity: "field", uuid: field, slot: "default_value" }),
	);
	const test = literal(condition.right);
	if (seed === undefined || test === undefined || typeof seed !== typeof test)
		return false;
	if (kind === "text" || kind === "secret") {
		if (typeof seed !== "string") return false;
	} else if (
		typeof seed !== "number" ||
		!Number.isFinite(seed) ||
		(kind === "int" &&
			(!Number.isInteger(seed) || seed < -2147483648 || seed > 2147483647))
	) {
		return false;
	}
	switch (condition.kind) {
		case "eq":
			return seed !== test;
		case "neq":
			return seed === test;
		case "lt":
			return (
				typeof seed === "number" && typeof test === "number" && seed >= test
			);
		case "lte":
			return (
				typeof seed === "number" && typeof test === "number" && seed > test
			);
		case "gt":
			return (
				typeof seed === "number" && typeof test === "number" && seed <= test
			);
		case "gte":
			return (
				typeof seed === "number" && typeof test === "number" && seed < test
			);
		default:
			return false;
	}
}

function isFirstRow(condition: Expression): boolean {
	if (condition.kind !== "eq") return false;
	const isPosition = (value: Expression) =>
		value.kind === "call" && value.fn === "position" && value.args.length === 0;
	return (
		(isPosition(condition.left) && literal(condition.right) === 0) ||
		(isPosition(condition.right) && literal(condition.left) === 0)
	);
}

/** The directly editable text answer whose equality can show this branch.
 * Keep the proof to independent, ordinary controls the worker can reach
 * before the query repeat. */
function earlierTextAnswer(
	form: FormStructure,
	condition: Expression,
	earlier: OpeningOrder,
): Uuid | undefined {
	if (condition.kind !== "eq") return undefined;
	const first = literal(condition.left);
	const last = literal(condition.right);
	const editableValue = (value: string | number | undefined) =>
		typeof value === "string" && /^[A-Za-z0-9]+$/.test(value);
	const uuid = editableValue(last)
		? directField(condition.left)
		: editableValue(first)
			? directField(condition.right)
			: undefined;
	if (uuid === undefined || !earlier(uuid)) return undefined;
	const field = form.fields.get(uuid);
	return field?.kind === "text" &&
		field.parent === form.formUuid &&
		field.textInput?.keypad === undefined &&
		field.textInput?.addressLookup === undefined &&
		form.expressionAt({ entity: "field", uuid, slot: "relevant" }) ===
			undefined &&
		form.expressionAt({ entity: "field", uuid, slot: "validate" }) === undefined
		? uuid
		: undefined;
}

function hidesAnEarlierRow(
	form: FormStructure,
	uuid: Uuid,
	ids: string | number | undefined,
	earlier: OpeningOrder,
): boolean {
	if (typeof ids === "string" && selectAnswerTokens(ids).length <= 1)
		return false;
	const condition = form.expressionAt({
		entity: "field",
		uuid,
		slot: "relevant",
	});
	if (condition?.kind !== "if" || !isFirstRow(condition.cond)) return false;
	const first = earlierTextAnswer(form, condition.then, earlier);
	const later = earlierTextAnswer(form, condition.else, earlier);
	// Core counts only relevant rows when assigning a newly inserted row's
	// model index. With independent answers for the first row and later rows,
	// the worker can reach the first row, hide it, then make another row.
	return first !== undefined && later !== undefined && first !== later;
}

export function openingRepeatLimitation(
	form: FormStructure,
	uuid: Uuid,
	needs: readonly QueryRepeatNeed[],
	sourceSetsAfterCapture?: (field: Uuid) => boolean | undefined,
): QueryRepeatNeed | undefined {
	const query = form.expressionAt({ entity: "field", uuid, slot: "ids_query" });
	const ids = literal(query);
	const empty = typeof ids === "string" && selectAnswerTokens(ids).length === 0;
	// The absolute inner index can select a different wrapper only when a
	// second outer row can exist. All repeat ancestors count, not just the
	// nearest one. An empty fixed query makes no inner row to misaddress.
	if (!empty && needs.some((need) => need.kind === "nested")) {
		const visited = new Set<Uuid>();
		let parent = form.fields.get(uuid)?.parent;
		while (parent !== undefined && !visited.has(parent)) {
			visited.add(parent);
			const outer = form.fields.get(parent);
			if (outer?.kind === "repeat") {
				const count =
					outer.repeatMode === "count_bound"
						? literal(
								form.expressionAt({
									entity: "field",
									uuid: parent,
									slot: "repeat_count",
								}),
							)
						: undefined;
				const members =
					outer.repeatMode === "query_bound"
						? literal(
								form.expressionAt({
									entity: "field",
									uuid: parent,
									slot: "ids_query",
								}),
							)
						: undefined;
				const atMostOne =
					count === 0 ||
					count === 1 ||
					(typeof members === "string" &&
						selectAnswerTokens(members).length <= 1);
				if (!atMostOne) return { kind: "nested", repeatUuid: parent };
			}
			parent = outer?.parent;
		}
	}
	if (empty) return undefined;
	const order = positions(form);
	const capture = order.get(uuid);
	if (capture === undefined) return undefined;
	const sameEvent = (field: Uuid) => order.get(field)?.scope === capture.scope;
	const earlier = (field: Uuid) => {
		if (!sameEvent(field)) return false;
		const after = sourceSetsAfterCapture?.(field);
		return after === undefined
			? (order.get(field)?.position ?? Infinity) < capture.position
			: !after;
	};
	const blank = (field: Uuid): boolean => {
		if (!sameEvent(field)) return false;
		const kind = form.fields.get(field)?.kind;
		if (
			kind === undefined ||
			kind === "section" ||
			kind === "group" ||
			kind === "repeat"
		)
			return false;
		const seed = form.expressionAt({
			entity: "field",
			uuid: field,
			slot: "default_value",
		});
		if (
			form.expressionAt({ entity: "field", uuid: field, slot: "calculate" }) !==
			undefined
		) {
			if (seed !== undefined && earlier(field)) return false;
			// A bind calculation runs after ready unless an earlier action
			// triggered it. Without an earlier write every such value is blank.
			// At insert the outer row itself can supply a value.
			if (capture.scope !== form.formUuid) return false;
			for (const other of order.keys()) {
				if (!earlier(other)) continue;
				if (
					form.expressionAt({
						entity: "field",
						uuid: other,
						slot: "default_value",
					}) !== undefined ||
					form.fields.get(other)?.repeatMode === "query_bound"
				)
					return false;
			}
			return true;
		}
		return seed === undefined || !earlier(field);
	};
	if (query !== undefined && requiresMissingId(query, blank))
		return { kind: "query-reads-answers" };
	const hiddenAtCapture = needs.find(
		(need) =>
			need.kind === "ancestor-condition-changes" &&
			suppressedAtCapture(form, need.groupUuid, earlier),
	);
	if (hiddenAtCapture !== undefined) return hiddenAtCapture;
	// This is screen order, not the order of the form's opening assignments.
	const earlierQuestion = (field: Uuid) =>
		sameEvent(field) &&
		(order.get(field)?.position ?? Infinity) < capture.position;
	return hidesAnEarlierRow(form, uuid, ids, earlierQuestion)
		? { kind: "row-condition" }
		: undefined;
}
