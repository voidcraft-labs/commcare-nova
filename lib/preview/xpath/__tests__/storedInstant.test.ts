import { describe, expect, it } from "vitest";
import { w } from "@/lib/commcare/xpath/wire/builders";
import { storedInstantOfText } from "@/lib/commcare/xpath/wire/instant";
import { serializeWire } from "@/lib/commcare/xpath/wire/serialize";
import { HQ_INSTANT_VECTORS } from "@/lib/domain/__tests__/hqInstantText.vectors";
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
