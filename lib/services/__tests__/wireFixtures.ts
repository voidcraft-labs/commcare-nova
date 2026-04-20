// Wire-format test fixture helpers. These support tests of the CommCare
// compile/expand path (`hqJsonExpander`, `cczCompiler`, `session`,
// `connectConfig`, `postExpansionValidation`) which still operate on the
// legacy nested `Question` shape. The domain layer does NOT use this
// helper — domain-side tests build `Field` entities via
// `lib/__tests__/docHelpers.ts`.

import type { Question } from "@/lib/doc/legacyTypes";

let counter = 0;

/** Create a wire-format `Question` with an auto-assigned uuid. */
export function q(
	overrides: Omit<Question, "uuid"> & { uuid?: string },
): Question {
	return { uuid: `test-uuid-${++counter}`, ...overrides };
}
