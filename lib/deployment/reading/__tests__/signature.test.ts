/**
 * The signature of a difference holds no word of any app.
 *
 * Contract: for two documents whose every name, id, label, choice value and
 * case type is a random sentinel, no signature `differenceSignature` makes
 * from any difference `documentDifferences` reports between them holds a
 * sentinel; every signature is at most 80 characters, cut at a whole
 * segment, and begins with a member of `ACCEPTANCE_CHECKS` or of
 * `HQ_CHANGE_PLAN_CHECKS`; and `documentPathKinds` keeps the document
 * schema's own property names and drops every record key.
 *
 * Plausible failures: an app's words in a log line or a Sentry issue title;
 * a signature under a check that does not exist.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { documentDifferences } from "@/lib/doc/documentDifferences";
import type { BlueprintDoc } from "@/lib/domain";
import { HQ_CHANGE_PLAN_CHECKS } from "../../hqChanges/plan";
import { ACCEPTANCE_CHECKS } from "../acceptance";
import {
	DOCUMENT_SCHEMA_KEYS,
	differenceSignature,
	documentPathKinds,
	SIGNATURE_MAX_LENGTH,
} from "../signature";

const CHECKS = [...ACCEPTANCE_CHECKS, ...HQ_CHANGE_PLAN_CHECKS] as const;

/** A sentinel no schema word holds: `zq` then twelve lowercase letters. */
const sentinel = fc
	.string({
		unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"),
		minLength: 12,
		maxLength: 12,
	})
	.map((letters) => `zq${letters}`);

const words = fc.uniqueArray(sentinel, { minLength: 8, maxLength: 8 });

/** A document whose every word of an app is one of `w`. */
function sentinelDoc(w: readonly string[]): BlueprintDoc {
	const [app, menu, form, caseType, q1, q2, choice, label] = w as [
		string,
		string,
		string,
		string,
		string,
		string,
		string,
		string,
	];
	return buildDoc({
		appId: `${app}-id`,
		appName: app,
		modules: [
			{
				name: menu,
				caseType,
				forms: [
					{
						name: form,
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: q1,
								label,
								caseWrite: { caseType, property: "case_name" },
							}),
							f({
								kind: "single_select",
								id: q2,
								label: q2,
								options: [{ value: choice, label: choice }],
							}),
						],
					},
				],
			},
		],
	});
}

describe("differenceSignature", () => {
	it("holds no sentinel of either document, in any check", () => {
		fc.assert(
			fc.property(words, words, (left, right) => {
				const differences = documentDifferences(
					sentinelDoc(left),
					sentinelDoc(right),
				);
				expect(differences.length).toBeGreaterThan(0);
				for (const difference of differences)
					for (const check of CHECKS) {
						const signature = differenceSignature(
							check,
							documentPathKinds(difference.path),
						);
						for (const word of [...left, ...right])
							expect(signature).not.toContain(word);
					}
			}),
			{ numRuns: 25 },
		);
	});

	it("cuts at a whole segment within 80 characters, and begins with its check", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...CHECKS),
				fc.array(
					fc.constantFrom(
						"question",
						"relevant",
						"caseListConfig",
						"a-very-long-segment-word",
					),
					{
						maxLength: 12,
					},
				),
				(check, segments) => {
					const signature = differenceSignature(check, segments);
					expect(signature.length).toBeLessThanOrEqual(SIGNATURE_MAX_LENGTH);
					const [first, ...rest] = signature.split("/");
					expect(CHECKS).toContain(first);
					expect(rest).toEqual(segments.slice(0, rest.length));
				},
			),
		);
	});
});

describe("documentPathKinds", () => {
	it("names the top-level key in its own word and keeps only the schema's property names", () => {
		expect(
			documentPathKinds([
				"modules",
				"0b6f1a8e-2c55-4f3e-9d42-7a1c3e5b9f10",
				"caseListConfig",
				"columns",
				"3",
				"header",
			]),
		).toEqual(["menu", "caseListConfig", "columns", "header"]);
		expect(
			documentPathKinds([
				"forms",
				"2b6f1a8e-2c55-4f3e-9d42-7a1c3e5b9f10",
				"postSubmit",
			]),
		).toEqual(["form", "postSubmit"]);
		expect(
			documentPathKinds(["localization", "translations", "en", "tu1:5:field"]),
		).toEqual(["translations", "translations"]);
	});

	it("collects the document schema's property names, at every depth", () => {
		for (const key of [
			"modules",
			"caseListConfig",
			"postSubmit",
			"relevant",
			"optionsSource",
		])
			expect(DOCUMENT_SCHEMA_KEYS.has(key)).toBe(true);
	});
});
