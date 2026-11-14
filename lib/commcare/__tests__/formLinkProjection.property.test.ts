/** After-submit stack algebra over generated documents.
 * Every document passes the commit gate; its after-submit is projected by
 * the production projection and each emitted `if` is evaluated by Preview's
 * XPath evaluator over a device world. Native Core links proof owns device
 * evaluation and actual navigation; this checks which frames the emitted
 * stack pushes, in which order, under every assignment of the destinations'
 * conditions and every held set of carried cases. The documents come from
 * the link generator, `formLinkDocArbitrary.ts`. */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	formLinkProjectionContext,
	projectAfterSubmit,
} from "@/lib/commcare/formLinkProjection";
import { runValidation } from "@/lib/commcare/validator/runner";
import { serializeWire, type WireExpr } from "@/lib/commcare/xpath";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { Uuid } from "@/lib/domain";
import type { CaseRow } from "@/lib/preview/engine/caseDataBindingTypes";
import {
	caseDatabaseXPathInstance,
	commcareSessionXPathInstance,
} from "@/lib/preview/engine/xpathInstances";
import { toBoolean } from "@/lib/preview/xpath/coerce";
import { evaluate } from "@/lib/preview/xpath/evaluator";
import {
	buildShape,
	CARRIED,
	CHECK,
	type DrawnDestination,
	type DrawnOtherwise,
	FLAGS,
	linkUuid,
	mayNotRun,
	OTHERWISE_UUID,
	shape,
} from "./formLinkDocArbitrary";

const SOURCE_CASE = "source-frog";

function caseRow(id: string, properties: Record<string, string>): CaseRow {
	return {
		case_id: id,
		app_id: "test-app",
		case_type: "frog",
		owner_id: "u1",
		status: "open",
		opened_on: new Date("2026-08-01T00:00:00.000Z"),
		modified_on: new Date("2026-08-02T00:00:00.000Z"),
		closed_on: null,
		case_name: id,
		external_id: null,
		parent_case_id: null,
		properties,
	} as CaseRow;
}

/** Whether `xpath` holds in the world where the source case's flags are
 *  `bits` and the device holds the carried cases in `held`. */
function holdsIn(bits: readonly boolean[], held: ReadonlySet<string>) {
	const casedb = caseDatabaseXPathInstance({
		rows: [
			caseRow(
				SOURCE_CASE,
				Object.fromEntries(
					FLAGS.map((flag) => [`flag${flag}`, bits[flag] ? "yes" : "no"]),
				),
			),
			...[...held].map((id) => caseRow(id, {})),
		],
		indices: [],
	});
	const session = commcareSessionXPathInstance(
		{ context: { userid: "u1" }, user: {}, userPropertySlugs: {} },
		{ case_id: SOURCE_CASE },
	);
	return (xpath: WireExpr): boolean =>
		toBoolean(
			evaluate(serializeWire(xpath, { target: "preview" }).text, {
				contextPath: "",
				position: 1,
				getValue: () => {
					throw new Error("A form link cannot read the closed form.");
				},
				resolveXPathInstance: (id) =>
					id === "casedb"
						? casedb
						: id === "commcaresession"
							? session
							: undefined,
			}),
		);
}

describe("after-submit stack algebra", () => {
	it("pushes exactly the destinations that hold, last first, and the otherwise when none that may not run holds", () => {
		fc.assert(
			fc.property(shape, ({ destinations, otherwise: drawn }) => {
				// An otherwise is admitted only beside a destination that may
				// not run.
				const drawnOtherwise: DrawnOtherwise = destinations.some(mayNotRun)
					? drawn
					: { kind: "none" };
				const doc = buildShape(destinations, drawnOtherwise);
				expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
				const projected = projectAfterSubmit(
					doc,
					formLinkProjectionContext(doc),
					CHECK,
				);
				if (projected === undefined) throw new Error("Nothing projected.");
				for (let mask = 0; mask < 1 << FLAGS.length; mask++) {
					const bits = FLAGS.map((flag) => (mask & (1 << flag)) !== 0);
					for (let heldMask = 0; heldMask < 1 << CARRIED.length; heldMask++) {
						const held = new Set(
							CARRIED.filter((_, index) => (heldMask & (1 << index)) !== 0),
						);
						const holds = holdsIn(bits, held);
						const runs = (drawnLink: DrawnDestination) =>
							(drawnLink.flag === undefined || bits[drawnLink.flag]) &&
							(drawnLink.carry === undefined || held.has(drawnLink.carry));
						const expected: Uuid[] = destinations
							.map((drawnLink, index) => ({ drawnLink, index }))
							.filter(({ drawnLink }) => runs(drawnLink))
							.map(({ index }) => linkUuid(index))
							.reverse();
						const otherwiseRuns = !destinations.some(
							(drawnLink) => mayNotRun(drawnLink) && runs(drawnLink),
						);
						if (otherwiseRuns && drawnOtherwise.kind === "link") {
							if (
								drawnOtherwise.carry === undefined ||
								held.has(drawnOtherwise.carry)
							)
								expected.push(OTHERWISE_UUID);
						}
						const pushed: string[] = projected.links
							.filter((link) => link.xpath === undefined || holds(link.xpath))
							.map((link) => link.uuid);
						if (
							projected.fallback.kind === "built-in" &&
							holds(projected.fallback.xpath)
						)
							pushed.push("fallback");
						expect(pushed).toEqual(
							otherwiseRuns && drawnOtherwise.kind === "built-in"
								? [...expected, "fallback"]
								: expected,
						);
					}
				}
			}),
			{ numRuns: 60 },
		);
	});
});
