// A date-and-time question that starts on a case's stored value opens on the
// moment the case holds, in the viewer's zone, as a device opens it: Core's
// cast keeps the written date and moves only the clock, so the stored text is
// read in the device's own date and clock first
// (`lib/commcare/xpath/wire/instant.ts::deviceInstantText`), and Preview
// evaluates the same printed tree. A starting value written as a literal
// moment is read the same way. A Hidden Value calculated as the stored
// value holds its text as it is. Core's own reading in every device zone is
// the lane's `StoredInstantRuntimeTest`.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { NEW_APP_SETTINGS } from "@/lib/domain";
import { HQ_INSTANT_VECTORS } from "@/lib/domain/__tests__/hqInstantText.vectors";
import { instantDatetimeValue } from "@/lib/domain/temporalValues";
import { buildEngineInput } from "../engineInput";
import { FormEngine } from "../formEngine";

const FORM = testUuid("datetime-starting-form");
const ZONES = [
	"UTC",
	"America/New_York",
	"Asia/Kolkata",
	"Pacific/Kiritimati",
] as const;

/** The moment Core's cast gives where it is not the stored one: it sets the
 * device's date and clock on a calendar, which reads a clock the zone repeats
 * as its later occurrence. */
const CORE_READS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	"new-york-repeated-hour-first": {
		"America/New_York": "2026-11-01T06:30:00.000Z",
	},
};

function revisit() {
	const doc = buildDoc({
		// A date-and-time question runs on Android alone.
		appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "android" },
		caseTypes: [
			{
				name: "visit",
				properties: [
					{ name: "seen_at", label: "Seen at", data_type: "datetime" },
					{ name: "seen_kept", label: "Seen kept", data_type: "datetime" },
				],
			},
		],
		modules: [
			{
				name: "Visits",
				caseType: "visit",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: FORM,
						name: "Revisit",
						type: "followup",
						fields: [
							f({
								id: "seen",
								kind: "datetime",
								label: "Seen at",
								default_value: "#visit/seen_at",
								caseWrite: { caseType: "visit", property: "seen_at" },
							}),
							f({
								id: "kept",
								kind: "hidden",
								calculate: "#visit/seen_at",
								caseWrite: { caseType: "visit", property: "seen_kept" },
							}),
						],
					},
				],
			},
		],
	});
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	const input = buildEngineInput(doc, FORM, null);
	if (!input) throw new Error("Missing form input");
	return input;
}

/** A survey whose date-and-time question starts on a written moment: a
 * literal with an offset no device zone here shares. */
const WRITTEN = "2024-01-15T14:30:00.000-05:00";

function written() {
	const doc = buildDoc({
		appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "android" },
		modules: [
			{
				name: "Visits",
				forms: [
					{
						uuid: FORM,
						name: "Visit",
						type: "survey",
						fields: [
							f({
								id: "recorded_at",
								kind: "datetime",
								label: "Recorded at",
								default_value: `'${WRITTEN}'`,
							}),
						],
					},
				],
			},
		],
	});
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	const input = buildEngineInput(doc, FORM, null);
	if (!input) throw new Error("Missing form input");
	return input;
}

function inZone(zone: string, run: () => void): void {
	const original = process.env.TZ;
	try {
		process.env.TZ = zone;
		run();
	} finally {
		if (original === undefined) delete process.env.TZ;
		else process.env.TZ = original;
	}
}

describe("a date-and-time question starting on a stored moment", () => {
	it.each(ZONES)("opens on that moment in %s", (zone) => {
		const input = revisit();
		inZone(zone, () => {
			for (const vector of HQ_INSTANT_VECTORS) {
				const engine = new FormEngine(
					input,
					"visit",
					new Map([["visit", new Map([["seen_at", vector.text]])]]),
				);
				const moment = CORE_READS[vector.id]?.[zone] ?? vector.instant;
				expect(
					engine.getState("/data/seen").value,
					`${vector.id} in ${zone}`,
				).toBe(instantDatetimeValue(Date.parse(moment), zone));
				expect(
					engine.getState("/data/kept").value,
					`${vector.id} copied in ${zone}`,
				).toBe(vector.text);
			}
		});
	});

	it.each(ZONES)(
		"opens on that moment in %s from the offset spelling Nova stored before",
		(zone) => {
			const input = revisit();
			inZone(zone, () => {
				for (const vector of HQ_INSTANT_VECTORS) {
					const earlier = instantDatetimeValue(
						Date.parse(vector.instant),
						"Asia/Kolkata",
					);
					const engine = new FormEngine(
						input,
						"visit",
						new Map([["visit", new Map([["seen_at", earlier]])]]),
					);
					const moment = CORE_READS[vector.id]?.[zone] ?? vector.instant;
					expect(
						engine.getState("/data/seen").value,
						`${vector.id} from ${earlier} in ${zone}`,
					).toBe(instantDatetimeValue(Date.parse(moment), zone));
				}
			});
		},
	);

	// The written literal is classed an instant (`instant.ts::mayHoldInstantText`),
	// so it is read in the device's own date and clock before the cast, as a
	// stored value is: in Kolkata and Kiritimati the moment falls on January 16,
	// and a cast of the written text would open a whole day earlier.
	it.each(ZONES)("opens on a written moment in %s", (zone) => {
		const input = written();
		inZone(zone, () => {
			const engine = new FormEngine(input);
			expect(engine.getState("/data/recorded_at").value).toBe(
				instantDatetimeValue(Date.parse(WRITTEN), zone),
			);
		});
	});

	it("opens blank on a case with no value", () => {
		const engine = new FormEngine(
			revisit(),
			"visit",
			new Map([["visit", new Map([["seen_at", ""]])]]),
		);
		expect(engine.getState("/data/seen").value).toBe("");
		expect(engine.getState("/data/kept").value).toBe("");
	});
});
