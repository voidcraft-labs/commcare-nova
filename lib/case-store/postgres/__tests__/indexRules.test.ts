import { expect, it } from "vitest";
import {
	type CaseProperty,
	type CasePropertyDataType,
	casePropertyDataTypes,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { POSTGRES_CAST_FOR_DATA_TYPE } from "../../sql";
import { desiredIndexForProperty } from "../store";

it("index name uniquely determines index shape — two data types share a name only if they share a cast", () => {
	// `diffIndexSets` keys on index NAME and skips a valid same-
	// name match, so two `data_type`s that compose the same index
	// name MUST produce the same index expression — else a retype
	// between them leaves a stale-cast index the diff never
	// rebuilds (the `int↔decimal` bug above). This pins that
	// invariant across the whole `data_type` set so a future
	// numeric type can't silently reintroduce a same-name /
	// different-cast collision. Pure — `desiredIndexForProperty`
	// is total and reads no database.
	const property = (data_type: CasePropertyDataType): CaseProperty => ({
		name: "p",
		label: proseText("P"),
		data_type,
	});

	// The exact regression: `int` and `decimal` on one property
	// must compose distinct names.
	const intName = desiredIndexForProperty("app", "ct", property("int"))?.name;
	const decimalName = desiredIndexForProperty(
		"app",
		"ct",
		property("decimal"),
	)?.name;
	expect(intName).toBeTruthy();
	expect(decimalName).toBeTruthy();
	expect(intName).not.toBe(decimalName);

	// General guard: across every data type, a shared index name
	// implies a shared cast and access method.
	const byName = new Map<
		string,
		{ dataType: CasePropertyDataType; using: string }
	>();
	for (const dataType of casePropertyDataTypes) {
		const entry = desiredIndexForProperty("app", "ct", property(dataType));
		if (entry === undefined) continue;
		const prior = byName.get(entry.name);
		if (prior !== undefined) {
			expect(POSTGRES_CAST_FOR_DATA_TYPE[dataType]).toBe(
				POSTGRES_CAST_FOR_DATA_TYPE[prior.dataType],
			);
			expect(entry.using).toBe(prior.using);
		}
		byName.set(entry.name, { dataType, using: entry.using });
	}
});
