import type { Choice, Literal } from "@/lib/domain/expression";

/** Existing record cards edit lists of written values and choices of a
 * question. Other saved trees stay intact. */
export function isSelectionValueList(
	values: readonly { readonly kind: string }[],
): values is [Literal | Choice, ...(Literal | Choice)[]] {
	return (
		values.length > 0 &&
		values.every((value) => value.kind === "literal" || value.kind === "choice")
	);
}
