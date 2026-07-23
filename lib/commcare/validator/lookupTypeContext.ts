/**
 * Rows-free lookup types shared by every Predicate / ValueExpression
 * validation surface.
 *
 * Structural availability findings remain owned by `lookupReferences.ts`.
 * The type checker needs the same definition snapshot to resolve a valid
 * table/column to its scalar type, but must not repeat "missing table" or
 * "missing column" as a second slot-level type error. The helpers here keep
 * those two responsibilities explicit.
 */

import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import type {
	CheckError,
	CheckResult,
	TypeContext,
} from "@/lib/domain/predicate";

export type LookupTypeIndex = NonNullable<TypeContext["lookupTables"]>;

const STRUCTURAL_LOOKUP_CHECK_CODES = new Set<CheckError["code"]>([
	"unknown-lookup-table",
	"unknown-lookup-column",
]);

/**
 * Materialize one immutable-by-contract table -> column -> scalar-type index
 * from the exact rows-free snapshot the structural validator received.
 *
 * An unavailable context intentionally becomes an empty index: the structural
 * validator emits `LOOKUP_CONTEXT_UNAVAILABLE` per occurrence, while semantic
 * checks that do not need a column type (field order, repeat scope, nested
 * lookup rejection) still run.
 */
export function lookupTypeIndex(
	context: LookupValidationContext,
): LookupTypeIndex {
	if (context.kind === "unavailable") return new Map();
	return new Map(
		context.definitions.map((table) => [
			table.id,
			new Map(
				table.columns.map((column) => [column.id, column.dataType] as const),
			),
		]),
	);
}

/**
 * The semantic/type-checker errors left after the structural lookup validator
 * has taken ownership of missing/unavailable table and column identities.
 */
export function semanticCheckErrors(
	result: CheckResult,
): readonly CheckError[] {
	if (result.ok) return [];
	return result.errors.filter(
		(error) => !STRUCTURAL_LOOKUP_CHECK_CODES.has(error.code),
	);
}
