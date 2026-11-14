/**
 * A search's `_xpath_query` rows as one conjunction. HQ joins every row's
 * CSQL with `and` (`case_search/utils.py::_apply_filter`), and Nova writes
 * one row per top-level conjunct of each of its sources: the case list
 * filter, each advanced Search field's condition, and each simple field's
 * derived match (`composeXPathQueryClauses`). The search reader proposes the
 * sources and asks here which rows Nova's own emission writes back, as
 * trees, and reads a row it must place on its own as its conjuncts.
 */
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import type { ExpressionContext } from "@/lib/domain/expression/context";
import type { Expression } from "@/lib/domain/expression/types";
import { effectiveCaseSearchConfig } from "@/lib/domain/modules";
import type { Uuid } from "@/lib/domain/uuid";
import type { LookupTableDefinition } from "@/lib/lookup/types";
import type { EmissionRewriteId } from "../../emissionRewrites";
import { moduleExpressionContexts } from "../../expressionContext";
import { caseListStepDatumId } from "../../formLinkProjection";
import { lookupWireNaming } from "../../lookup/naming";
import { searchWireShape } from "../../suite/case-search/searchWireShape";
import { searchInputInstanceId } from "../../suite/case-search/types";
import {
	composeXPathQueryClauses,
	composeXPathQueryEmission,
	type XPathQueryClause,
	xpathQueryRequestValues,
} from "../../suite/case-search/xpathQuery";
import { type FormSyntax, readFormSyntax } from "../../xpath/formSyntax";
import { serializeWire } from "../../xpath/wire/serialize";
import type { WireExpr } from "../../xpath/wire/tree";
import { sameSyntax } from "../syntaxCompare";
import {
	readSearchFilterRow,
	type SearchRowEnv,
	type SearchRowReading,
	searchRowLevel,
} from "./csqlRead";

function parsed(text: string): FormSyntax | undefined {
	try {
		const read = readFormSyntax(text);
		return read.ok ? read.node : undefined;
	} catch {
		return undefined;
	}
}

/** What Nova's emission of a module's search writes as `_xpath_query`: each value, and the clause
 *  each comes from. Undefined for a module with no case list. */
function moduleRows(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	lookup: SearchRowEnv["lookup"],
):
	| {
			readonly clauses: readonly XPathQueryClause[];
			readonly values: readonly WireExpr[];
	  }
	| undefined {
	const mod = doc.modules[moduleUuid];
	const config = mod?.caseListConfig;
	if (mod === undefined || config === undefined) return undefined;
	const naming = lookupWireNaming([
		...lookup.values(),
	] as unknown as readonly LookupTableDefinition[]);
	const contexts = moduleExpressionContexts(doc, moduleUuid, naming);
	const search = effectiveCaseSearchConfig(mod);
	const wire = search === undefined ? undefined : searchWireShape(search);
	const clauses =
		composeXPathQueryClauses(config, mod.caseType, contexts) ?? [];
	const emission = composeXPathQueryEmission(
		config,
		mod.caseType,
		contexts,
		naming,
		wire === undefined ? undefined : searchInputInstanceId(wire),
		caseListStepDatumId(doc, moduleUuid, "id"),
	);
	return { clauses, values: xpathQueryRequestValues(config, emission) };
}

/** The conjuncts Nova's emission of a module's search writes as `_xpath_query` rows, in order:
 *  two documents with equal lists print the same rows. */
export function emittedSearchConjuncts(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): readonly Expression[] {
	const mod = doc.modules[moduleUuid];
	const config = mod?.caseListConfig;
	if (mod === undefined || config === undefined) return [];
	const contexts = moduleExpressionContexts(doc, moduleUuid);
	return (composeXPathQueryClauses(config, mod.caseType, contexts) ?? []).map(
		(clause) => clause.expression,
	);
}

/** The proposed case list's own rows against the source's, as trees: each emitted row takes the
 *  first unmatched source row after the last one matched, then any earlier one, so `matched` says
 *  in what order the source holds them. */
export function matchSearchRows(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	sourceRows: readonly string[],
	env: SearchRowEnv,
): {
	/** Source row indexes Nova's emission of this module reproduces, exact or up to guards, each
	 *  with the source of the emitted row: the list filter, a field's condition, a derived match. */
	readonly matched: readonly {
		readonly source: number;
		readonly level: "exact" | "guards";
		readonly from: "filter" | "field" | "derived";
	}[];
	/** Source rows no emitted row equals. */
	readonly unmatched: readonly number[];
	/** Emitted rows no source row equals. */
	readonly extra: readonly number[];
} {
	const rows = moduleRows(doc, moduleUuid, env.lookup);
	if (rows === undefined)
		return {
			matched: [],
			unmatched: sourceRows.map((_, index) => index),
			extra: [],
		};
	const { clauses, values } = rows;
	const sources = sourceRows.map(parsed);
	const matched: {
		source: number;
		level: "exact" | "guards";
		from: "filter" | "field" | "derived";
	}[] = [];
	const extra: number[] = [];
	const taken = new Set<number>();
	let next = 0;
	values.forEach((value, emitted) => {
		const print = parsed(
			serializeWire(value, { target: "hq-json", interpolation: "none" }).text,
		);
		const clause = clauses[emitted];
		const levelAt = (index: number): "exact" | "guards" | undefined => {
			const source = sources[index];
			if (source === undefined) return undefined;
			if (print !== undefined && sameSyntax(source, print)) return "exact";
			return clause === undefined
				? undefined
				: searchRowLevel(source, clause.expression, clause.context, env);
		};
		// The source row after the last one matched first, then any row not yet
		// matched: rows in another order are the same rows, and the caller reads
		// the order from `matched`.
		const indexes = sourceRows.map((_, index) => index);
		const order = [
			...indexes.filter((index) => index >= next),
			...indexes.filter((index) => index < next),
		];
		for (const index of order) {
			if (taken.has(index)) continue;
			const level = levelAt(index);
			if (level === undefined) continue;
			matched.push({
				source: index,
				level,
				from: clause?.source ?? "derived",
			});
			taken.add(index);
			next = index + 1;
			return;
		}
		extra.push(emitted);
	});
	return {
		matched,
		unmatched: sourceRows.flatMap((_, index) =>
			taken.has(index) ? [] : [index],
		),
		extra,
	};
}

/** A row read on its own, for the search reader to place: its top-level conjuncts, each a predicate. */
export function readSearchRowConjuncts(
	text: string,
	context: ExpressionContext,
	env: SearchRowEnv,
):
	| {
			readonly ok: true;
			readonly conjuncts: readonly Expression[];
			readonly rewrites: readonly EmissionRewriteId[];
	  }
	| Extract<SearchRowReading, { ok: false }> {
	const reading = readSearchFilterRow(text, context, env);
	if (!reading.ok) return reading;
	return {
		ok: true,
		conjuncts:
			reading.predicate.kind === "and"
				? reading.predicate.clauses
				: [reading.predicate],
		rewrites: reading.rewrites,
	};
}
