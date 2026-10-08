import type { EditorLookupTableDecl } from "@/components/builder/shared/lookupTablePresentation";
import {
	asUuid,
	type CaseOptionsSource,
	type CaseType,
	DEFAULT_SELECT_OPTIONS,
	type InlineOptionsSource,
	type LookupColumnId,
	type LookupOptionsSource,
	type LookupTableId,
	type SelectOptionsSource,
} from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";
export interface LookupSourceDraft {
	readonly kind: "lookup";
	readonly tableId: LookupTableId;
	readonly valueColumnId?: LookupColumnId;
	readonly labelColumnId?: LookupColumnId;
	readonly filter?: Predicate;
}

export type SourceDraft =
	| InlineOptionsSource
	| LookupSourceDraft
	| CaseOptionsSource;

export function freshInlineSource(): InlineOptionsSource {
	return {
		kind: "inline",
		options: DEFAULT_SELECT_OPTIONS.map((option) => ({
			...option,
			uuid: asUuid(crypto.randomUUID()),
		})),
	};
}

export function withoutFilter(
	source: LookupSourceDraft | LookupOptionsSource,
): Omit<typeof source, "filter"> {
	const { filter: _filter, ...identity } = source;
	return identity;
}

/** A mode gesture either abandons the staged replacement, stages one new complete arm, or names the missing table. */
export function beginOptionsSource(
	source: SelectOptionsSource,
	next: string | null,
	tables: readonly EditorLookupTableDecl[],
	caseTypes: readonly CaseType[] = [],
) {
	if (next === null) return { kind: "unchanged" as const };
	if (next === "cases") {
		const type = caseTypes[0];
		if (!type)
			return {
				kind: "refused" as const,
				reason:
					"This app needs a record type before it can offer case choices.",
			};
		return {
			kind: "draft" as const,
			draft: source.kind === "cases" ? null : freshCaseSource(type.name),
		};
	}
	if (next === "inline")
		return {
			kind: "draft" as const,
			draft: source.kind === "inline" ? null : freshInlineSource(),
		};
	const table = tables.find((candidate) => candidate.id === next);
	if (!table)
		return {
			kind: "refused" as const,
			reason:
				"That Project data table is no longer available. Choose another table.",
		};
	return {
		kind: "draft" as const,
		draft:
			source.kind === "lookup" && source.tableId === table.id
				? null
				: { kind: "lookup" as const, tableId: table.id },
	};
}
export function completeLookupSource(
	draft: SourceDraft | null,
	table: EditorLookupTableDecl | undefined,
): LookupOptionsSource | undefined {
	if (
		draft?.kind !== "lookup" ||
		table === undefined ||
		table.id !== draft.tableId ||
		draft.valueColumnId === undefined ||
		draft.labelColumnId === undefined ||
		!table.columns.some((column) => column.id === draft.valueColumnId) ||
		!table.columns.some((column) => column.id === draft.labelColumnId)
	)
		return undefined;
	return {
		kind: "lookup",
		tableId: draft.tableId,
		valueColumnId: draft.valueColumnId,
		labelColumnId: draft.labelColumnId,
		...(draft.filter === undefined ? {} : { filter: draft.filter }),
	};
}

export function freshCaseSource(caseType: string): CaseOptionsSource {
	return {
		kind: "cases",
		caseType,
		labelProperty: "case_name",
		filter: {
			kind: "eq",
			left: {
				kind: "term",
				term: { kind: "prop", caseType, property: "status" },
			},
			right: { kind: "term", term: { kind: "literal", value: "open" } },
		},
	};
}
