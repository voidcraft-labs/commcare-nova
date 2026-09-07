import { expect, it } from "vitest";
import {
	AppPaginationError,
	decodeAppsCursor,
	encodeAppsCursor,
	type ListAppsCursor,
} from "../appPagination";

const timestamp = "2026-04-05T12:34:56.789Z";
const vectors: ListAppsCursor[] = [
	{ kind: "updated_desc", updated_at: timestamp, id: "b" },
	{ kind: "updated_asc", updated_at: timestamp, id: "b" },
	{ kind: "name_asc", name_lower: "clinique 💉", id: "b" },
	{ kind: "name_desc", name_lower: "clinique 💉", id: "b" },
];
it.each(vectors)(
	"admits the $kind composite boundary and rejects a different ordering",
	(cursor) => {
		const encoded = Buffer.from(JSON.stringify(cursor)).toString("base64url");
		expect(encodeAppsCursor(cursor)).toBe(encoded);
		expect(decodeAppsCursor(encoded, cursor.kind)).toEqual(cursor);
		expect(() =>
			decodeAppsCursor(
				encoded,
				cursor.kind === "name_asc" ? "updated_desc" : "name_asc",
			),
		).toThrow(AppPaginationError);
	},
);
it("rejects malformed encoding and structurally invalid payloads with a safe restart instruction", () => {
	const valid = { kind: "updated_desc", id: "a", updated_at: timestamp };
	const malformed = [
		"",
		"%%%",
		"ey",
		"bnVsbA=", // Truncated JSON and noncanonical base64url.
		...[
			null,
			[],
			"value",
			{},
			{ ...valid, id: "" },
			{ ...valid, id: 5 },
			{ ...valid, id: "a\0b" },
			{ ...valid, kind: "private-input" },
			{ ...valid, extra: true },
			{ ...valid, updated_at: 5 },
			{ ...valid, updated_at: "not-a-date" },
			{ ...valid, updated_at: "2026-02-30T00:00:00.000Z" },
			{ ...valid, updated_at: "2026-04-05" },
			{ kind: "name_asc", id: "a", name_lower: null },
			{ kind: "name_asc", id: "a", name_lower: "a\0b" },
		].map((value) => Buffer.from(JSON.stringify(value)).toString("base64url")),
	];
	for (const encoded of malformed) {
		expect(() => decodeAppsCursor(encoded, "updated_desc"), encoded).toThrow(
			new AppPaginationError(
				"This pagination cursor is invalid. Try again without a cursor.",
			),
		);
	}
});
