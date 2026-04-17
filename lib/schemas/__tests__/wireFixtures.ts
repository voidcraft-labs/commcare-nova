// Wire-format test fixture helpers. These support tests of the SA wire
// layer — the blueprint schema itself, the HQ JSON expander, the CCZ
// compiler, the SA session bridge, and connect-config validation. All of
// those test wire-format processing, so the fixtures build wire-format
// `Question` trees and not domain `Field` entities.
//
// For domain-side test fixtures (the builder doc store, mutations, etc.)
// use `lib/domain/__tests__/buildDoc.ts` instead.

import type { Question } from "@/lib/schemas/blueprint";

let counter = 0;

/** Create a wire-format `Question` with an auto-assigned uuid. */
export function q(
	overrides: Omit<Question, "uuid"> & { uuid?: string },
): Question {
	return { uuid: `test-uuid-${++counter}`, ...overrides };
}
