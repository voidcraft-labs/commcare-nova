import type { LookupDefinitionIndex } from "@/lib/domain/expression/context";
import type { LookupValidationContext } from "./lookupReferences";

const DEFINITION_INDEXES = new WeakMap<
	LookupValidationContext,
	LookupDefinitionIndex
>();

/** The exact rows-free Project snapshot used for expression names and types. */
export function lookupExpressionDefinitions(
	context: LookupValidationContext,
): LookupDefinitionIndex | "unavailable" {
	if (context.kind === "unavailable") return "unavailable";
	const cached = DEFINITION_INDEXES.get(context);
	if (cached !== undefined) return cached;
	const definitions: LookupDefinitionIndex = new Map(
		context.definitions.map((table) => [table.id, table]),
	);
	DEFINITION_INDEXES.set(context, definitions);
	return definitions;
}
