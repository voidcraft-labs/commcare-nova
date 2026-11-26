// Tests what the Languages row's Mark as reviewed commits, through the real
// commit gate, for a translation whose source has since changed.
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import {
	collectTranslationUnits,
	localizeTranslationUnit,
	type ProseTemplate,
} from "@/lib/domain";
import { reviewTranslationMutation } from "../translationReviewModel";

const NAME = testUuid("review-name");
const GREET = testUuid("review-greet");

const greeting = (text: string, withName: boolean): ProseTemplate => ({
	parts: [
		{ kind: "text", text },
		...(withName ? [{ kind: "field-ref" as const, uuid: NAME }] : []),
	],
});

function commit(doc: BlueprintDoc, mutations: Mutation[]): BlueprintDoc {
	const verdict = mutationCommitVerdict(
		doc,
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	return verdict.nextDoc;
}

/** French "Bonjour {{name}}", made out of date by an English edit. */
function staleFrench(englishKeepsName: boolean): BlueprintDoc {
	const base = produce(
		buildDoc({
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								{ uuid: NAME, kind: "text", id: "name", label: "Name" },
								{
									uuid: GREET,
									kind: "label",
									id: "greet",
									label: greeting("Hello ", true),
								},
							],
						},
					],
				},
			],
		}),
		(draft) => {
			applyMutations(draft, [
				{ kind: "addLanguage", language: { language: "fra" }, wireCode: "fr" },
			]);
		},
	);
	const unit = greetUnit(base);
	const translated = commit(base, [
		{
			kind: "setTranslation",
			language: "fra",
			unitId: unit.id,
			entry: {
				value: greeting("Bonjour ", true),
				sourceFingerprint: unit.sourceFingerprint,
				origin: "human",
				review: "reviewed",
				translatedFrom: "eng",
			},
		},
	]);
	return commit(translated, [
		{
			kind: "updateField",
			uuid: GREET,
			targetKind: "label",
			patch: { label: greeting("Hello there ", englishKeepsName) },
		},
	]);
}

function greetUnit(doc: BlueprintDoc) {
	const unit = collectTranslationUnits(doc).find(
		(one) =>
			one.owner.kind === "field" &&
			one.owner.fieldUuid === GREET &&
			one.role === "field-label",
	);
	if (unit === undefined) throw new Error("Missing the greeting's unit.");
	return unit;
}

function reviewed(doc: BlueprintDoc) {
	const row = localizeTranslationUnit(doc, "fra", greetUnit(doc));
	expect(row.status).toBe("out-of-date");
	const mutation = reviewTranslationMutation(row, "eng");
	if (mutation === undefined) throw new Error("Nothing to review.");
	const after = commit(doc, [mutation]);
	return localizeTranslationUnit(after, "fra", greetUnit(after));
}

describe("Mark as reviewed on an out-of-date translation", () => {
	it("keeps the answer the source no longer shows, as a translation with its own values", () => {
		const row = reviewed(staleFrench(false));
		expect(row.status).toBe("ready");
		expect(row.explicit).toMatchObject({
			value: greeting("Bonjour ", true),
			valueMode: "independent-values",
			review: "reviewed",
		});
	});

	it("confirms an ordinary translation as it stands", () => {
		const row = reviewed(staleFrench(true));
		expect(row.status).toBe("ready");
		expect(row.explicit?.value).toEqual(greeting("Bonjour ", true));
		expect(row.explicit).not.toHaveProperty("valueMode");
	});
});
