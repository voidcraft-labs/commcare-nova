import type { Question } from "@/lib/schemas/blueprint";

let counter = 0;

/** Create a Question with an auto-assigned uuid. Accepts any partial overrides. */
export function q(
	overrides: Omit<Question, "uuid"> & { uuid?: string },
): Question {
	return { uuid: `test-uuid-${++counter}`, ...overrides };
}
