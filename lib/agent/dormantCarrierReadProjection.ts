/**
 * Carrier-blind projections for the shared SA/MCP read tools.
 *
 * S05a lets canonical documents preserve lookup-backed select sources and
 * lookup AST nodes before those concepts become authorable by the SA/MCP
 * surfaces in S10. Read tools therefore need a one-way projection:
 *
 * - remove a select field's optional `optionsSource`, keeping its inline
 *   fallback options and every other field slot;
 * - remove an optional Predicate / ValueExpression slot when any descendant
 *   is a dormant lookup node;
 * - remove the smallest optional list entry whose required AST slot is
 *   lookup-backed (a calculated column, advanced search input, case write, or
 *   expression-targeted case operation), preserving safe sibling entries.
 *
 * No substitute expression is invented. Every function returns fresh owner
 * objects/arrays and never edits the canonical source document.
 */

import type { FieldWithChildren } from "@/lib/doc/fieldWalk";
import type {
	CaseListConfig,
	CaseOperation,
	CaseOperationLink,
	CaseOperationWrite,
	CaseSearchConfig,
	Field,
	Form,
	SearchInputDef,
} from "@/lib/domain";

/** Lookup AST nodes are identity-bearing dormant carriers until S10. */
const DORMANT_LOOKUP_AST_KINDS = new Set(["table-column", "table-lookup"]);

/**
 * Detect a dormant node at any depth in a Predicate / ValueExpression.
 *
 * The walk is intentionally shape-agnostic: adding another recursive
 * Predicate or ValueExpression arm cannot create a new hiding place that this
 * projection forgets to inspect.
 */
function containsDormantLookupAst(value: unknown): boolean {
	if (Array.isArray(value)) {
		return value.some(containsDormantLookupAst);
	}
	if (value === null || typeof value !== "object") return false;

	const record = value as Record<string, unknown>;
	if (
		typeof record.kind === "string" &&
		DORMANT_LOOKUP_AST_KINDS.has(record.kind)
	) {
		return true;
	}
	return Object.values(record).some(containsDormantLookupAst);
}

/**
 * Remove `optionsSource` recursively from a field tree while retaining the
 * inline-options fallback and every safe field/child value.
 */
export function carrierBlindFieldProjection<
	T extends Field | FieldWithChildren,
>(field: T): T {
	const projected = { ...field } as T & {
		optionsSource?: unknown;
		children?: FieldWithChildren[];
	};
	delete projected.optionsSource;
	if ("children" in field && field.children !== undefined) {
		projected.children = field.children.map((child) =>
			carrierBlindFieldProjection(child),
		);
	}
	return projected;
}

function carrierBlindCaseOperationWrite(
	write: CaseOperationWrite,
): CaseOperationWrite | undefined {
	// `value` is required. Omitting the whole optional write entry is the only
	// neutral projection when its expression is dormant.
	if (containsDormantLookupAst(write.value)) return undefined;

	const projected = { ...write };
	if (
		projected.condition !== undefined &&
		containsDormantLookupAst(projected.condition)
	) {
		delete projected.condition;
	}
	return projected;
}

function carrierBlindCaseOperationLink(
	link: CaseOperationLink,
): CaseOperationLink | undefined {
	// `target` itself is nullable, and null remains an exact safe value. The
	// expression arm is required when present, so a dormant expression makes
	// only this optional link entry unavailable.
	if (
		link.target?.kind === "expression" &&
		containsDormantLookupAst(link.target.expr)
	) {
		return undefined;
	}
	return { ...link };
}

function carrierBlindCaseOperation(
	operation: CaseOperation,
): CaseOperation | undefined {
	// The expression arm has no meaningful carrier-blind target. Preserve
	// sibling operations by omitting only this optional array entry.
	if (
		operation.target.kind === "expression" &&
		containsDormantLookupAst(operation.target.expr)
	) {
		return undefined;
	}

	const projected = { ...operation };
	for (const key of ["condition", "name", "owner", "rename"] as const) {
		const value = projected[key];
		if (value !== undefined && containsDormantLookupAst(value)) {
			delete projected[key];
		}
	}

	if (operation.writes !== undefined) {
		const writes = operation.writes
			.map(carrierBlindCaseOperationWrite)
			.filter((write): write is CaseOperationWrite => write !== undefined);
		if (writes.length === 0 && operation.writes.length > 0) {
			delete projected.writes;
		} else {
			projected.writes = writes;
		}
	}
	if (operation.links !== undefined) {
		const links = operation.links
			.map(carrierBlindCaseOperationLink)
			.filter((link): link is CaseOperationLink => link !== undefined);
		if (links.length === 0 && operation.links.length > 0) {
			delete projected.links;
		} else {
			projected.links = links;
		}
	}
	return projected;
}

export type AgentFormSnapshot = Form & { fields: FieldWithChildren[] };

/**
 * Project one form snapshot for SA/MCP reads.
 *
 * Form-level and operation-level AST slots are optional, so a contaminated
 * slot disappears. Required ASTs are contained by optional list entries, and
 * only that entry disappears.
 */
export function carrierBlindFormProjection<T extends AgentFormSnapshot>(
	form: T,
): T {
	const projected = {
		...form,
		fields: form.fields.map((field) => carrierBlindFieldProjection(field)),
	} as T;

	if (
		projected.displayCondition !== undefined &&
		containsDormantLookupAst(projected.displayCondition)
	) {
		delete projected.displayCondition;
	}

	if (form.caseOperations !== undefined) {
		const operations = form.caseOperations
			.map(carrierBlindCaseOperation)
			.filter(
				(operation): operation is CaseOperation => operation !== undefined,
			);
		if (operations.length === 0 && form.caseOperations.length > 0) {
			delete projected.caseOperations;
		} else {
			projected.caseOperations = operations;
		}
	}

	return projected;
}

function carrierBlindSearchInput(
	input: SearchInputDef,
): SearchInputDef | undefined {
	// The advanced arm's predicate is required; omit only that search-input
	// entry rather than returning a malformed or invented predicate.
	if (input.kind === "advanced" && containsDormantLookupAst(input.predicate)) {
		return undefined;
	}

	const projected = { ...input };
	if (
		projected.default !== undefined &&
		containsDormantLookupAst(projected.default)
	) {
		delete projected.default;
	}
	return projected;
}

/** Project a module's case-list config without dormant lookup AST nodes. */
export function carrierBlindCaseListConfig(
	config: CaseListConfig,
): CaseListConfig {
	const projected: CaseListConfig = {
		...config,
		columns: config.columns.flatMap((column) =>
			column.kind === "calculated" &&
			containsDormantLookupAst(column.expression)
				? []
				: [{ ...column }],
		),
		searchInputs: config.searchInputs
			.map(carrierBlindSearchInput)
			.filter((input): input is SearchInputDef => input !== undefined),
	};
	if (
		projected.filter !== undefined &&
		containsDormantLookupAst(projected.filter)
	) {
		delete projected.filter;
	}
	return projected;
}

/**
 * Project the optional case-search settings bag.
 *
 * An originally empty bag remains `{}`. If the bag contained only dormant
 * optional slots, `undefined` lets `getModule` expose its existing neutral
 * `null` representation instead of an invented setting.
 */
export function carrierBlindCaseSearchConfig(
	config: CaseSearchConfig,
): CaseSearchConfig | undefined {
	const projected = { ...config };
	let removed = false;
	for (const key of [
		"excludedOwnerIds",
		"searchButtonDisplayCondition",
	] as const) {
		const value = projected[key];
		if (value !== undefined && containsDormantLookupAst(value)) {
			delete projected[key];
			removed = true;
		}
	}
	return removed &&
		!Object.values(projected).some((value) => value !== undefined)
		? undefined
		: projected;
}
