import {
	type Literal,
	literal,
	qualifiedLiteral,
} from "@/lib/domain/predicate";

/** Preserve an authored qualifier while replacing its value. This constructor
 * does not admit the result: the input state owner and document gate own that. */
export function rebuildLiteralPreservingDataType(
	source: Literal,
	nextValue: string | number | boolean | null,
): Literal {
	if (source.data_type === undefined) {
		return literal(nextValue);
	}
	return qualifiedLiteral(nextValue, source.data_type);
}
