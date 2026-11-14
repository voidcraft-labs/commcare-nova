/**
 * A calculated value in a text, at the commit gate.
 *
 * A value part is checked by its prose slot's own profile: form rules and one
 * scalar, in the context a reference of the same text is checked in. The
 * findings belong to the text, so the builder places them there.
 *
 * Plausible failures: a value that reads every entry of a repeat admitted
 * (Core would print one entry or stop the form), a finding reported on an
 * expression slot instead of the text, or a valid value refused.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import type { ValidationError } from "../errors";

const ids = {
	form: testUuid("prose-value-gate-form"),
	summary: testUuid("prose-value-gate-summary"),
};

/** A survey whose summary question's label shows `formula`, its hint
 *  `hint`, beside a repeat of visits. */
function surveyWith(formula: string, hint?: string): BlueprintDoc {
	return buildDoc({
		appName: "Visits",
		modules: [
			{
				name: "Visits",
				forms: [
					{
						uuid: ids.form,
						name: "Round",
						type: "survey",
						fields: [
							f({ kind: "text", id: "name", label: proseText("Name") }),
							f({
								kind: "repeat",
								id: "visits",
								repeat_mode: "user_controlled",
								label: proseText("Visits"),
								children: [
									f({ kind: "text", id: "note", label: proseText("Note") }),
								],
							}),
							f({
								kind: "text",
								uuid: ids.summary,
								id: "summary",
								label: {
									parts: [
										{ kind: "text", text: "Seen: " },
										{ kind: "value", expression: formula },
									],
								},
								...(hint === undefined
									? {}
									: { hint: { parts: [{ kind: "value", expression: hint }] } }),
							}),
						],
					},
				],
			},
		],
	});
}

function findings(doc: BlueprintDoc): ValidationError[] {
	const verdict = mutationCommitVerdict(doc, [], LOOKUP_CONTEXT_UNAVAILABLE);
	return verdict.ok ? [] : verdict.findings;
}

describe("a calculated value at the commit gate", () => {
	it("admits a value that gives one value", () => {
		expect(findings(surveyWith("concat(#form/name, ' seen')"))).toEqual([]);
	});

	it("refuses a value that reads every entry of a repeat, on the text that holds it", () => {
		const [finding, ...rest] = findings(
			surveyWith("concat(#form/visits/note, ' seen')"),
		);
		expect(rest).toEqual([]);
		expect(finding?.code).toBe("XPATH_MANY_VALUES");
		expect(finding?.location).toMatchObject({
			formUuid: ids.form,
			fieldUuid: ids.summary,
			fieldId: "summary",
			field: "label",
		});
	});

	it("reports each text's finding under that text", () => {
		const found = findings(
			surveyWith(
				"concat(#form/name, ' seen')",
				"count(#form/visits/note) + #form/visits/note",
			),
		);
		expect(found.map((finding) => finding.location?.field)).toEqual(["hint"]);
		expect(found[0]?.code).toBe("XPATH_MANY_VALUES");
	});
});
