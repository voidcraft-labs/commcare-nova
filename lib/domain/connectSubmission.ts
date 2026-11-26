import type { BlueprintDoc, PersistableDoc } from "./blueprint";
import {
	type ConnectActivitySite,
	connectActivitySites,
} from "./connectActivitySites";
import { workerChecksConnectRecipient } from "./connectRecipientRule";
import { type FormStructure, formStructure } from "./expression/formStructure";
import type { Expression } from "./expression/types";
import type { Uuid } from "./uuid";

export interface ConnectSubmissionConflict {
	readonly reason:
		| "repeated-learning-module"
		| "repeated-assessment"
		| "duplicate-delivery"
		| "delivery-with-assigned-task";
	readonly first: ConnectActivitySite;
	readonly second: ConnectActivitySite;
}

function staticCount(doc: PersistableDoc, repeat: Uuid): number | undefined {
	const field = doc.fields[repeat];
	if (field?.kind !== "repeat" || field.repeat_mode !== "count_bound")
		return undefined;
	const count = field.repeat_count;
	if (count.kind !== "term" || count.term.kind !== "literal") return undefined;
	const value = count.term.value;
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: undefined;
}

interface AnswerCondition {
	field: Uuid;
	value: string;
	isEqual: boolean;
}

/** Only one scalar answer shared by all rows of this submission can prove
 * two placements exclusive. Equal-looking references inside different
 * repeats may have entirely different answers. */
function answerCondition(
	expr: Expression,
	structure: FormStructure,
): AnswerCondition | undefined {
	if (expr.kind === "not") {
		// On an empty node set, both XPath equality and inequality can be
		// false. Negated inequality therefore supplies no equal value.
		if (expr.clause.kind !== "eq") return undefined;
		const inner = answerCondition(expr.clause, structure);
		return inner && { ...inner, isEqual: !inner.isEqual };
	}
	if (expr.kind !== "eq" && expr.kind !== "neq") return undefined;
	const { left, right } = expr;
	if (left.kind !== "term" || right.kind !== "term") return undefined;
	const ref = left.term.kind === "field" ? left.term : right.term;
	const other = left.term.kind === "field" ? right.term : left.term;
	if (
		ref.kind !== "field" ||
		ref.filters !== undefined ||
		ref.role !== undefined
	)
		return undefined;
	const field = structure.fields.get(ref.uuid);
	if (field?.kind !== "text" && field?.kind !== "single_select")
		return undefined;
	for (
		let parent = structure.fields.get(field.parent);
		parent;
		parent = structure.fields.get(parent.parent)
	) {
		if (parent.kind === "repeat") return undefined;
	}
	const value =
		other.kind === "literal" && typeof other.value === "string"
			? other.value
			: other.kind === "choice" &&
					other.field === field.uuid &&
					other.options.length === 1 &&
					field.choices?.kind === "inline"
				? field.choices.options.find(
						(option) => option.uuid === other.options[0],
					)?.value
				: undefined;
	return value === undefined
		? undefined
		: { field: field.uuid, value, isEqual: expr.kind === "eq" };
}

function conditions(
	expr: Expression,
	structure: FormStructure,
): AnswerCondition[] {
	if (expr.kind === "and")
		return expr.clauses.flatMap((clause) => conditions(clause, structure));
	const atom = answerCondition(expr, structure);
	return atom === undefined ? [] : [atom];
}

function cannotCoincide(guards: readonly AnswerCondition[]): boolean {
	for (const [i, first] of guards.entries()) {
		for (const second of guards.slice(i + 1)) {
			if (first.field !== second.field) continue;
			if (
				first.value === second.value
					? first.isEqual !== second.isEqual
					: first.isEqual && second.isEqual
			)
				return true;
		}
	}
	return false;
}

/** Vellum emits an entity_id child even for a deliberately empty input.
 * Its blank value becomes the empty string at HQ's forwarder. */
function staticEntity(site: ConnectActivitySite): string | undefined {
	const activity = site.field.activity;
	if (activity.kind !== "delivery") return undefined;
	const source = activity.entityId;
	if (source === undefined) return "";
	if (
		source.kind === "term" &&
		source.term.kind === "literal" &&
		typeof source.term.value === "string"
	)
		return source.term.value;
	return undefined;
}

/** A repeated block reads one row's value. A second varying repeat would
 * restart those values and a filtered absolute path could select another row. */
function distinctDeliveryRows(
	doc: BlueprintDoc,
	site: ConnectActivitySite,
): boolean {
	const activity = site.field.activity;
	const read = activity.kind === "delivery" ? activity.entityId : undefined;
	// At a real answer the worker validates before recalculating a generated
	// entity_id. Comparing the entered values themselves is the witnessed
	// constraint; a rule over calculated entity_id nodes can see stale IDs.
	if (
		read?.kind === "term" &&
		read.term.kind === "field" &&
		read.term.spelling === "relative" &&
		read.term.role === undefined &&
		read.term.filters === undefined &&
		site.repeats.length === 1
	) {
		return workerChecksConnectRecipient(doc, site.repeats[0], read.term.uuid);
	}
	if (
		read?.kind !== "term" ||
		read.term.kind !== "repeat-row" ||
		read.term.filters !== undefined ||
		read.term.spelling !== "relative"
	)
		return false;
	const row = read.term;
	if (
		!site.repeats.includes(row.repeat) ||
		site.repeats.some(
			(uuid) => uuid !== row.repeat && (staticCount(doc, uuid) ?? 2) > 1,
		)
	)
		return false;
	const field = doc.fields[row.repeat];
	if (
		field?.kind !== "repeat" ||
		field.repeat_mode !== "query_bound" ||
		field.relevant !== undefined
	)
		return false;
	if (row.attribute === "index") return true;
	const query = field.data_source.ids_query;
	if (
		query.kind === "term" &&
		query.term.kind === "literal" &&
		typeof query.term.value === "string"
	) {
		// Restrict this proof to the spelling in which every native token
		// is exactly one nonempty ID, including after join and selected-at.
		const ids = query.term.value.split(" ");
		return ids.every((id) => id !== "") && ids.length === new Set(ids).size;
	}
	if (
		query.kind !== "project" ||
		query.of.kind !== "cases" ||
		query.of.source !== "casedb" ||
		query.value.kind !== "prop" ||
		query.value.property !== "case_id"
	)
		return false;
	// The private device case database has one row per ID. Vellum joins
	// those IDs with a space; a predicate excluding spaces keeps that
	// representation injective even for imported opaque IDs.
	return query.of.where.some((test) => {
		if (
			test.kind !== "not" ||
			test.clause.kind !== "call" ||
			test.clause.fn !== "contains" ||
			test.clause.args.length !== 2
		)
			return false;
		const [id, space] = test.clause.args;
		return (
			id?.kind === "term" &&
			id.term.kind === "prop" &&
			id.term.property === "case_id" &&
			space?.kind === "term" &&
			space.term.kind === "literal" &&
			space.term.value === " "
		);
	});
}

function collision(
	first: ConnectActivitySite,
	second: ConnectActivitySite,
): ConnectSubmissionConflict["reason"] | undefined {
	const a = first.field.activity.kind;
	const b = second.field.activity.kind;
	if (
		(a === "delivery" && b === "assigned-task") ||
		(b === "delivery" && a === "assigned-task")
	)
		return "delivery-with-assigned-task";
	if (a !== b) return undefined;
	if (a === "assessment") return "repeated-assessment";
	if (first.field.id !== second.field.id) return undefined;
	if (a === "learning-module") return "repeated-learning-module";
	if (a === "delivery") {
		const firstId = staticEntity(first);
		const secondId = staticEntity(second);
		if (firstId === undefined || secondId === undefined || firstId === secondId)
			return "duplicate-delivery";
	}
	return undefined;
}

/** Return the distinct pairs the receiver cannot safely process together.
 * A repeat can supply both members of a pair at a single authored site. */
export function connectSubmissionConflicts(
	doc: BlueprintDoc,
	formUuid: Uuid,
): ConnectSubmissionConflict[] {
	const sites = connectActivitySites(doc, formUuid);
	if (!sites.length) return [];
	const structure = formStructure(doc, formUuid);
	if (structure === undefined) return [];
	const reachable = sites.flatMap((site) => {
		const counts = site.repeats.map((uuid) => staticCount(doc, uuid));
		if (
			counts.includes(0) ||
			site.guards.some(
				(guard) =>
					guard.kind === "term" &&
					guard.term.kind === "literal" &&
					guard.term.value === false,
			)
		)
			return [];
		const guards = site.guards.flatMap((guard) => conditions(guard, structure));
		return cannotCoincide(guards)
			? []
			: [
					{
						site,
						guards,
						repeats: counts.some((count) => count === undefined || count > 1),
					},
				];
	});
	const conflicts: ConnectSubmissionConflict[] = [];
	for (const [i, first] of reachable.entries()) {
		for (const second of reachable.slice(first.repeats ? i : i + 1)) {
			if (first === second && distinctDeliveryRows(doc, first.site)) continue;
			const reason = collision(first.site, second.site);
			if (reason && !cannotCoincide([...first.guards, ...second.guards])) {
				conflicts.push({ reason, first: first.site, second: second.site });
			}
		}
	}
	return conflicts;
}
