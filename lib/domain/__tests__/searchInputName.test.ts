// A Search field's name is the key CommCare sends its answer under, and it
// may now equal any case property's name, hyphen included. The plausible
// failure is a schema that keeps refusing a hyphen while the emitters take
// it, or one that admits a character a key or a hashtag segment cannot hold.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	SEARCH_INPUT_NAME_PATTERN,
	SEARCH_INPUT_NAME_REJECTION,
	searchInputDefSchema,
	searchInputNameRefusal,
	simpleSearchInputDef,
} from "@/lib/domain";
import { HASHTAG_SEGMENT_SOURCE } from "@/lib/domain/hashtagSegments";

const named = (name: string) =>
	simpleSearchInputDef(
		testUuid("search-input-name"),
		name,
		"First name",
		"text",
		"first-name",
	);

interface Issue {
	readonly message: string;
	readonly errors?: readonly (readonly Issue[])[];
}

/** Every message a parse refusal holds, through the union's arms. */
function messages(issues: readonly Issue[]): string[] {
	return issues.flatMap((issue) => [
		issue.message,
		...(issue.errors ?? []).flatMap((arm) => messages(arm)),
	]);
}

describe("a Search field's name", () => {
	it.each(["first-name", "first_name", "_private", "a-", "A1-b_2"])(
		"admits %j",
		(name) => {
			expect(searchInputDefSchema.safeParse(named(name)).success).toBe(true);
		},
	);

	it.each([
		"-first",
		"1st",
		"first.name",
		"parent/age",
		"first name",
		"ñame",
		"",
	])("refuses %j with the sentence that says what a name holds", (name) => {
		const parsed = searchInputDefSchema.safeParse({
			...named("first-name"),
			name,
		});
		expect(parsed.success).toBe(false);
		expect(messages(parsed.error?.issues ?? [])).toContain(
			SEARCH_INPUT_NAME_REJECTION,
		);
	});

	it("is refused by the editors' check exactly where the schema refuses it, with the schema's sentence", () => {
		for (const name of ["first-name", "first_name", "_private", "a-"]) {
			expect(searchInputNameRefusal(name), name).toBeUndefined();
		}
		for (const name of ["-first", "1st", "first.name", "first name", ""]) {
			expect(searchInputNameRefusal(name), name).toBe(
				SEARCH_INPUT_NAME_REJECTION,
			);
		}
	});

	it("is always one hashtag segment, so #search/<name> reads it back", () => {
		const segment = new RegExp(`^${HASHTAG_SEGMENT_SOURCE}$`);
		for (const name of ["first-name", "_private", "a-", "Z9_-"]) {
			expect(SEARCH_INPUT_NAME_PATTERN.test(name)).toBe(true);
			expect(segment.test(name)).toBe(true);
		}
	});
});
