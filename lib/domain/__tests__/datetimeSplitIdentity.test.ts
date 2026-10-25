/**
 * The split's derived identities: the same split names the same questions
 * wherever it is planned (the builder, the fuzz mapping), and a later attempt
 * names others.
 */
import { describe, expect, it } from "vitest";
import {
	DATETIME_SPLIT_NAMESPACE_UUID,
	datetimeSplitFieldUuid,
} from "@/lib/domain/datetimeSplitIdentity";
import { asUuid } from "@/lib/domain/uuid";

// The corpus's one document that runs on neither platform,
// `fuzz-suite-20260930-8`: its date-and-time question `model`.
const APP = "suite-fuzz-app";
const MODEL = asUuid("b94f283e-4f0c-5542-af5a-f1fca0afb3ae");

describe("datetimeSplitFieldUuid", () => {
	it("derives the identities computed for the corpus's document on neither platform", () => {
		expect(DATETIME_SPLIT_NAMESPACE_UUID).toBe(
			"6cbda68f-3426-4851-8dcc-ed0424034b59",
		);
		expect(datetimeSplitFieldUuid(APP, MODEL, "date")).toBe(
			"dbc29a4b-ccff-5bd7-84cd-1d9dfd69219c",
		);
		expect(datetimeSplitFieldUuid(APP, MODEL, "time")).toBe(
			"4fd829ed-23d6-523f-b621-306e6c6157dd",
		);
	});

	it("names other questions on a later attempt, in another app, or for the other purpose", () => {
		const first = datetimeSplitFieldUuid(APP, MODEL, "date", 0);
		const names = new Set([
			first,
			datetimeSplitFieldUuid(APP, MODEL, "date", 1),
			datetimeSplitFieldUuid(APP, MODEL, "date", 2),
			datetimeSplitFieldUuid(APP, MODEL, "time", 1),
			datetimeSplitFieldUuid("another-app", MODEL, "date"),
		]);
		expect(names.size).toBe(5);
		expect(datetimeSplitFieldUuid(APP, MODEL, "date")).toBe(first);
	});
});
