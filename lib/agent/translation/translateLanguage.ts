import "server-only";
import type { ArchitectLoopArgs } from "@/lib/agent/build/architectLoop";
import { runArchitectLoop } from "@/lib/agent/build/architectLoop";
import type { DesignModelContextSpec } from "@/lib/agent/build/modelContextStore";
import { strictStructuredSchema } from "@/lib/agent/strictStructuredOutput";
import {
	guardedMutate,
	type MutatingToolResult,
} from "@/lib/agent/tools/common";
import type { ToolInvocationContext } from "@/lib/agent/workspace/types";
import type { Mutation } from "@/lib/doc/types";
import {
	type AppLanguageIdentity,
	collectTranslationUnits,
	effectiveAppLocalization,
	languageTag,
	localizeTranslationUnit,
	parseLanguageTag,
} from "@/lib/domain";
import { MODEL_ROLES } from "@/lib/models";
import { automaticTranslationCapability } from "@/lib/translation/capabilityPolicy";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	boundedGlossary,
	glossaryEntriesFromAcceptedBatch,
	planTranslationBatches,
	TRANSLATION_MAX_OUTPUT_TOKENS,
	TRANSLATION_SYSTEM,
	type TranslationBatchOutput,
	type TranslationGlossaryEntry,
	translationBatchOutputSchema,
	translationLanguage,
	translationPromptPayload,
	validateTranslationBatchOutput,
} from "./translator";

export const TRANSLATION_MAX_STEPS = 3;

type TranslationResult =
	| {
			ok: true;
			language: AppLanguageIdentity;
			translated: number;
			review: "needs-review";
	  }
	| { error: string };

export interface TranslationRun
	extends Pick<
		ArchitectLoopArgs,
		"signal" | "modelStep" | "onStep" | "onRecoveredUsage"
	> {
	readonly designSessionId: string;
	readonly authority: DesignModelContextSpec["authority"];
}

function outputError(error: unknown): string {
	return error instanceof Error
		? error.message.slice(0, 1500)
		: "Invalid translation output.";
}

/** Translate an explicit request against the invocation's current document.
 * Each bounded batch reuses the model response ledger; the workspace commits
 * all validated values and the tool result together. Interrupted calls never
 * publish a partially translated language or purchase accepted batches again. */
export async function translateLanguage(
	ctx: ToolInvocationContext,
	target: AppLanguageIdentity,
	run: TranslationRun,
): Promise<MutatingToolResult<TranslationResult>> {
	const doc = ctx.snapshot.doc;
	const localization = effectiveAppLocalization(doc.localization);
	const source = parseLanguageTag(localization.sourceLanguage);
	const capability = automaticTranslationCapability(source, target);
	if (capability.status !== "available")
		return {
			kind: "mutate",
			mutations: [],
			result: { error: capability.explanation },
		};
	const tag = languageTag(target);
	const exists = localization.languageOrder.includes(tag);
	const units = collectTranslationUnits(doc).filter((unit) => {
		if (!exists) return true;
		const localized = localizeTranslationUnit(doc, tag, unit);
		return (
			localized.status === "missing" ||
			localized.status === "out-of-date" ||
			(localized.explicit?.origin === "copied" && localized.status !== "ready")
		);
	});
	const mutations: Mutation[] = exists
		? []
		: [{ kind: "addLanguage", language: target }];
	if (units.length === 0 && exists)
		return {
			kind: "mutate",
			mutations: [],
			result: {
				ok: true,
				language: target,
				translated: 0,
				review: "needs-review",
			},
		};
	const glossary: TranslationGlossaryEntry[] = [];
	const schema = strictStructuredSchema(translationBatchOutputSchema);
	const schemaDefinition = await schema.jsonSchema;
	for (const [index, batch] of planTranslationBatches(units).entries()) {
		const payload = translationPromptPayload({
			sourceLanguage: translationLanguage(source),
			targetLanguage: translationLanguage(target),
			appObjective: doc.appName,
			units: batch,
			glossary: boundedGlossary(glossary),
		});
		const contextVersion = canonicalJsonDigest({
			requestId: ctx.invocation.requestId,
			index,
			payload,
			fingerprints: batch.map(({ unit }) => unit.sourceFingerprint),
			schema: schemaDefinition,
			model: MODEL_ROLES.translator,
			system: TRANSLATION_SYSTEM,
		});
		const parse = (text: string): TranslationBatchOutput => {
			const output = translationBatchOutputSchema.parse(JSON.parse(text));
			validateTranslationBatchOutput(batch, output);
			return output;
		};
		const response = await runArchitectLoop({
			...run,
			spec: {
				designSessionId: run.designSessionId,
				authority: run.authority,
				kind: "translator",
				modelId: MODEL_ROLES.translator.modelId,
				promptVersion: canonicalJsonDigest(TRANSLATION_SYSTEM),
				toolsetDigest: canonicalJsonDigest([]),
				contextVersion,
			},
			system: TRANSLATION_SYSTEM,
			turnId: `${ctx.invocation.requestId}:${index}`,
			maxSteps: TRANSLATION_MAX_STEPS,
			responseSchema: schema,
			maxOutputTokens: TRANSLATION_MAX_OUTPUT_TOKENS,
			additions: [
				{
					key: "source",
					message: { role: "user", content: JSON.stringify(payload) },
				},
			],
			tools: () => ({}),
			dispatch: async () => ({
				kind: "result",
				output: { error: "Return the requested translations." },
			}),
			onFinish: async (text, conversation) => {
				try {
					parse(text);
				} catch (error) {
					for (let attempt = 1; attempt < TRANSLATION_MAX_STEPS; attempt++) {
						const key = `translation-repair:${attempt}`;
						if (!conversation.hasMessage(key))
							return { kind: "continue", key, message: outputError(error) };
					}
				}
				return { kind: "complete" };
			},
		});
		let output: TranslationBatchOutput;
		try {
			output = parse(response.text);
		} catch (error) {
			return {
				kind: "mutate",
				mutations: [],
				result: { error: outputError(error) },
			};
		}
		const values = validateTranslationBatchOutput(batch, output);
		for (const { unit } of batch) {
			const value = values.get(unit.id);
			if (value === undefined)
				throw new Error("An accepted translation is missing.");
			mutations.push({
				kind: "setTranslation",
				language: tag,
				unitId: unit.id,
				entry: {
					value,
					sourceFingerprint: unit.sourceFingerprint,
					origin: "ai",
					review: "needs-review",
					translatedFrom: localization.sourceLanguage,
				},
			});
		}
		glossary.push(...glossaryEntriesFromAcceptedBatch(batch, output));
	}
	const outcome = await guardedMutate(
		ctx,
		mutations,
		`localization:${tag}:translate`,
	);
	return outcome.ok
		? {
				kind: "mutate",
				mutations: outcome.mutations,
				result: {
					ok: true,
					language: target,
					translated: units.length,
					review: "needs-review",
				},
			}
		: { kind: "mutate", mutations: [], result: { error: outcome.error } };
}
