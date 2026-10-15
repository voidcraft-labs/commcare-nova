import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import {
	addLanguageMutation,
	heldLanguageWireCodes,
	relabelSourceLanguageMutation,
} from "@/lib/doc/languageMutations";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	type Mutation,
	mutationSchema,
} from "@/lib/doc/types";
import { type AppLanguageIdentity, proseText } from "@/lib/domain";
import { assertAdmittedDoc } from "./admittedDoc";

const SIMPLIFIED: AppLanguageIdentity = { language: "cmn", script: "Hans" };
const TRADITIONAL: AppLanguageIdentity = { language: "cmn", script: "Hant" };

function fixture(): BlueprintDoc {
	const doc = buildDoc({
		appId: "language-mutations",
		appName: "Clinic",
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [{ kind: "text", id: "notes", label: proseText("Notes") }],
					},
				],
			},
		],
	});
	assertAdmittedDoc(doc);
	return doc;
}

/** Commit through the wire schema, admission and the reducer. */
function commit(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): BlueprintDoc {
	const wire = mutations.map((mutation) =>
		mutationSchema.parse(JSON.parse(JSON.stringify(mutation))),
	);
	const verdict = mutationCommitVerdict(doc, wire, LOOKUP_CONTEXT_UNAVAILABLE);
	expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	return verdict.nextDoc;
}

function add(doc: BlueprintDoc, identity: AppLanguageIdentity): BlueprintDoc {
	return commit(doc, [
		addLanguageMutation(heldLanguageWireCodes(doc), identity),
	]);
}

describe("the language mutation planner", () => {
	it("reads English alone as holding en", () => {
		expect(heldLanguageWireCodes(fixture())).toEqual(new Set(["en"]));
	});

	it("leaves the first code alone and suffixes a second language that prefers it", () => {
		const simplified = add(fixture(), SIMPLIFIED);
		expect(simplified.localization?.wireCodes).toEqual({
			eng: "en",
			"cmn-Hans": "zho",
		});
		const both = add(simplified, TRADITIONAL);
		expect(both.localization?.wireCodes).toEqual({
			eng: "en",
			"cmn-Hans": "zho",
			"cmn-Hant": "cmn-hant",
		});
	});

	it("removing either language leaves the other's code", () => {
		const both = add(add(fixture(), SIMPLIFIED), TRADITIONAL);
		expect(
			commit(both, [{ kind: "removeLanguage", code: "cmn-Hans" }]).localization
				?.wireCodes,
		).toEqual({ eng: "en", "cmn-Hant": "cmn-hant" });
		expect(
			commit(both, [{ kind: "removeLanguage", code: "cmn-Hant" }]).localization
				?.wireCodes,
		).toEqual({ eng: "en", "cmn-Hans": "zho" });
	});

	it("gives two adds built for one batch distinct codes", () => {
		const doc = fixture();
		const held = heldLanguageWireCodes(doc);
		const first = addLanguageMutation(held, SIMPLIFIED);
		held.add(first.wireCode);
		const second = addLanguageMutation(held, TRADITIONAL);
		expect([first.wireCode, second.wireCode]).toEqual(["zho", "cmn-hant"]);
		expect(commit(doc, [first, second]).localization?.wireCodes).toEqual({
			eng: "en",
			"cmn-Hans": "zho",
			"cmn-Hant": "cmn-hant",
		});
		// Built against the same set, the second carries the first's code, and
		// the batch is refused.
		const unaware = addLanguageMutation(
			heldLanguageWireCodes(doc),
			TRADITIONAL,
		);
		expect(
			mutationCommitVerdict(doc, [first, unaware], LOOKUP_CONTEXT_UNAVAILABLE)
				.ok,
		).toBe(false);
	});

	it("mints a replacement against codes that still hold the language it replaces", () => {
		const simplified = add(fixture(), SIMPLIFIED);
		const next = commit(simplified, [
			addLanguageMutation(heldLanguageWireCodes(simplified), TRADITIONAL),
			{ kind: "removeLanguage", code: "cmn-Hans" },
		]);
		expect(next.localization?.wireCodes).toEqual({
			eng: "en",
			"cmn-Hant": "cmn-hant",
		});
	});

	it("relabels the sole language under its preferred spelling", () => {
		const mutation = relabelSourceLanguageMutation(SIMPLIFIED);
		expect(mutation.wireCode).toBe("zho");
		expect(commit(fixture(), [mutation]).localization).toEqual({
			sourceLanguage: "cmn-Hans",
			defaultLanguage: "cmn-Hans",
			languageOrder: ["cmn-Hans"],
			translations: {},
			wireCodes: { "cmn-Hans": "zho" },
		});
	});
});
