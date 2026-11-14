// A select holds one option or more. The plausible failure is a path that
// still refuses the one-option state (the mutation grammar, the reducer's
// reconcile on a conversion, or a rule at the commit gate) while the stored
// schema admits it, or a path that lets a select reach zero options.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { type Mutation, mutationSchema } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { assertAdmittedDoc } from "./admittedDoc";

const SELECT = testUuid("select-count-select");
const NOTE = testUuid("select-count-note");
const RED = testUuid("select-count-red");
const GREEN = testUuid("select-count-green");
const AGREE = testUuid("select-count-agree");

function fixture(): BlueprintDoc {
	const doc = buildDoc({
		modules: [
			{
				name: "Consent",
				forms: [
					{
						name: "Consent visit",
						type: "survey",
						fields: [
							f({
								uuid: SELECT,
								kind: "single_select",
								id: "color",
								label: proseText("Color"),
								optionsSource: {
									kind: "inline",
									options: [
										{ uuid: RED, value: "red", label: proseText("Red") },
										{ uuid: GREEN, value: "green", label: proseText("Green") },
									],
								},
							}),
							f({
								uuid: NOTE,
								kind: "text",
								id: "read_aloud",
								label: proseText("Read this to the client"),
							}),
						],
					},
				],
			},
		],
	});
	assertAdmittedDoc(doc);
	return doc;
}

/** The exact batch through the wire grammar, then the reducer and the gate. */
function commit(doc: BlueprintDoc, batch: Mutation[]) {
	const parsed = batch.map((mutation) => mutationSchema.parse(mutation));
	return mutationCommitVerdict(doc, parsed, LOOKUP_CONTEXT_UNAVAILABLE);
}

function inlineValues(doc: BlueprintDoc, uuid: string): string[] {
	const field = doc.fields[uuid as keyof typeof doc.fields];
	if (
		field === undefined ||
		(field.kind !== "single_select" && field.kind !== "multi_select") ||
		field.optionsSource.kind !== "inline"
	) {
		throw new Error("expected an inline select");
	}
	return field.optionsSource.options.map((option) => option.value);
}

describe("a select's option count", () => {
	it("commits a removal that leaves one option", () => {
		const verdict = commit(fixture(), [
			{ kind: "removeOption", fieldUuid: SELECT, uuid: RED },
		]);
		expect(verdict.ok ? [] : verdict.findings).toEqual([]);
		if (!verdict.ok) return;
		expect(inlineValues(verdict.nextDoc, SELECT)).toEqual(["green"]);
	});

	it("refuses a removal that leaves no option with SELECT_NO_OPTIONS", () => {
		const verdict = commit(fixture(), [
			{ kind: "removeOption", fieldUuid: SELECT, uuid: RED },
			{ kind: "removeOption", fieldUuid: SELECT, uuid: GREEN },
		]);
		expect(verdict.ok).toBe(false);
		if (verdict.ok) return;
		expect(verdict.findings.map((finding) => finding.code)).toEqual([
			"SELECT_NO_OPTIONS",
		]);
	});

	it("commits a conversion into a select seeded with one option", () => {
		const verdict = commit(fixture(), [
			{
				kind: "convertField",
				uuid: NOTE,
				toKind: "single_select",
				optionsSource: {
					kind: "inline",
					options: [
						{
							uuid: AGREE,
							value: "read",
							label: proseText("I have read this to the client"),
						},
					],
				},
			},
		]);
		expect(verdict.ok ? [] : verdict.findings).toEqual([]);
		if (!verdict.ok) return;
		expect(verdict.nextDoc.fields[NOTE]?.kind).toBe("single_select");
		expect(inlineValues(verdict.nextDoc, NOTE)).toEqual(["read"]);
	});

	it("refuses a conversion seed with no option at the mutation grammar", () => {
		expect(
			mutationSchema.safeParse({
				kind: "convertField",
				uuid: NOTE,
				toKind: "single_select",
				optionsSource: { kind: "inline", options: [] },
			}).success,
		).toBe(false);
	});
});
