/**
 * A question's translation that shows its own answers or calculations
 * (`valueMode: "independent-values"`), through the real commit gate.
 *
 * The Spanish label of `greet` reads the answer to `name`, which the English
 * label does not. The translation's reference lives in the app's overlay,
 * but it is a reference of `greet` all the same: the gate checks it at that
 * question, the index protects what it reads, an identity-preserving rename
 * or move keeps it current, and Preview shows it to a Spanish worker.
 *
 * Plausible failures: the overlay's reference left out of the index (so the
 * answer it reads can be deleted under it), a read of another form's answer
 * admitted because the source label never holds it, an index that diverges
 * from a fresh build when the language goes away or becomes the source, or
 * a Preview that evaluates the source label's references in every language.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import { buildReferenceIndex } from "@/lib/doc/referenceIndex";
import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	collectTranslationUnits,
	localizeTranslationUnit,
	type ProseTemplate,
	type TranslationUnit,
	type Uuid,
} from "@/lib/domain";
import { projectProseTemplate } from "@/lib/domain/prose";
import { buildEngineInput } from "@/lib/preview/engine/engineInput";
import { FormEngine } from "@/lib/preview/engine/formEngine";

const MODULE = testUuid("independent-module");
const FORM = testUuid("independent-form");
const OTHER_FORM = testUuid("independent-other-form");
const NAME = testUuid("independent-name");
const GREET = testUuid("independent-greet");
const GROUP = testUuid("independent-group");
const ELSEWHERE = testUuid("independent-elsewhere");

function fixture(): BlueprintDoc {
	const doc = buildDoc({
		modules: [
			{
				uuid: MODULE,
				name: "Visits",
				forms: [
					{
						uuid: FORM,
						name: "Visit",
						type: "survey",
						fields: [
							{ uuid: NAME, kind: "text", id: "name", label: "Name" },
							{ uuid: GREET, kind: "label", id: "greet", label: "Hello" },
							{
								uuid: GROUP,
								kind: "group",
								id: "more",
								label: "More",
								children: [],
							},
						],
					},
					{
						uuid: OTHER_FORM,
						name: "Other",
						type: "survey",
						fields: [
							{
								uuid: ELSEWHERE,
								kind: "text",
								id: "elsewhere",
								label: "Elsewhere",
							},
						],
					},
				],
			},
		],
	});
	return produce(doc, (draft) => {
		applyMutations(draft, [
			{ kind: "addLanguage", language: { language: "spa" }, wireCode: "es" },
		]);
	});
}

function greetLabel(doc: BlueprintDoc): TranslationUnit {
	const unit = collectTranslationUnits(doc).find(
		(one) =>
			one.owner.kind === "field" &&
			one.owner.fieldUuid === GREET &&
			one.role === "field-label",
	);
	if (unit === undefined) throw new Error("Missing the greet label's unit.");
	return unit;
}

const reads = (uuid: Uuid): ProseTemplate => ({
	parts: [
		{ kind: "text", text: "Hola " },
		{ kind: "field-ref", uuid },
	],
});

function spanish(doc: BlueprintDoc, value: ProseTemplate): Mutation {
	const unit = greetLabel(doc);
	return {
		kind: "setTranslation",
		language: "spa",
		unitId: unit.id,
		entry: {
			value,
			valueMode: "independent-values",
			sourceFingerprint: unit.sourceFingerprint,
			origin: "human",
			review: "reviewed",
			translatedFrom: "eng",
		},
	};
}

/** `mutations` committed through the gate, the index held to a fresh build. */
function commit(doc: BlueprintDoc, mutations: Mutation[]): BlueprintDoc {
	const verdict = mutationCommitVerdict(
		doc,
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	if (!verdict.ok) throw new Error("Refused.");
	expect(verdict.nextDoc.refIndex).toEqual(
		buildReferenceIndex(verdict.nextDoc),
	);
	return verdict.nextDoc;
}

function refused(doc: BlueprintDoc, mutations: Mutation[]): boolean {
	return !mutationCommitVerdict(doc, mutations, LOOKUP_CONTEXT_UNAVAILABLE).ok;
}

function withSpanishReadingName(): BlueprintDoc {
	const doc = fixture();
	return commit(doc, [spanish(doc, reads(NAME))]);
}

const removeName: Mutation = { kind: "removeField", uuid: NAME };

describe("a translation that shows its own answers", () => {
	it("protects the answer only the translation reads, until its language goes away", () => {
		const plain = fixture();
		expect(refused(plain, [removeName])).toBe(false);
		const doc = withSpanishReadingName();
		expect(refused(doc, [removeName])).toBe(true);
		const withoutSpanish = commit(doc, [
			{ kind: "removeLanguage", code: "spa" },
		]);
		expect(refused(withoutSpanish, [removeName])).toBe(false);
	});

	it("refuses a read of another form's answer with the rest of its batch", () => {
		const doc = fixture();
		const verdict = mutationCommitVerdict(
			doc,
			[
				{ kind: "setAppName", name: "Renamed visits" },
				spanish(doc, reads(ELSEWHERE)),
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok).toBe(false);
		expect(doc.appName).not.toBe("Renamed visits");
	});

	it("stays current, without review, when the answer it reads is renamed and moved", () => {
		const doc = withSpanishReadingName();
		const renamed = commit(doc, [
			{
				kind: "updateField",
				uuid: NAME,
				targetKind: "text",
				patch: { id: "full_name" },
			},
			{ kind: "moveField", uuid: NAME, toParentUuid: GROUP, after: null },
		]);
		const row = localizeTranslationUnit(renamed, "spa", greetLabel(renamed));
		expect(row.status).toBe("ready");
		expect(row.explicit?.review).toBe("reviewed");
		expect(row.explicit?.valueMode).toBe("independent-values");
		const effective = row.effective;
		if (typeof effective === "string") throw new Error("Expected prose.");
		expect(projectProseTemplate(effective, renamed).text).toContain(
			"full_name",
		);
		expect(refused(renamed, [removeName])).toBe(true);
	});

	it("goes out of date when its source changes, and the stale reference no longer protects", () => {
		const doc = withSpanishReadingName();
		const edited = commit(doc, [
			{
				kind: "updateField",
				uuid: GREET,
				targetKind: "label",
				patch: { label: { parts: [{ kind: "text", text: "Welcome" }] } },
			},
		]);
		expect(
			localizeTranslationUnit(edited, "spa", greetLabel(edited)).status,
		).toBe("out-of-date");
		expect(refused(edited, [removeName])).toBe(false);
	});

	it("keeps both languages' values when Spanish becomes the source", () => {
		const doc = withSpanishReadingName();
		const rebased = commit(doc, [
			{ kind: "rebaseSourceLanguage", from: "eng", to: "spa" },
		]);
		const greet = rebased.fields[GREET];
		expect(greet !== undefined && "label" in greet && greet.label).toEqual(
			reads(NAME),
		);
		const english = localizeTranslationUnit(
			rebased,
			"eng",
			greetLabel(rebased),
		);
		expect(english.status).toBe("ready");
		expect(english.explicit?.valueMode).toBe("independent-values");
		expect(english.effective).toEqual({
			parts: [{ kind: "text", text: "Hello" }],
		});
	});

	it("is what Preview shows a Spanish worker, and only a Spanish worker", () => {
		const doc = withSpanishReadingName();
		const engineIn = (language: "spa" | "eng") => {
			const input = buildEngineInput(doc, FORM, language);
			if (input === undefined) throw new Error("No engine input.");
			const engine = new FormEngine(input);
			engine.setValue("/data/name", "Ana");
			return engine.getState("/data/greet").resolvedLabel;
		};
		expect(engineIn("spa")).toBe("Hola Ana");
		// The English label reads nothing: the engine leaves its text as written.
		expect(engineIn("eng")).toBeUndefined();
	});
});
