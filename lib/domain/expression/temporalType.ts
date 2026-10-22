import type { TypingContext } from "./context";
/**
 * Context-free temporal result inference shared by AST consumers.
 *
 * This is deliberately narrower than the canonical type checker: it proves a
 * type only from a discriminator, explicit literal metadata, or branch
 * wrappers whose non-null results all agree. An optional term resolver supplies
 * contextual property/input types; without it those terms remain unresolved. `neutral` models a literal null: it
 * does not decide the result type of `coalesce`, `if`, or `switch`.
 */

import { effectiveCaseSearchConfig, type Module } from "../modules";
import { isCalendarCaseProperty } from "../standardCaseProperties";
import { type ResolvedType, scalarDataType, typeOf } from "./typeChecker";
import type { Expression, Term } from "./types";

export type TemporalType = "date" | "datetime";
export type StructuralTemporalType = TemporalType | "neutral";

export function asTemporalType(
	type: ResolvedType | undefined,
): TemporalType | undefined {
	return type === "date" || type === "datetime" ? type : undefined;
}

export function inferStructuralTemporalType(
	expression: Expression,
	resolveTerm?: (term: Term) => StructuralTemporalType | undefined,
): StructuralTemporalType | undefined {
	switch (expression.kind) {
		case "today":
		case "date-coerce":
			return "date";
		case "now":
		case "datetime-coerce":
			return "datetime";
		case "date-add":
			return inferStructuralTemporalType(expression.date, resolveTerm);
		case "term":
			if (expression.term.kind !== "literal")
				return resolveTerm?.(expression.term);
			if (expression.term.value === null) return "neutral";
			return asTemporalType(expression.term.data_type);
		case "if":
			return agreedTemporalType([
				inferStructuralTemporalType(expression.then, resolveTerm),
				inferStructuralTemporalType(expression.else, resolveTerm),
			]);
		case "switch":
			return agreedTemporalType([
				...expression.cases.map((entry) =>
					inferStructuralTemporalType(entry.then, resolveTerm),
				),
				inferStructuralTemporalType(expression.fallback, resolveTerm),
			]);
		case "coalesce":
			return agreedTemporalType(
				expression.values.map((value) =>
					inferStructuralTemporalType(value, resolveTerm),
				),
			);
		case "arith":
		case "concat":
		case "count":
		case "double":
		case "format-date":
		case "id-of":
		case "acting-user":
		case "unowned":
		case "table-lookup":
			return undefined;
		default: {
			return undefined;
		}
	}
}

function agreedTemporalType(
	types: readonly (StructuralTemporalType | undefined)[],
): StructuralTemporalType | undefined {
	if (types.length === 0 || types.some((type) => type === undefined)) {
		return undefined;
	}
	const concrete = types.filter(
		(type): type is TemporalType => type === "date" || type === "datetime",
	);
	if (concrete.length === 0) return "neutral";
	const first = concrete[0];
	return concrete.every((type) => type === first) ? first : undefined;
}

/**
 * What a case row stands for where an expression reads it. A row's stored
 * instants `opened_on` and `modified_on` reach an expression as `date_opened`
 * and `last_modified`, and each runtime holds them in its own class:
 *
 *   - `casedb`: a device evaluating over its casedb, where both are the
 *     worker's calendar date (Core's `DateData`).
 *   - `results`: a device evaluating over HQ's search results instance,
 *     where `date_opened` is HQ's UTC calendar date of `opened_on` and
 *     `last_modified` is HQ's datetime text.
 *   - `search`: HQ's search itself, which reads both as instants.
 */
export type CaseReading = "casedb" | "results" | "search";

/**
 * What a read's predicate stands for (`CaseReading`): the filter of a
 * browse list or a case operation evaluates over a device's casedb
 * (`casedb`); the composed query of an effective Search, and every surface
 * that reads the stored truth of the whole tenant, is HQ's search
 * (`search`).
 */
export interface CaseFilterReading {
	readonly filter: Extract<CaseReading, "casedb" | "search">;
}

/**
 * The two readings of one case-list read. A browse list's filter and its
 * columns both read a casedb row; an effective Search's filter is HQ's search
 * while its calculated columns and sort keys read the results instance the
 * device holds, so the two can differ within one read.
 */
export interface CaseQueryReading extends CaseFilterReading {
	readonly columns: Extract<CaseReading, "casedb" | "results">;
}

/** A browse list, a case operation, a device's view: casedb throughout. */
export const CASEDB_READING: CaseQueryReading = {
	filter: "casedb",
	columns: "casedb",
};

/**
 * An effective Search: HQ's query, then the results instance's rows. Every
 * surface that reads the whole tenant's stored truth (the case workspace,
 * sample data, the rename preflight, internal fixed filters) reads its
 * filter the same way.
 */
export const SEARCH_READING: CaseQueryReading = {
	filter: "search",
	columns: "results",
};

/**
 * What a module's case-list read stands for. A module with an effective
 * Search is HQ's search followed by the results instance the device holds
 * (the decision `lib/commcare/suite/case-search/xpathQuery.ts` makes for the
 * wire through the same projection); any other module is a browse list over
 * the worker's casedb.
 */
export function caseQueryReadingFor(
	module: Pick<Module, "caseListConfig" | "caseSearchConfig">,
): CaseQueryReading {
	return effectiveCaseSearchConfig(module) === undefined
		? CASEDB_READING
		: SEARCH_READING;
}

/** The temporal class a reading holds a standard metadata property in;
 *  `undefined` for a property the reading does not hold as a value of its
 *  own (every authored property, and `closed_on` outside `search`). */
export function readingCaseMetadataType(
	property: string,
	reading: CaseReading,
): TemporalType | undefined {
	if (!isCalendarCaseProperty(property))
		return reading === "search" && property === "closed_on"
			? "datetime"
			: undefined;
	if (reading === "casedb") return "date";
	if (reading === "results")
		return property === "date_opened" ? "date" : "datetime";
	return "datetime";
}

/** The temporal result of a case-list value under a reading. Keep authored
 * admission types when validating the expression; only infer the resulting
 * value shape through its value branches, with the reading's classes for the
 * standard metadata properties. A datetime comparison in an if-condition must
 * not invalidate an otherwise admitted date-valued result. Mixed
 * date/datetime branches keep their authored datetime result type. */
export function resolveCaseListTemporalType(
	expression: Expression,
	context: TypingContext,
	reading: CaseReading,
): TemporalType | undefined {
	const authored = scalarDataType(typeOf(expression, context)?.data);
	const portable = inferStructuralTemporalType(expression, (term) => {
		if (term.kind === "prop" || term.kind === "form-case") {
			const metadata = readingCaseMetadataType(term.property, reading);
			if (metadata !== undefined) return metadata;
		}
		return asTemporalType(
			scalarDataType(typeOf({ kind: "term", term }, context)?.data),
		);
	});
	return portable === "date" || portable === "datetime"
		? portable
		: asTemporalType(authored);
}
