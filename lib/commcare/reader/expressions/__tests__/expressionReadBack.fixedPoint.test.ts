/**
 * A reading of an HQ author's own text is a fixed point of writing it back.
 *
 * Contract: for a text an author wrote in CommCare HQ that the reader holds,
 * the tree it reads is canonical (`canonicalExpression` leaves it as it is),
 * and writing the read app back with the production emitter and reading that
 * gives the same tree: `read(emit(read(A))) = read(A)`. The texts are each a
 * spelling Nova itself writes another way, one for each of the emitter's
 * rewrites a reading can meet in a form or a menu: an absolute read in a
 * starting value, an absolute read in a row predicate inside a repeat, a bare
 * comparison of two dates and times, an unguarded read of a case's value,
 * a bare read of the screen width, a case
 * list filter opening with `true() and`, and a validation holding a count.
 *
 * Plausible failures: a reading that keeps HQ's spelling where Nova's print
 * differs, so a second reading of Nova's own export reads another tree (the
 * app would change at every round trip), and a held tree that is not the
 * canonical one of its print collisions.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { slotContext } from "@/lib/domain/expression/context";
import type { Expression } from "@/lib/domain/expression/types";
import { expressionSlotKey } from "@/lib/domain/referenceSlots";
import { exportedBody } from "../../__tests__/novaExport";
import { canonicalExpression } from "../canonical";
import { type EmissionReading, readBody, readEmission } from "./readBackCorpus";

function app(): BlueprintDoc {
	return buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "p", label: "P" }],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({ kind: "text", id: "q1", label: "Q1" }),
							f({
								kind: "text",
								id: "q2",
								label: "Q2",
								default_value: "#form/q1",
							}),
							f({ kind: "datetime", id: "dt1", label: "First" }),
							f({
								kind: "text",
								id: "dt2",
								label: "Second",
								relevant: "#form/q1 != ''",
							}),
							f({
								kind: "text",
								id: "checked",
								label: "Checked",
								validate: "#form/q1 != ''",
							}),
							f({
								kind: "repeat",
								id: "r",
								label: "Visits",
								repeat_mode: "user_controlled",
								children: [
									f({ kind: "text", id: "k", label: "Kind" }),
									f({ kind: "hidden", id: "c", calculate: "1" }),
								],
							}),
							f({ kind: "hidden", id: "d", calculate: "1" }),
						],
					},
				],
			},
		],
	});
}

/** The one element of `xml` that opens with `open` and holds `marker`, with
 *  `attribute` set to `value` (escaped as the source holds it) and `drop`
 *  removed: an edit as HQ's form builder would leave it. */
function setAttribute(
	xml: string,
	open: string,
	marker: string,
	attribute: string,
	value: string,
	drop?: string,
): string {
	let from = xml.indexOf(open);
	while (from >= 0) {
		const end = xml.indexOf(">", from);
		const element = xml.slice(from, end + 1);
		if (element.includes(marker)) {
			const escaped = value
				.replaceAll("&", "&amp;")
				.replaceAll("<", "&lt;")
				.replaceAll(">", "&gt;")
				.replaceAll("'", "&apos;");
			let next = element.replace(new RegExp(` ${attribute}="[^"]*"`, "u"), "");
			if (drop !== undefined)
				next = next.replace(new RegExp(` ${drop}="[^"]*"`, "u"), "");
			next = next.replace(open, `${open} ${attribute}="${escaped}"`);
			return `${xml.slice(0, from)}${next}${xml.slice(end + 1)}`;
		}
		from = xml.indexOf(open, end);
	}
	throw new Error(`No ${open} element holds ${marker}.`);
}

/** HQ's text, as an author wrote it, for each slot this test reads. */
const AUTHORED = {
	default: "/data/q1",
	rowPredicate:
		"count(instance('casedb')/casedb/case[@case_type = 'patient'][p = /data/r/k])",
	instant: "/data/dt1 > /data/dt1",
	rows: "instance('casedb')/casedb/case[@case_type = 'patient'][p = 'x']/p",
	count: "count(/data/r/k[. = 'x']) > 0",
	filter: "true() and p = 'x'",
	width: "instance('commcaresession')/session/context/window_width > 400",
} as const;

function authoredBody(doc: BlueprintDoc): Record<string, unknown> {
	return exportedBody(doc, {
		xml: (xml) => {
			let edited = setAttribute(
				xml,
				"<setvalue",
				'ref="/data/q2"',
				"value",
				AUTHORED.default,
			);
			edited = setAttribute(
				edited,
				"<bind",
				'nodeset="/data/r/c"',
				"calculate",
				AUTHORED.rowPredicate,
				"vellum:calculate",
			);
			edited = setAttribute(
				edited,
				"<bind",
				'nodeset="/data/d"',
				"calculate",
				AUTHORED.rows,
				"vellum:calculate",
			);
			edited = setAttribute(
				edited,
				"<bind",
				'nodeset="/data/dt2"',
				"relevant",
				AUTHORED.instant,
				"vellum:relevant",
			);
			return setAttribute(
				edited,
				"<bind",
				'nodeset="/data/checked"',
				"constraint",
				AUTHORED.count,
				"vellum:constraint",
			);
		},
		modules: (modules) => {
			const menu = modules[0] as Record<string, unknown>;
			menu.module_filter = AUTHORED.width;
			const details = menu.case_details as {
				short: Record<string, unknown>;
			};
			details.short.filter = AUTHORED.filter;
			return modules;
		},
	});
}

/** The tree a reading holds for the registration whose text is `text`. */
function heldFor(reading: EmissionReading, text: string) {
	const slot = reading.slots.find((one) => one.registration.text === text);
	if (slot === undefined) throw new Error(`Nothing registered ${text}.`);
	return {
		ref: slot.registration.ref,
		tree: slot.outcome.expression,
		claim: slot.outcome.claim,
	};
}

/** The tree a reading holds in the slot `key`, whatever its text. */
function heldAt(reading: EmissionReading, key: string): Expression | undefined {
	return reading.slots.find(
		(one) => expressionSlotKey(one.registration.ref) === key,
	)?.outcome.expression;
}

describe("a reading of an HQ author's text, written back and read again", () => {
	it("gives the same canonical tree in every slot", async () => {
		const doc = app();
		const first = await readBody(
			authoredBody(doc),
			doc,
			recordDialectRoundTrip,
		);
		const read = first.doc;
		if (read === undefined) throw new Error("The first reading bound nothing.");
		const second = await readEmission(read, recordDialectRoundTrip);
		for (const text of Object.values(AUTHORED)) {
			const { ref, tree, claim } = heldFor(first, text);
			expect(tree, `${text}: ${JSON.stringify(claim)}`).toBeDefined();
			if (tree === undefined) continue;
			const context = slotContext(read, ref, new Map());
			if (context === undefined) throw new Error(`No slot holds ${text}.`);
			expect(canonicalExpression(tree, context), text).toEqual(tree);
			expect(heldAt(second, expressionSlotKey(ref)), text).toEqual(tree);
		}
	});
});
