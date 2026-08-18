import { describe, expect, it } from "vitest";
import { foldCanonicalAppChangeSuffixBounded } from "@/lib/db/canonicalMutationFold";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { applyMutations } from "@/lib/doc/mutations";
import { canonicalAppGenesis, emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	type LanguageIdentityRepairSource,
	type LanguageIdentitySourceChangeRow,
	languageIdentityPlanHasRewrites,
	mapOldLanguageCode,
	planLanguageIdentityRepair,
} from "../languageIdentityRepair";

const APP_ID = "app-language-repair";
const PROJECT_ID = "project-language-repair";
const UNIT_ID = "tu1:fixture-unit";

// The plan reads baseline snapshots through the strict persisted-JSON
// decoder, so the fixture baseline is the real sequence-one document: the
// canonical genesis reduced over the canonical empty Blueprint.
let cachedBaselineText: string | undefined;
function baselineText(): string {
	if (cachedBaselineText === undefined) {
		const doc = emptyBlueprintDoc(APP_ID);
		applyMutations(
			doc,
			canonicalAppGenesis(doc, "Language repair fixture").mutations,
		);
		cachedBaselineText = JSON.stringify(toPersistableDoc(doc));
	}
	return cachedBaselineText;
}

function sourceWith(
	overrides: Partial<LanguageIdentityRepairSource>,
): LanguageIdentityRepairSource {
	return {
		appId: APP_ID,
		appName: "Language repair fixture",
		projectId: PROJECT_ID,
		mutationSeq: 1,
		localizationText: null,
		changeRows: [],
		baselines: [
			{ seq: 1, projectId: PROJECT_ID, snapshotText: baselineText() },
		],
		attempts: [],
		batches: [],
		...overrides,
	};
}

function changeRow(
	seq: number,
	mutations: readonly unknown[],
): LanguageIdentitySourceChangeRow {
	return {
		seq,
		kind: "autosave",
		batchId: `batch-${seq}`,
		runId: null,
		actorId: "user-1",
		mutationsText: JSON.stringify(mutations),
		fromProjectId: null,
		toProjectId: null,
	};
}

function oldEnglish() {
	return { code: "en", name: "English", direction: "ltr" } as const;
}

function oldMexicanSpanish() {
	return {
		code: "es-mx",
		name: "Español de México",
		direction: "ltr",
	} as const;
}

describe("mapOldLanguageCode", () => {
	it("keeps a stored code that already spells a lawful canonical tag", () => {
		expect(mapOldLanguageCode("spa")).toEqual({
			kind: "canonical",
			tag: "spa",
		});
		expect(mapOldLanguageCode("cmn-Hans")).toEqual({
			kind: "canonical",
			tag: "cmn-Hans",
		});
	});

	it("resolves a two-letter alias to its Set 3 individual language", () => {
		expect(mapOldLanguageCode("fr")).toEqual({
			kind: "mechanical",
			identity: { language: "fra" },
			tag: "fra",
		});
	});

	it("resolves a macrolanguage alias to its predominant member", () => {
		expect(mapOldLanguageCode("sw")).toMatchObject({
			kind: "mechanical",
			tag: "swh",
		});
		expect(mapOldLanguageCode("ar")).toMatchObject({
			kind: "mechanical",
			tag: "arb",
		});
	});

	it("resolves the retired variety-alias spellings to their bare member", () => {
		expect(mapOldLanguageCode("zh-yue")).toEqual({
			kind: "mechanical",
			identity: { language: "yue" },
			tag: "yue",
		});
	});

	it("reads a two-letter suffix as the region", () => {
		expect(mapOldLanguageCode("es-mx")).toEqual({
			kind: "mechanical",
			identity: { language: "spa", region: "MX" },
			tag: "spa-MX",
		});
	});

	it("reads a four-letter suffix as the script", () => {
		expect(mapOldLanguageCode("zh-hans")).toEqual({
			kind: "mechanical",
			identity: { language: "cmn", script: "Hans" },
			tag: "cmn-Hans",
		});
		expect(mapOldLanguageCode("ks-arab")).toEqual({
			kind: "mechanical",
			identity: { language: "kas", script: "Arab" },
			tag: "kas-Arab",
		});
	});

	it("fails closed on more than one suffix segment", () => {
		const mapping = mapOldLanguageCode("zh-hans-cn");
		expect(mapping.kind).toBe("needs-explicit");
		if (mapping.kind === "needs-explicit") {
			expect(mapping.reason).toContain("more than one suffix segment");
		}
	});

	it("fails closed on a code no rule resolves", () => {
		const mapping = mapOldLanguageCode("xxx");
		expect(mapping.kind).toBe("needs-explicit");
		if (mapping.kind === "needs-explicit") {
			expect(mapping.reason).toContain("does not resolve");
		}
	});

	it("fails closed when the predominant member still needs a script", () => {
		const mapping = mapOldLanguageCode("zh");
		expect(mapping.kind).toBe("needs-explicit");
		if (mapping.kind === "needs-explicit") {
			expect(mapping.reason).toContain("written in more than one script");
		}
	});
});

describe("planLanguageIdentityRepair roots", () => {
	it("leaves a NULL root untouched as the canonical English-only spelling", () => {
		const plan = planLanguageIdentityRepair(sourceWith({}));
		expect(plan.rootAction).toBe("null");
		expect(plan.rootRewriteText).toBeNull();
		expect(languageIdentityPlanHasRewrites(plan)).toBe(false);
		expect(plan.blocked).toEqual([]);
		expect(plan.findings).toContainEqual({
			store: "root",
			ref: "root",
			classification: "informational",
			detail:
				"localization is NULL, the canonical English-only spelling; untouched",
		});
	});

	it("rewrites a sole-en root to the eng sentinel and drops its metadata", () => {
		const plan = planLanguageIdentityRepair(
			sourceWith({
				localizationText: JSON.stringify({
					sourceLanguage: "en",
					defaultLanguage: "en",
					languageOrder: ["en"],
					languages: { en: oldEnglish() },
					translations: {},
				}),
			}),
		);
		expect(plan.blocked).toEqual([]);
		expect(plan.neededMappings).toEqual([]);
		expect(plan.rootAction).toBe("rewrite");
		expect(plan.rootRewriteText).not.toBeNull();
		expect(JSON.parse(plan.rootRewriteText ?? "")).toEqual({
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng"],
			translations: {},
		});
		const dropped = plan.findings.filter(
			(finding) =>
				finding.classification === "informational" &&
				finding.detail.includes("is dropped"),
		);
		expect(dropped).toHaveLength(1);
		expect(dropped[0]?.detail).toContain('"English"');
	});

	it("re-keys an es-mx root preserving every overlay entry, review state, and origin", () => {
		const entry = {
			value: "Hola",
			sourceFingerprint: "fp-1",
			origin: "human",
			review: "reviewed",
			translatedFrom: "en",
		} as const;
		const plan = planLanguageIdentityRepair(
			sourceWith({
				localizationText: JSON.stringify({
					sourceLanguage: "en",
					defaultLanguage: "en",
					languageOrder: ["en", "es-mx"],
					languages: { en: oldEnglish(), "es-mx": oldMexicanSpanish() },
					translations: { "es-mx": { [UNIT_ID]: entry } },
				}),
			}),
		);
		expect(plan.blocked).toEqual([]);
		expect(plan.rootAction).toBe("rewrite");
		expect(JSON.parse(plan.rootRewriteText ?? "")).toEqual({
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "spa-MX"],
			translations: {
				"spa-MX": { [UNIT_ID]: { ...entry, translatedFrom: "eng" } },
			},
		});
	});

	it("plans no rewrite over its own rewritten root", () => {
		const first = planLanguageIdentityRepair(
			sourceWith({
				localizationText: JSON.stringify({
					sourceLanguage: "en",
					defaultLanguage: "en",
					languageOrder: ["en"],
					languages: { en: oldEnglish() },
					translations: {},
				}),
			}),
		);
		const second = planLanguageIdentityRepair(
			sourceWith({ localizationText: first.rootRewriteText }),
		);
		expect(second.rootAction).toBe("canonical");
		expect(languageIdentityPlanHasRewrites(second)).toBe(false);
		expect(second.blocked).toEqual([]);
		expect(second.neededMappings).toEqual([]);
	});

	it("refuses a code no rule decides and names it for the explicit table", () => {
		const plan = planLanguageIdentityRepair(
			sourceWith({
				localizationText: JSON.stringify({
					sourceLanguage: "en",
					defaultLanguage: "en",
					languageOrder: ["en", "zh"],
					languages: {
						en: oldEnglish(),
						zh: { code: "zh", name: "Chinese", direction: "ltr" },
					},
					translations: { zh: {} },
				}),
			}),
		);
		expect(plan.neededMappings).toEqual(["zh"]);
		expect(plan.rootRewriteText).toBeNull();
		expect(languageIdentityPlanHasRewrites(plan)).toBe(false);
		const refusal = plan.findings.find(
			(finding) => finding.classification === "needs-explicit-mapping",
		);
		expect(refusal?.detail.startsWith("zh:")).toBe(true);
	});

	it("blocks two stored languages that map to one identity", () => {
		const plan = planLanguageIdentityRepair(
			sourceWith({
				localizationText: JSON.stringify({
					sourceLanguage: "en",
					defaultLanguage: "en",
					languageOrder: ["en", "es", "spa"],
					languages: {
						en: oldEnglish(),
						es: { code: "es", name: "Spanish", direction: "ltr" },
						spa: { code: "spa", name: "Also Spanish", direction: "ltr" },
					},
					translations: { es: {}, spa: {} },
				}),
			}),
		);
		expect(plan.rootRewriteText).toBeNull();
		expect(
			plan.blocked.some((finding) =>
				finding.detail.includes("two stored languages both map to spa"),
			),
		).toBe(true);
	});
});

describe("planLanguageIdentityRepair change rows", () => {
	function oldShapeRows(): LanguageIdentitySourceChangeRow[] {
		return [
			changeRow(2, [{ kind: "addLanguage", language: oldMexicanSpanish() }]),
			changeRow(3, [
				{ kind: "updateLanguage", code: "en", patch: { name: "English (US)" } },
			]),
		];
	}

	it("rewrites old-shape rows, resolves the emptied batch, and the re-fold proof passes", () => {
		const plan = planLanguageIdentityRepair(
			sourceWith({ mutationSeq: 3, changeRows: oldShapeRows() }),
		);
		expect(plan.blocked).toEqual([]);
		expect(plan.neededMappings).toEqual([]);
		expect(plan.rowRewrites).toHaveLength(2);

		const [first, second] = plan.rowRewrites;
		expect(first?.seq).toBe(2);
		expect(first?.replacedEmptiedBatch).toBe(false);
		expect(JSON.parse(first?.mutationsText ?? "")).toEqual([
			{ kind: "addLanguage", language: { language: "spa", region: "MX" } },
		]);

		expect(second?.seq).toBe(3);
		expect(second?.replacedEmptiedBatch).toBe(true);
		expect(JSON.parse(second?.mutationsText ?? "")).toEqual([
			{ kind: "setDefaultLanguage", code: "eng" },
		]);
		expect(
			plan.findings.some((finding) =>
				finding.detail.includes(
					"updateLanguage for en is dropped; names and directions derive from the identity",
				),
			),
		).toBe(true);
		expect(
			plan.findings.some((finding) =>
				finding.detail.includes("replaced with setDefaultLanguage eng"),
			),
		).toBe(true);

		// The proof the executing transaction runs: replaying the rewritten
		// rows from the baseline reaches a canonical head document.
		const folded = foldCanonicalAppChangeSuffixBounded({
			baselineSnapshotText: baselineText(),
			baselineSeq: 1,
			baselineProjectId: PROJECT_ID,
			targetSeq: 3,
			suffix: oldShapeRows().map((row) => ({
				seq: row.seq,
				batch_id: row.batchId,
				run_id: row.runId,
				actor_id: row.actorId,
				kind: row.kind,
				mutationsText:
					plan.rowRewrites.find((rewrite) => rewrite.seq === row.seq)
						?.mutationsText ?? row.mutationsText,
				from_project_id: row.fromProjectId,
				to_project_id: row.toProjectId,
			})),
		});
		expect(folded.projectId).toBe(PROJECT_ID);
		expect(folded.snapshot.localization).toEqual({
			sourceLanguage: "eng",
			defaultLanguage: "eng",
			languageOrder: ["eng", "spa-MX"],
			translations: { "spa-MX": {} },
		});
	});

	it("plans no rewrite over its own rewritten rows", () => {
		const first = planLanguageIdentityRepair(
			sourceWith({ mutationSeq: 3, changeRows: oldShapeRows() }),
		);
		const rewritten = oldShapeRows().map((row) => ({
			...row,
			mutationsText:
				first.rowRewrites.find((rewrite) => rewrite.seq === row.seq)
					?.mutationsText ?? row.mutationsText,
		}));
		const second = planLanguageIdentityRepair(
			sourceWith({ mutationSeq: 3, changeRows: rewritten }),
		);
		expect(languageIdentityPlanHasRewrites(second)).toBe(false);
		expect(second.blocked).toEqual([]);
		expect(second.neededMappings).toEqual([]);
	});

	it("re-keys translation writes and their provenance", () => {
		const plan = planLanguageIdentityRepair(
			sourceWith({
				mutationSeq: 2,
				changeRows: [
					changeRow(2, [
						{
							kind: "setTranslation",
							language: "es-mx",
							unitId: UNIT_ID,
							entry: {
								value: "Hola",
								sourceFingerprint: "fp-1",
								origin: "ai",
								review: "needs-review",
								translatedFrom: "en",
							},
						},
					]),
				],
			}),
		);
		expect(plan.blocked).toEqual([]);
		expect(plan.rowRewrites).toHaveLength(1);
		expect(JSON.parse(plan.rowRewrites[0]?.mutationsText ?? "")).toEqual([
			{
				kind: "setTranslation",
				language: "spa-MX",
				unitId: UNIT_ID,
				entry: {
					value: "Hola",
					sourceFingerprint: "fp-1",
					origin: "ai",
					review: "needs-review",
					translatedFrom: "eng",
				},
			},
		]);
	});

	it("blocks an archived pre-baseline row that mentions a localization kind", () => {
		const plan = planLanguageIdentityRepair(
			sourceWith({
				mutationSeq: 5,
				baselines: [
					{ seq: 5, projectId: PROJECT_ID, snapshotText: baselineText() },
				],
				changeRows: [
					changeRow(3, [
						{ kind: "addLanguage", language: oldMexicanSpanish() },
					]),
				],
			}),
		);
		expect(
			plan.blocked.some((finding) =>
				finding.detail.includes(
					"archived pre-baseline row mentions addLanguage",
				),
			),
		).toBe(true);
	});

	it("blocks an app with no fold baseline as corrupt", () => {
		const plan = planLanguageIdentityRepair(sourceWith({ baselines: [] }));
		expect(
			plan.blocked.some((finding) =>
				finding.detail.includes("the app has no fold baseline"),
			),
		).toBe(true);
	});
});

describe("planLanguageIdentityRepair translation-batch state", () => {
	it("rewrites an old-shape intent and stamps the canonical digest", () => {
		const plan = planLanguageIdentityRepair(
			sourceWith({
				attempts: [
					{
						id: "attempt-1",
						intentDigest: "digest-of-the-old-shape",
						intentText: JSON.stringify({
							sourceLanguage: oldEnglish(),
							defaultLanguage: "en",
							targets: [
								{
									language: oldMexicanSpanish(),
									seedFrom: "en",
									strategy: "copy-only",
								},
							],
						}),
					},
				],
			}),
		);
		expect(plan.blocked).toEqual([]);
		expect(plan.attemptRewrites).toHaveLength(1);
		const rewrite = plan.attemptRewrites[0];
		const intent = JSON.parse(rewrite?.intentText ?? "");
		expect(intent).toEqual({
			sourceLanguage: { language: "eng" },
			defaultLanguage: { language: "eng" },
			targets: [
				{
					language: { language: "spa", region: "MX" },
					seedFrom: { language: "eng" },
					strategy: "copy-only",
				},
			],
		});
		expect(rewrite?.intentDigest).toBe(canonicalJsonDigest(intent));
	});

	it("blocks a canonical intent whose stored digest does not match", () => {
		const intent = {
			sourceLanguage: { language: "eng" },
			defaultLanguage: { language: "eng" },
			targets: [
				{
					language: { language: "spa", region: "MX" },
					seedFrom: { language: "eng" },
					strategy: "copy-only",
				},
			],
		};
		const plan = planLanguageIdentityRepair(
			sourceWith({
				attempts: [
					{
						id: "attempt-1",
						intentDigest: "not-the-canonical-digest",
						intentText: JSON.stringify(intent),
					},
				],
			}),
		);
		expect(
			plan.blocked.some((finding) =>
				finding.detail.includes("does not match its stored digest"),
			),
		).toBe(true);

		const clean = planLanguageIdentityRepair(
			sourceWith({
				attempts: [
					{
						id: "attempt-1",
						intentDigest: canonicalJsonDigest(intent),
						intentText: JSON.stringify(intent),
					},
				],
			}),
		);
		expect(clean.blocked).toEqual([]);
		expect(clean.attemptRewrites).toEqual([]);
	});

	it("re-keys batch language columns and leaves canonical ones alone", () => {
		const plan = planLanguageIdentityRepair(
			sourceWith({
				batches: [
					{
						id: "batch-old",
						attemptId: "attempt-1",
						sourceLanguage: "en",
						targetLanguage: "es-mx",
					},
					{
						id: "batch-new",
						attemptId: "attempt-1",
						sourceLanguage: "eng",
						targetLanguage: "spa-MX",
					},
				],
			}),
		);
		expect(plan.batchRewrites).toEqual([
			{ id: "batch-old", sourceLanguage: "eng", targetLanguage: "spa-MX" },
		]);
	});
});
