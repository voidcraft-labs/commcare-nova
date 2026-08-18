/** Post-slice localization finalizer for an accepted initial build. */

import { produce } from "immer";
import type { AppDesignContract } from "@/lib/agent/design/contract";
import type { SubGenerationUsageMeter } from "@/lib/agent/modelRunContext";
import { applyBlueprintChange } from "@/lib/db/applyBlueprintChange";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { applyMutations } from "@/lib/doc/mutations";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import {
	type AppLanguageIdentity,
	collectLocalizedTranslationUnits,
	collectTranslationUnits,
	effectiveAppLocalization,
	type LanguageTag,
	type LocalizedValue,
	languageTag,
	type PersistableDoc,
	translationValueIntegrityIssue,
} from "@/lib/domain";
import {
	languageDescriptor,
	resolvedLanguageEnglishName,
} from "@/lib/domain/languageRegistry/names";
import { MODEL_ROLES } from "@/lib/models";
import { automaticTranslationAvailable } from "@/lib/translation/capabilityPolicy";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	beginOrRecoverLocalizationAttempt,
	claimTranslationBatch,
	completeTranslationBatch,
	type DesignLocalizationAttempt,
	type DesignLocalizationAuthority,
	type DesignLocalizationLineage,
	type DesignLocalizationReceipt,
	type PersistedTranslationUsage,
	readLocalizationReceipt,
	readTerminalLocalizationBatchUsage,
} from "./store";
import {
	boundedGlossary,
	createProductionTranslationBatchRunner,
	glossaryEntriesFromAcceptedBatch,
	normalizeTranslationUsage,
	planTranslationBatches,
	TRANSLATION_PROMPT_VERSION,
	TRANSLATION_SCHEMA_VERSION,
	type TranslationBatchInput,
	type TranslationBatchRunner,
	type TranslationGlossaryEntry,
	translationLanguage,
	translationPromptPayload,
	validateTranslationBatchOutput,
} from "./translator";

export class LocalizationBuildError extends Error {
	readonly name = "LocalizationBuildError";
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

export interface InitialBuildLocalizationArgs {
	readonly lineage: DesignLocalizationLineage;
	readonly authority: DesignLocalizationAuthority;
	readonly contract: AppDesignContract;
	readonly sourceBlueprint: PersistableDoc;
	readonly sourceSeq: number;
	readonly meter: SubGenerationUsageMeter | undefined;
	readonly signal: AbortSignal;
	readonly onLanguage?: (args: {
		readonly languageTag: LanguageTag;
		readonly languageName: string;
		readonly batch: number;
		readonly batchCount: number;
	}) => void;
}

export interface InitialBuildLocalizationDeps {
	readonly runBatch: TranslationBatchRunner;
	readonly automaticTranslationAvailable: (
		source: AppLanguageIdentity,
		target: AppLanguageIdentity,
	) => boolean;
}

/** English qualified name for progress lines; total over validated contract
 * identities, with the prose descriptor as the defensive fallback. */
function progressLanguageName(identity: AppLanguageIdentity): string {
	return resolvedLanguageEnglishName(identity) ?? languageDescriptor(identity);
}

function meterUsage(
	meter: SubGenerationUsageMeter | undefined,
	batchId: string,
	modelId: string,
	usage: PersistedTranslationUsage | null,
): void {
	if (meter === undefined || usage === null) return;
	const opts = {
		model: modelId,
		phase: "translation" as const,
	};
	if (meter.trackDurable !== undefined) {
		meter.trackDurable({ translationBatchId: batchId }, usage, opts);
	} else {
		meter.track(usage, opts);
	}
}

async function meterPersistedAttemptUsage(
	meter: SubGenerationUsageMeter | undefined,
	attemptId: string,
): Promise<Set<string>> {
	const metered = new Set<string>();
	if (meter === undefined) return metered;
	for (const batch of await readTerminalLocalizationBatchUsage(attemptId)) {
		meterUsage(meter, batch.batchId, batch.modelId, batch.usage);
		metered.add(batch.batchId);
	}
	return metered;
}

function assertReceiptLineage(
	receipt: DesignLocalizationReceipt,
	args: InitialBuildLocalizationArgs,
	attempt: DesignLocalizationAttempt,
): void {
	if (
		receipt.attemptId !== attempt.id ||
		receipt.designSessionId !== args.lineage.designSessionId ||
		receipt.designRevisionId !== args.lineage.designRevisionId ||
		receipt.designRevisionDigest !== args.lineage.designRevisionDigest ||
		receipt.buildPlanId !== args.lineage.buildPlanId ||
		receipt.buildPlanDigest !== args.lineage.buildPlanDigest ||
		receipt.appId !== args.lineage.appId ||
		receipt.sourceSeq !== args.sourceSeq ||
		receipt.sourceSnapshotDigest !== attempt.sourceSnapshotDigest
	) {
		throw new Error(
			"The localization receipt does not match this accepted design and source snapshot.",
		);
	}
}

export function initialBuildHasLocalizationFinalizer(
	contract: AppDesignContract,
): boolean {
	const intent = contract.charter.localization;
	if (intent === undefined) return false;
	// An English-only intent resolves to the canonical absent-root state, so
	// there is nothing to commit.
	return !(
		languageTag(intent.sourceLanguage) === "eng" &&
		languageTag(intent.defaultLanguage) === "eng" &&
		intent.targets.length === 0
	);
}

function orderedTargets(
	intent: NonNullable<AppDesignContract["charter"]["localization"]>,
) {
	const remaining = [...intent.targets];
	const available = new Set<LanguageTag>([languageTag(intent.sourceLanguage)]);
	const ordered: typeof remaining = [];
	while (remaining.length > 0) {
		const index = remaining.findIndex((target) =>
			available.has(languageTag(target.seedFrom)),
		);
		if (index === -1) {
			throw new LocalizationBuildError(
				"localization-seed-cycle",
				"The accepted language copy dependencies do not reach the source language.",
			);
		}
		const [target] = remaining.splice(index, 1);
		if (target === undefined) continue;
		ordered.push(target);
		available.add(languageTag(target.language));
	}
	return ordered;
}

function applyToWorkingDoc(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): BlueprintDoc {
	return produce(doc, (draft) => {
		applyMutations(draft, mutations);
	});
}

export function buildInitialLocalizationMutations(args: {
	readonly sourceDoc: BlueprintDoc;
	readonly contract: AppDesignContract;
	readonly automaticValues: ReadonlyMap<
		LanguageTag,
		ReadonlyMap<string, LocalizedValue>
	>;
}): Mutation[] {
	const intent = args.contract.charter.localization;
	if (intent === undefined) return [];
	let working = args.sourceDoc;
	const mutations: Mutation[] = [];
	const append = (next: readonly Mutation[]) => {
		mutations.push(...next);
		working = applyToWorkingDoc(working, next);
	};
	// Contract languages are the accepted design's identity objects; the
	// document stores their tags, and every display fact derives from the
	// registry at read.
	const sourceTag = languageTag(intent.sourceLanguage);
	const current = effectiveAppLocalization(working.localization);
	if (current.languageOrder.length !== 1) {
		throw new LocalizationBuildError(
			"localization-source-not-pristine",
			"Initial-build localization requires the post-slice app to retain its single canonical source language until the finalizer commits.",
		);
	}
	if (current.sourceLanguage !== sourceTag) {
		append([
			{
				kind: "relabelSourceLanguage",
				language: structuredClone(intent.sourceLanguage),
			},
		]);
	}

	for (const target of orderedTargets(intent)) {
		const targetTag = languageTag(target.language);
		append([
			{ kind: "addLanguage", language: structuredClone(target.language) },
		]);
		const sourceUnits = collectTranslationUnits(working);
		const automatic = args.automaticValues.get(targetTag);
		const entries: Mutation[] = [];
		if (target.strategy === "translate-with-nova") {
			if (automatic === undefined || automatic.size !== sourceUnits.length) {
				throw new LocalizationBuildError(
					"translation-output-incomplete",
					`Nova did not produce a complete accepted translation for ${languageDescriptor(target.language)}.`,
				);
			}
			for (const unit of sourceUnits) {
				const value = automatic.get(unit.id);
				if (
					value === undefined ||
					translationValueIntegrityIssue(unit, value) !== undefined
				) {
					throw new LocalizationBuildError(
						"translation-output-invalid",
						`Nova produced an invalid translation for unit ${unit.id}.`,
					);
				}
				entries.push({
					kind: "setTranslation",
					language: targetTag,
					unitId: unit.id,
					entry: {
						value: structuredClone(value),
						sourceFingerprint: unit.sourceFingerprint,
						origin: "ai",
						review: "needs-review",
						translatedFrom: sourceTag,
					},
				});
			}
		} else {
			const seedTag = languageTag(target.seedFrom);
			for (const unit of collectLocalizedTranslationUnits(working, seedTag)) {
				entries.push({
					kind: "setTranslation",
					language: targetTag,
					unitId: unit.id,
					entry: {
						value: structuredClone(unit.effective),
						sourceFingerprint: unit.sourceFingerprint,
						origin: "copied",
						review: "needs-review",
						translatedFrom: seedTag,
					},
				});
			}
		}
		append(entries);
	}
	if (languageTag(intent.defaultLanguage) !== sourceTag) {
		append([
			{
				kind: "setDefaultLanguage",
				code: languageTag(intent.defaultLanguage),
			},
		]);
	}
	return mutations;
}

async function runOrRecoverBatch(args: {
	readonly attempt: DesignLocalizationAttempt;
	readonly authority: DesignLocalizationAuthority;
	readonly runner: TranslationBatchRunner;
	readonly input: TranslationBatchInput;
	readonly batchIndex: number;
	readonly meter: SubGenerationUsageMeter | undefined;
	readonly meteredBatchIds: Set<string>;
	readonly signal: AbortSignal;
}) {
	const payload = translationPromptPayload(args.input);
	// The claim binds the exact payload digest plus model, prompt, and schema
	// versions. A persisted claim whose payload spoke a different language
	// shape therefore never matches: recovery appends a replacement generation
	// at the same batch index and re-runs the translate fresh instead of
	// reusing the older generation's output.
	const spec = {
		batchIndex: args.batchIndex,
		sourceLanguage: languageTag(args.input.sourceLanguage.identity),
		targetLanguage: languageTag(args.input.targetLanguage.identity),
		unitIds: args.input.units.map((unit) => unit.unitId),
		inputDigest: canonicalJsonDigest(payload),
		modelId: MODEL_ROLES.translator.modelId,
		promptVersion: TRANSLATION_PROMPT_VERSION,
		schemaVersion: TRANSLATION_SCHEMA_VERSION,
	};
	let claimed = await claimTranslationBatch({
		attempt: args.attempt,
		authority: args.authority,
		spec,
		isReusableAcceptedOutput(output) {
			try {
				validateTranslationBatchOutput(args.input.units, output);
				return true;
			} catch {
				return false;
			}
		},
	});
	if (claimed.kind === "run") {
		const running = claimed;
		const result = await args.runner(args.input, args.signal);
		const usage = normalizeTranslationUsage(result.usage);
		if (result.object === null) {
			claimed = await completeTranslationBatch({
				attempt: args.attempt,
				authority: args.authority,
				batchId: running.id,
				claimToken: running.claimToken,
				result: {
					kind: "failed",
					failureCode:
						result.finishReason === "length"
							? "translation-output-truncated"
							: "translation-output-unparseable",
					usage,
				},
			});
		} else {
			let outputValid = true;
			try {
				validateTranslationBatchOutput(args.input.units, result.object);
			} catch {
				outputValid = false;
			}
			if (outputValid) {
				claimed = await completeTranslationBatch({
					attempt: args.attempt,
					authority: args.authority,
					batchId: running.id,
					claimToken: running.claimToken,
					result: { kind: "accepted", output: result.object, usage },
				});
			} else {
				claimed = await completeTranslationBatch({
					attempt: args.attempt,
					authority: args.authority,
					batchId: running.id,
					claimToken: running.claimToken,
					result: {
						kind: "failed",
						failureCode: "translation-output-invalid",
						usage,
					},
				});
			}
		}
	}
	if (claimed.kind === "run") {
		throw new Error(
			"Translation batch completion returned a nonterminal claim.",
		);
	}
	if (!args.meteredBatchIds.has(claimed.id)) {
		meterUsage(args.meter, claimed.id, claimed.modelId, claimed.usage);
		args.meteredBatchIds.add(claimed.id);
	}
	if (claimed.kind === "failed") {
		throw new LocalizationBuildError(
			claimed.failureCode,
			"Nova could not produce a complete, reference-safe translation for the accepted app. The untranslated source app remains intact and frozen for a retry.",
		);
	}
	return claimed.output;
}
/** Build and atomically commit every requested initial language. Returns null
 * only for a truly legacy-equivalent English-only intent. */
export async function finalizeInitialBuildLocalization(
	args: InitialBuildLocalizationArgs,
	deps: InitialBuildLocalizationDeps,
): Promise<DesignLocalizationReceipt | null> {
	if (!initialBuildHasLocalizationFinalizer(args.contract)) return null;
	const intent = args.contract.charter.localization;
	if (intent === undefined) return null;
	const priorReceipt = await readLocalizationReceipt(args.lineage.buildPlanId);
	if (priorReceipt !== null) {
		if (
			priorReceipt.designSessionId !== args.lineage.designSessionId ||
			priorReceipt.designRevisionId !== args.lineage.designRevisionId ||
			priorReceipt.designRevisionDigest !== args.lineage.designRevisionDigest ||
			priorReceipt.buildPlanDigest !== args.lineage.buildPlanDigest ||
			priorReceipt.appId !== args.lineage.appId ||
			priorReceipt.sourceSeq !== args.sourceSeq
		) {
			throw new Error(
				"The committed localization receipt does not match this accepted build lineage.",
			);
		}
		await meterPersistedAttemptUsage(args.meter, priorReceipt.attemptId);
		return priorReceipt;
	}
	for (const target of intent.targets) {
		if (
			target.strategy === "translate-with-nova" &&
			!deps.automaticTranslationAvailable(
				intent.sourceLanguage,
				target.language,
			)
		) {
			throw new LocalizationBuildError(
				"translation-direction-unavailable",
				`Automatic translation from ${languageDescriptor(intent.sourceLanguage)} to ${languageDescriptor(target.language)} is not available under Nova's exact-direction quality policy. Manual authoring and copy remain available.`,
			);
		}
	}
	const sourceSnapshotDigest = canonicalJsonDigest(args.sourceBlueprint);
	const attempt = await beginOrRecoverLocalizationAttempt({
		lineage: args.lineage,
		authority: args.authority,
		sourceSeq: args.sourceSeq,
		sourceSnapshotDigest,
		intent,
	});
	/* A replacement protocol generation may coexist with terminal batches from
	 * an older deployment. Re-offer all of them while the attempt is still
	 * running; the production meter deduplicates locally and the run-summary
	 * admission account deduplicates across processes. Lightweight meters do not
	 * implement that durable identity, so retain their historical terminal-only
	 * replay behavior. */
	const meteredBatchIds =
		args.meter?.trackDurable === undefined
			? new Set<string>()
			: await meterPersistedAttemptUsage(args.meter, attempt.id);
	if (attempt.status !== "running") {
		if (args.meter?.trackDurable === undefined) {
			await meterPersistedAttemptUsage(args.meter, attempt.id);
		}
		const receipt = await readLocalizationReceipt(args.lineage.buildPlanId);
		if (receipt === null) {
			throw new Error(
				"The localization attempt committed without its atomic receipt.",
			);
		}
		assertReceiptLineage(receipt, args, attempt);
		return receipt;
	}

	const sourceDoc = hydratePersistedBlueprint(args.sourceBlueprint);
	const units = collectTranslationUnits(sourceDoc);
	const batches = planTranslationBatches(units);
	const automaticValues = new Map<
		LanguageTag,
		ReadonlyMap<string, LocalizedValue>
	>();
	let globalBatchIndex = 0;
	if (intent.targets.length === 0) {
		args.onLanguage?.({
			languageTag: languageTag(intent.sourceLanguage),
			languageName: progressLanguageName(intent.sourceLanguage),
			batch: 1,
			batchCount: 1,
		});
	}
	for (const target of orderedTargets(intent)) {
		const targetTag = languageTag(target.language);
		const targetName = progressLanguageName(target.language);
		if (target.strategy !== "translate-with-nova") {
			args.onLanguage?.({
				languageTag: targetTag,
				languageName: targetName,
				batch: 1,
				batchCount: 1,
			});
			continue;
		}
		const values = new Map<string, LocalizedValue>();
		const glossary: TranslationGlossaryEntry[] = [];
		for (const [targetBatchIndex, unitsInBatch] of batches.entries()) {
			args.onLanguage?.({
				languageTag: targetTag,
				languageName: targetName,
				batch: targetBatchIndex + 1,
				batchCount: batches.length,
			});
			const input: TranslationBatchInput = {
				sourceLanguage: translationLanguage(intent.sourceLanguage),
				targetLanguage: translationLanguage(target.language),
				appObjective: args.contract.charter.objective,
				units: unitsInBatch,
				glossary: boundedGlossary(glossary),
			};
			const output = await runOrRecoverBatch({
				attempt,
				authority: args.authority,
				runner: deps.runBatch,
				input,
				batchIndex: globalBatchIndex,
				meter: args.meter,
				meteredBatchIds,
				signal: args.signal,
			});
			globalBatchIndex += 1;
			for (const [id, value] of validateTranslationBatchOutput(
				unitsInBatch,
				output,
			)) {
				values.set(id, value);
			}
			glossary.push(...glossaryEntriesFromAcceptedBatch(unitsInBatch, output));
		}
		automaticValues.set(targetTag, values);
	}

	const rawMutations = buildInitialLocalizationMutations({
		sourceDoc,
		contract: args.contract,
		automaticValues,
	});
	if (rawMutations.length === 0) {
		throw new LocalizationBuildError(
			"localization-empty-commit",
			"The accepted localization intent produced no canonical app change.",
		);
	}
	const mutations = admitMutationBatch(rawMutations);
	const receiptId = crypto.randomUUID();
	const batchId = `design-localization:${attempt.id}:${attempt.intentDigest}`;
	try {
		await applyBlueprintChange({
			appId: args.lineage.appId,
			userId: args.authority.actorUserId,
			expectedProjectId: args.authority.projectId,
			runId: args.authority.runId,
			chatRunHolder: {
				mode: "build",
				runId: args.authority.runId,
				nonce: args.authority.holderNonce,
				source: "chat",
			},
			batchId,
			kind: "chat",
			guard: { mutations },
			sidecars: [
				{
					kind: "commit-design-localization",
					attemptId: attempt.id,
					receiptId,
					designSessionId: attempt.designSessionId,
					designRevisionId: attempt.designRevisionId,
					designRevisionDigest: attempt.designRevisionDigest,
					buildPlanId: attempt.buildPlanId,
					buildPlanDigest: attempt.buildPlanDigest,
					sourceSeq: attempt.sourceSeq,
					sourceSnapshotDigest: attempt.sourceSnapshotDigest,
					intentDigest: attempt.intentDigest,
					mutationCount: mutations.length,
				},
			],
		});
	} catch (error) {
		const receipt = await readLocalizationReceipt(args.lineage.buildPlanId);
		if (receipt === null) throw error;
		assertReceiptLineage(receipt, args, attempt);
		return receipt;
	}
	const receipt = await readLocalizationReceipt(args.lineage.buildPlanId);
	if (receipt === null) {
		throw new Error(
			"The canonical localization batch committed without its atomic receipt.",
		);
	}
	assertReceiptLineage(receipt, args, attempt);
	return receipt;
}

export function productionInitialBuildLocalizationDeps(
	context: Parameters<typeof createProductionTranslationBatchRunner>[0],
): InitialBuildLocalizationDeps {
	return {
		runBatch: createProductionTranslationBatchRunner(context),
		automaticTranslationAvailable,
	};
}
