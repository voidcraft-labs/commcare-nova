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
 *   lookup-backed (a calculated column or advanced search input), preserving
 *   safe sibling entries;
 * - preserve every case operation's ordered/addressable identity. If any of
 *   its authoring slots contains a lookup carrier, expose explicit unavailable
 *   metadata instead of an invented or partial editable operation.
 *
 * No substitute expression is invented. Every function returns fresh owner
 * objects/arrays and never edits the canonical source document.
 */

import { CASE_OPERATION_DORMANT_LOOKUP_EDIT_REASON } from "@/lib/doc/caseOperationMutations";
import { caseOperationContainsDormantLookupCarrier } from "@/lib/doc/dormantLookupCarriers";
import type { FieldWithChildren } from "@/lib/doc/fieldWalk";
import type {
	CaseListConfig,
	CaseOperation,
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

export const DORMANT_CASE_OPERATION_UNAVAILABLE_KIND =
	"lookup-table-logic" as const;

export interface DormantCaseOperationUnavailableProjection {
	readonly uuid: CaseOperation["uuid"];
	readonly id: string;
	readonly order?: string;
	readonly action: CaseOperation["action"];
	readonly caseType: string;
	readonly unavailable: {
		readonly kind: typeof DORMANT_CASE_OPERATION_UNAVAILABLE_KIND;
		readonly reason: string;
	};
}

export type CarrierBlindCaseOperationProjection =
	| CaseOperation
	| DormantCaseOperationUnavailableProjection;

export function isDormantCaseOperationUnavailableProjection(
	operation: CarrierBlindCaseOperationProjection,
): operation is DormantCaseOperationUnavailableProjection {
	return "unavailable" in operation;
}

function carrierBlindCaseOperation(
	operation: CaseOperation,
): CarrierBlindCaseOperationProjection {
	if (!caseOperationContainsDormantLookupCarrier(operation)) {
		return structuredClone(operation);
	}
	return {
		uuid: operation.uuid,
		id: operation.id,
		...(operation.order !== undefined && { order: operation.order }),
		action: operation.action,
		caseType: operation.caseType,
		unavailable: {
			kind: DORMANT_CASE_OPERATION_UNAVAILABLE_KIND,
			reason: CASE_OPERATION_DORMANT_LOOKUP_EDIT_REASON,
		},
	};
}

/**
 * Project an ordered case-operation list for an SA/MCP read surface.
 *
 * Exported for the dedicated case-operation read tool, whose author-identity
 * projection happens after the dormant-carrier boundary.
 */
export function carrierBlindCaseOperationsProjection(
	operations: readonly CaseOperation[],
): CarrierBlindCaseOperationProjection[] {
	return operations.map(carrierBlindCaseOperation);
}

export type AgentFormSnapshot = Form & { fields: FieldWithChildren[] };
export type CarrierBlindFormSnapshot<T extends AgentFormSnapshot> = Omit<
	T,
	"caseOperations"
> & {
	caseOperations?: CarrierBlindCaseOperationProjection[];
};

/**
 * Project one form snapshot for SA/MCP reads.
 *
 * Form-level and operation-level AST slots are optional, so a contaminated
 * slot disappears. Required ASTs are contained by optional list entries, and
 * only that entry disappears.
 */
export function carrierBlindFormProjection<T extends AgentFormSnapshot>(
	form: T,
): CarrierBlindFormSnapshot<T> {
	const projected = {
		...form,
		fields: form.fields.map((field) => carrierBlindFieldProjection(field)),
	} as CarrierBlindFormSnapshot<T>;

	if (
		projected.displayCondition !== undefined &&
		containsDormantLookupAst(projected.displayCondition)
	) {
		delete projected.displayCondition;
	}

	if (form.caseOperations !== undefined) {
		const operations = carrierBlindCaseOperationsProjection(
			form.caseOperations,
		);
		projected.caseOperations = operations;
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
