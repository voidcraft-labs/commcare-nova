import type { Literal } from "@/lib/domain/expression";

/** Existing record cards edit literal lists. Other saved trees stay intact. */
export function isLiteralList(
	values: readonly { readonly kind: string }[],
): values is [Literal, ...Literal[]] {
	return values.length > 0 && values.every((value) => value.kind === "literal");
}
