/**
 * The record dialect's round trip, as the reader of CommCare HQ's apps is
 * handed it. The contract: every record slot Nova itself writes, read back
 * from Nova's own export by the whole reader over the emitter's corpora, is
 * held and prints and reads back to itself under the slot's authoring scope,
 * so the judge refuses nothing Nova wrote; and a
 * tree the dialect has no spelling for is named by its kind, read from the
 * tree. The failures this catches: a held record slot the dialect cannot
 * print or reads back differently (which would fail every agent read of the
 * brought-in app), and a judge that answers an error's text in place of a
 * kind.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	corpusDocs,
	READ_BACK_CORPORA,
	readEmission,
} from "@/lib/commcare/reader/expressions/__tests__/readBackCorpus";
import { slotContext } from "@/lib/domain/expression/context";
import type { Expression } from "@/lib/domain/expression/types";
import type { Uuid } from "@/lib/domain/uuid";
import { recordDialectRoundTrip } from "../recordRoundTrip";

/** Documents per corpus; the five corpora take a few seconds on a laptop. */
const DOCS_PER_CORPUS = 30;

describe("the record dialect's round trip over what Nova writes", () => {
	it("holds every record slot the reader reads back from the corpora", {
		timeout: 120_000,
	}, async () => {
		let held = 0;
		for (const corpus of READ_BACK_CORPORA)
			for (const doc of corpusDocs(corpus, DOCS_PER_CORPUS)) {
				const reading = await readEmission(doc, recordDialectRoundTrip);
				const read = reading.doc;
				if (read === undefined) continue;
				for (const { registration, outcome } of reading.slots) {
					expect(
						outcome.claim?.detail.reason ?? "",
						outcome.claim?.entryId,
					).not.toMatch(/^dialect:/u);
					const tree = outcome.expression;
					if (tree === undefined) continue;
					if (
						slotContext(read, registration.ref, new Map())?.ruleSet !== "record"
					)
						continue;
					held++;
					expect(
						recordDialectRoundTrip(read, registration.ref, tree, new Map()),
						registration.ref.slot,
					).toBeUndefined();
				}
			}
		expect(held).toBeGreaterThan(0);
	});
});

describe("a tree the dialect has no spelling for", () => {
	it("is named by the kind of its unspelled node", () => {
		const doc = buildDoc({
			caseTypes: [{ name: "patient", properties: [{ name: "p", label: "P" }] }],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [f({ kind: "text", id: "q", label: "Q" })],
						},
					],
				},
			],
		});
		const menu = doc.moduleOrder[0] as Uuid;
		const query: Expression = {
			kind: "count",
			via: {
				kind: "cases",
				source: "casedb",
				where: [
					{
						kind: "eq",
						left: {
							kind: "term",
							term: { kind: "prop", caseType: "patient", property: "p" },
						},
						right: { kind: "term", term: { kind: "literal", value: "x" } },
					},
				],
			},
		};
		expect(
			recordDialectRoundTrip(
				doc,
				{ entity: "module", uuid: menu, slot: "module_display_condition" },
				{
					kind: "gt",
					left: query,
					right: { kind: "term", term: { kind: "literal", value: 0 } },
				},
				new Map(),
			),
		).toBe("cases");
	});
});
