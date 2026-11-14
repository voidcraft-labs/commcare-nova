import { describe, expect, it } from "vitest";
import { w } from "@/lib/commcare/xpath/wire/builders";
import {
	deviceInstantText,
	storedInstantOfText,
} from "@/lib/commcare/xpath/wire/instant";
import { serializeWire } from "@/lib/commcare/xpath/wire/serialize";
import type { WireExpr } from "@/lib/commcare/xpath/wire/tree";
import { HQ_INSTANT_VECTORS } from "@/lib/domain/__tests__/hqInstantText.vectors";
import { INSTANT_TEXT_PATTERN } from "@/lib/domain/expression/datePattern";
import { instantDatetimeValue } from "@/lib/domain/temporalValues";
import { xpathToString } from "../coerce";
import { evaluate } from "../evaluator";
import type { EvalContext } from "../types";

// A phone moves the text `typedInstantText` prints for a typed moment (its
// clock in the device's zone, then Core's `%Z`) to the text CommCare HQ
// stores. Preview evaluates the `preview` print of the same tree. The text
// each vector expects is written out by hand in the vectors file, never
// computed from the function under test; Core's own reading of it in every
// device zone is the lane's `StoredInstantRuntimeTest`.

// The lane's device zones, and two whose offsets hold minutes, one of them
// more than twelve hours ahead of UTC.
const ZONES = [
	"UTC",
	"America/New_York",
	"Asia/Kolkata",
	"Pacific/Kiritimati",
	"Pacific/Chatham",
	"America/St_Johns",
] as const;

/** The text `format-date(x, '%Y-%m-%dT%H:%M:%S.%3%Z')` prints for a moment
 * in `zone`: Core's `%Z` is `Z`, `±HH`, or `±HH:MM` where the minutes are
 * not zero (`DateUtils.getOffsetInStandardFormat`). */
function deviceText(instant: string, zone: string): string {
	const nova = instantDatetimeValue(Date.parse(instant), zone);
	const clock = nova.slice(0, 23);
	const offset = nova.slice(23);
	if (offset === "Z") return `${clock}Z`;
	return offset.endsWith(":00")
		? `${clock}${offset.slice(0, 3)}`
		: `${clock}${offset}`;
}

/** An evaluation over no form: the text is a literal. */
const CONTEXT = {
	mainInstance: undefined,
	contextNode: undefined,
	originalContextNode: undefined,
	contextPath: "/",
	position: undefined,
	getValue: () => undefined,
} as unknown as EvalContext;

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

describe("the stored text of a typed moment", () => {
	it.each(ZONES)("is CommCare HQ's text of the moment in %s", (zone) => {
		inZone(zone, () => {
			for (const vector of HQ_INSTANT_VECTORS) {
				const text = deviceText(vector.instant, zone);
				const printed = serializeWire(storedInstantOfText(w.str(text)), {
					target: "preview",
				}).text;
				expect(
					xpathToString(evaluate(printed, CONTEXT)),
					`${vector.id} from ${text}`,
				).toBe(vector.text);
			}
		});
	});
});

/** What Core's `format-date` prints for the value `text` names, in one
 * fixed shape: Core's own parse of the text, then the device's clock. */
function readBack(text: WireExpr): string {
	const printed = serializeWire(
		w.call("format-date", [text, w.str(INSTANT_TEXT_PATTERN)]),
		{ target: "preview" },
	).text;
	return xpathToString(evaluate(printed, CONTEXT));
}

/** The moment Core's parse gives where it is not the vector's own: the
 * parse ends by setting the device's date and clock on a calendar
 * (`DateUtils.getDate`), which reads a clock the zone repeats as its later
 * occurrence, whatever text names it. */
const CORE_READS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	"new-york-repeated-hour-first": {
		"America/New_York": "2026-11-01T06:30:00.000Z",
	},
};
const coreRead = (id: string, instant: string, zone: string) =>
	CORE_READS[id]?.[zone] ?? instant;

// A starting value, a `format-date` or a `date()` reads stored text through
// Core's parse, which keeps the written date and moves only the clock. Read
// first in the device's own date and clock, the text names its own moment in
// every zone, to the millisecond, so a form opened on a case's value and
// saved unchanged writes the same text back.
describe("stored text read as a typed moment on a device", () => {
	it.each(ZONES)("names its own moment in %s", (zone) => {
		inZone(zone, () => {
			for (const vector of HQ_INSTANT_VECTORS) {
				const read = readBack(deviceInstantText(w.str(vector.text)));
				const moment = coreRead(vector.id, vector.instant, zone);
				expect(read, `${vector.id} read in ${zone}`).toBe(
					deviceText(moment, zone),
				);
				// Saved again, it is the text the case held.
				const printed = serializeWire(storedInstantOfText(w.str(read)), {
					target: "preview",
				}).text;
				expect(
					xpathToString(evaluate(printed, CONTEXT)),
					`${vector.id} saved again in ${zone}`,
				).toBe(
					moment === vector.instant
						? vector.text
						: `${moment.slice(0, 23)}000Z`,
				);
			}
		});
	});

	it.each(ZONES)(
		"names its own moment in %s from the offset spelling Nova stored before",
		(zone) => {
			inZone(zone, () => {
				for (const vector of HQ_INSTANT_VECTORS) {
					const earlier = instantDatetimeValue(
						Date.parse(vector.instant),
						"Asia/Kolkata",
					);
					expect(
						readBack(deviceInstantText(w.str(earlier))),
						`${vector.id} from ${earlier} in ${zone}`,
					).toBe(deviceText(coreRead(vector.id, vector.instant, zone), zone));
				}
			});
		},
	);

	it("is a day away when read as written, where the device's date is not the UTC one", () => {
		inZone("America/New_York", () => {
			const vector = HQ_INSTANT_VECTORS.find(
				(each) => each.id === "utc-day-after-new-york",
			);
			if (vector === undefined) throw new Error("The vector is missing.");
			expect(readBack(w.str(vector.text))).not.toBe(
				deviceText(vector.instant, "America/New_York"),
			);
		});
	});

	it("leaves a blank, a date and a wall clock with no offset as they are", () => {
		for (const text of ["", "2026-01-15", "2026-01-15T10:00:00.000"]) {
			const printed = serializeWire(deviceInstantText(w.str(text)), {
				target: "preview",
			}).text;
			expect(xpathToString(evaluate(printed, CONTEXT)), text).toBe(text);
		}
	});
});
