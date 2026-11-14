/**
 * `expressionEditorContextFor` as a function of its inputs, over a real
 * document.
 *
 * A prose slot holds any number of calculated values, and each one's editor
 * binds against its own stored tree, so two values of one label share a slot
 * and must not share a context. A context is built once per document
 * snapshot, slot and variant, so an unchanged part reads the one it had.
 *
 * Plausible failures: the cache keyed by slot alone hands the second value
 * the first's context (its stored tree as the binding hint), or a rebuilt
 * context on every call for the same part.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { proseText } from "@/lib/domain";
import type { ProseSlotRef } from "@/lib/domain/expression/types";
import { expressionEditorContextFor } from "../useXPathSlots";

const SUMMARY = testUuid("editor-context-summary");

function labelWithTwoValues() {
	return buildDoc({
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Round",
						type: "survey",
						fields: [
							f({ kind: "text", id: "name", label: proseText("Name") }),
							f({
								kind: "text",
								uuid: SUMMARY,
								id: "summary",
								label: {
									parts: [
										{ kind: "value", expression: "concat(#form/name, '!')" },
										{ kind: "text", text: " and " },
										{ kind: "value", expression: "string-length(#form/name)" },
									],
								},
							}),
						],
					},
				],
			},
		],
	});
}

const LABEL: ProseSlotRef = { entity: "field", uuid: SUMMARY, slot: "label" };

describe("one editor context per calculated value", () => {
	it("hands two values of one label their own contexts, each binding its own tree", () => {
		const doc = labelWithTwoValues();
		const label = doc.fields[SUMMARY];
		if (!("label" in label) || label.label === undefined)
			throw new Error("The summary has a label.");
		const [first, , second] = label.label.parts;
		if (first?.kind !== "value" || second?.kind !== "value")
			throw new Error("The label holds two values.");
		const one = expressionEditorContextFor(
			doc,
			LABEL,
			LOOKUP_CONTEXT_UNAVAILABLE,
			undefined,
			undefined,
			first.expression,
		);
		const two = expressionEditorContextFor(
			doc,
			LABEL,
			LOOKUP_CONTEXT_UNAVAILABLE,
			undefined,
			undefined,
			second.expression,
		);
		expect(one).toBeDefined();
		expect(two).toBeDefined();
		expect(one).not.toBe(two);
		expect(one?.scope.current).toBe(first.expression);
		expect(two?.scope.current).toBe(second.expression);
		expect(one?.slot).toEqual(LABEL);
		// The slot's own check is the editor's lint, and a value that gives one
		// answer passes it.
		expect(one?.check("concat(#form/name, '?')")).toEqual([]);
	});

	it("reads the context it built for an unchanged part again", () => {
		const doc = labelWithTwoValues();
		const label = doc.fields[SUMMARY];
		if (!("label" in label) || label.label?.parts[0]?.kind !== "value")
			throw new Error("The label opens with a value.");
		const current = label.label.parts[0].expression;
		const first = expressionEditorContextFor(
			doc,
			LABEL,
			LOOKUP_CONTEXT_UNAVAILABLE,
			undefined,
			undefined,
			current,
		);
		expect(
			expressionEditorContextFor(
				doc,
				LABEL,
				LOOKUP_CONTEXT_UNAVAILABLE,
				undefined,
				undefined,
				current,
			),
		).toBe(first);
		// A new value, with no tree yet, is a variant of its own.
		const fresh = expressionEditorContextFor(
			doc,
			LABEL,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(fresh).not.toBe(first);
		expect(fresh?.scope.current).toBeUndefined();
	});
});
