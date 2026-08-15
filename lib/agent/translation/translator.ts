/** Structured text-translation protocol and protected-prose codec. */

import type { LanguageModelUsage } from "ai";
import { z } from "zod";
import type { DesignGenerationContext } from "@/lib/agent/design/designGenerationContext";
import type { SubGenerationObjectResult } from "@/lib/agent/subGeneration";
import {
	canonicalProseTemplate,
	type LanguageCode,
	type LocalizedValue,
	type ProsePart,
	type ProseReferencePart,
	type TranslationUnit,
	translationValueIntegrityIssue,
} from "@/lib/domain";
import { MODEL_ROLES, reasoningProviderOptions } from "@/lib/models";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import type {
	PersistedTranslationBatchOutput,
	PersistedTranslationUsage,
} from "./store";

export const TRANSLATION_PROMPT_VERSION = "translation-v1";
export const TRANSLATION_SCHEMA_VERSION = "translation-output-v1";
export const TRANSLATION_MAX_OUTPUT_TOKENS = 32_000;
const MAX_BATCH_ESTIMATED_TOKENS = 12_000;
const MAX_GLOSSARY_ENTRIES = 40;
const MAX_GLOSSARY_CHARS = 6_000;

export const translationBatchOutputSchema = z
	.object({
		translations: z
			.array(
				z
					.object({
						unitId: z
							.string()
							.min(1)
							.describe("Exact opaque unitId from the request."),
						translatedText: z
							.string()
							.describe(
								"Target-language text. Preserve every protected token exactly once.",
							),
					})
					.strict(),
			)
			.min(1),
	})
	.strict();

export interface TranslationGlossaryEntry {
	readonly source: string;
	readonly target: string;
}

export interface EncodedTranslationUnit {
	readonly unitId: string;
	readonly sourceText: string;
	readonly role: TranslationUnit["role"];
	readonly breadcrumb: readonly string[];
	readonly context: TranslationUnit["context"];
	readonly valueKind: TranslationUnit["valueKind"];
	readonly contentPolicy: TranslationUnit["contentPolicy"];
	readonly protectedTokens: readonly string[];
	readonly unit: TranslationUnit;
	readonly tokenReferences: ReadonlyMap<string, ProsePart>;
}

export interface TranslationBatchInput {
	readonly sourceLanguage: {
		readonly code: LanguageCode;
		readonly name: string;
	};
	readonly targetLanguage: {
		readonly code: LanguageCode;
		readonly name: string;
	};
	readonly appObjective: string;
	readonly units: readonly EncodedTranslationUnit[];
	readonly glossary: readonly TranslationGlossaryEntry[];
}

export interface TranslationBatchRunResult
	extends SubGenerationObjectResult<PersistedTranslationBatchOutput> {}

export type TranslationBatchRunner = (
	input: TranslationBatchInput,
	signal: AbortSignal,
) => Promise<TranslationBatchRunResult>;

function referenceToken(unitId: string, index: number, text: string): string {
	const stem = `⟦NOVA_REF_${canonicalJsonDigest(unitId).slice(0, 10)}_${index + 1}`;
	let token = `${stem}⟧`;
	let disambiguator = 1;
	while (text.includes(token)) {
		token = `${stem}_${disambiguator}⟧`;
		disambiguator += 1;
	}
	return token;
}

const RESERVED_PROTECTED_TOKEN_PATTERN = /⟦NOVA_REF_[^⟧\r\n]*⟧/gu;

export function encodeTranslationUnit(
	unit: TranslationUnit,
): EncodedTranslationUnit {
	if (unit.valueKind === "text") {
		return {
			unitId: unit.id,
			sourceText: unit.source as string,
			role: unit.role,
			breadcrumb: unit.breadcrumb,
			context: unit.context,
			valueKind: unit.valueKind,
			contentPolicy: unit.contentPolicy,
			protectedTokens: [],
			unit,
			tokenReferences: new Map(),
		};
	}
	const template = unit.source as Exclude<LocalizedValue, string>;
	const literalText = template.parts
		.filter((part) => part.kind === "text")
		.map((part) => part.text)
		.join("");
	const tokenReferences = new Map<string, ProsePart>();
	let referenceIndex = 0;
	let sourceText = "";
	for (const part of template.parts) {
		if (part.kind === "text") {
			let cursor = 0;
			for (const match of part.text.matchAll(
				RESERVED_PROTECTED_TOKEN_PATTERN,
			)) {
				const marker = match[0];
				const index = match.index;
				sourceText += part.text.slice(cursor, index);
				const token = referenceToken(unit.id, referenceIndex, literalText);
				referenceIndex += 1;
				tokenReferences.set(token, { kind: "text", text: marker });
				sourceText += token;
				cursor = index + marker.length;
			}
			sourceText += part.text.slice(cursor);
			continue;
		}
		const token = referenceToken(unit.id, referenceIndex, literalText);
		referenceIndex += 1;
		tokenReferences.set(token, structuredClone(part));
		sourceText += token;
	}
	return {
		unitId: unit.id,
		sourceText,
		role: unit.role,
		breadcrumb: unit.breadcrumb,
		context: unit.context,
		valueKind: unit.valueKind,
		contentPolicy: unit.contentPolicy,
		protectedTokens: [...tokenReferences.keys()],
		unit,
		tokenReferences,
	};
}

function exactOccurrenceCount(text: string, token: string): number {
	let count = 0;
	let cursor = 0;
	while (true) {
		const index = text.indexOf(token, cursor);
		if (index === -1) return count;
		count += 1;
		cursor = index + token.length;
	}
}

export function decodeTranslatedValue(
	encoded: EncodedTranslationUnit,
	translatedText: string,
): LocalizedValue {
	if (encoded.valueKind === "text") {
		if (
			encoded.contentPolicy === "require-nonblank" &&
			translatedText.trim().length === 0
		) {
			throw new Error(`Translation unit ${encoded.unitId} cannot be blank.`);
		}
		return translatedText;
	}
	for (const token of encoded.protectedTokens) {
		if (exactOccurrenceCount(translatedText, token) !== 1) {
			throw new Error(
				`Translation unit ${encoded.unitId} must preserve protected token ${token} exactly once.`,
			);
		}
	}
	for (const match of translatedText.matchAll(
		RESERVED_PROTECTED_TOKEN_PATTERN,
	)) {
		if (!encoded.tokenReferences.has(match[0])) {
			throw new Error(
				`Translation unit ${encoded.unitId} included foreign protected token ${match[0]}.`,
			);
		}
	}
	const parts: Array<{ kind: "text"; text: string } | ProseReferencePart> = [];
	let cursor = 0;
	while (cursor < translatedText.length) {
		let nextIndex = -1;
		let nextToken: string | undefined;
		for (const token of encoded.protectedTokens) {
			const index = translatedText.indexOf(token, cursor);
			if (index !== -1 && (nextIndex === -1 || index < nextIndex)) {
				nextIndex = index;
				nextToken = token;
			}
		}
		if (nextToken === undefined) {
			parts.push({ kind: "text", text: translatedText.slice(cursor) });
			break;
		}
		if (nextIndex > cursor) {
			parts.push({
				kind: "text",
				text: translatedText.slice(cursor, nextIndex),
			});
		}
		const reference = encoded.tokenReferences.get(nextToken);
		if (reference === undefined) {
			throw new Error(`Unknown protected token ${nextToken}.`);
		}
		parts.push(structuredClone(reference));
		cursor = nextIndex + nextToken.length;
	}
	const value = canonicalProseTemplate(parts);
	if (translationValueIntegrityIssue(encoded.unit, value) !== undefined) {
		throw new Error(
			`Translation unit ${encoded.unitId} produced an invalid protected-prose value.`,
		);
	}
	return value;
}

function batchGroup(unit: TranslationUnit): string {
	switch (unit.owner.kind) {
		case "form":
		case "field":
		case "select-option":
			return `form:${unit.owner.formUuid}`;
		case "case-list-column":
			return `case-list:${unit.owner.moduleUuid}`;
		case "search-input":
			return `search:${unit.owner.moduleUuid}`;
		case "module":
			return `module:${unit.owner.moduleUuid}`;
		case "case-property-option":
			return `case-property:${unit.owner.caseType}:${unit.owner.property}`;
		case "app":
			return "app";
	}
}

function estimatedTokens(unit: EncodedTranslationUnit): number {
	return Math.ceil(
		(JSON.stringify({
			unitId: unit.unitId,
			sourceText: unit.sourceText,
			role: unit.role,
			breadcrumb: unit.breadcrumb,
			context: unit.context,
			protectedTokens: unit.protectedTokens,
		}).length +
			unit.sourceText.length) /
			4,
	);
}

/** Group by owning screen first, then split a large screen on a deterministic
 * token estimate. No item-count boundary can accidentally admit a few huge
 * help strings as one unbounded request. */
export function planTranslationBatches(
	units: readonly TranslationUnit[],
): readonly (readonly EncodedTranslationUnit[])[] {
	const groups = new Map<string, EncodedTranslationUnit[]>();
	for (const unit of units) {
		const key = batchGroup(unit);
		const group = groups.get(key) ?? [];
		group.push(encodeTranslationUnit(unit));
		groups.set(key, group);
	}
	const batches: EncodedTranslationUnit[][] = [];
	for (const group of groups.values()) {
		let batch: EncodedTranslationUnit[] = [];
		let tokens = 0;
		for (const unit of group) {
			const unitTokens = estimatedTokens(unit);
			if (
				batch.length > 0 &&
				tokens + unitTokens > MAX_BATCH_ESTIMATED_TOKENS
			) {
				batches.push(batch);
				batch = [];
				tokens = 0;
			}
			batch.push(unit);
			tokens += unitTokens;
		}
		if (batch.length > 0) batches.push(batch);
	}
	return batches;
}

export function boundedGlossary(
	entries: readonly TranslationGlossaryEntry[],
): readonly TranslationGlossaryEntry[] {
	const newestFirst: TranslationGlossaryEntry[] = [];
	let chars = 0;
	for (
		let index = entries.length - 1;
		index >= 0 && newestFirst.length < MAX_GLOSSARY_ENTRIES;
		index -= 1
	) {
		const entry = entries[index];
		if (entry === undefined) continue;
		const size = entry.source.length + entry.target.length;
		if (size > MAX_GLOSSARY_CHARS) continue;
		if (chars + size > MAX_GLOSSARY_CHARS) break;
		newestFirst.push(entry);
		chars += size;
	}
	return newestFirst.reverse();
}

export function translationPromptPayload(input: TranslationBatchInput) {
	return {
		sourceLanguage: input.sourceLanguage,
		targetLanguage: input.targetLanguage,
		appObjective: input.appObjective,
		glossary: input.glossary,
		units: input.units.map((unit) => ({
			unitId: unit.unitId,
			sourceText: unit.sourceText,
			role: unit.role,
			breadcrumb: unit.breadcrumb,
			context: unit.context,
			valueKind: unit.valueKind,
			contentPolicy: unit.contentPolicy,
			protectedTokens: unit.protectedTokens,
		})),
	};
}

const TRANSLATION_SYSTEM = `You translate static worker-facing content for a data-collection app.

Translate from the exact source language into the exact target language. Use the app objective, role, breadcrumb, context, sibling content, and accepted glossary to preserve domain meaning and terminology. Keep concise UI labels concise. Preserve formatting that carries meaning.

Return every requested unitId exactly once and no other unitId. Copy every protected token exactly, including brackets, spelling, and case, exactly once; tokens may move for target-language grammar but may never be translated, added, or removed. Do not explain the translation. Do not invent content absent from the source.`;

export function createProductionTranslationBatchRunner(
	context: DesignGenerationContext,
): TranslationBatchRunner {
	return async (input, signal) =>
		context.runStructured({
			schema: translationBatchOutputSchema,
			modelId: MODEL_ROLES.translator.modelId,
			system: TRANSLATION_SYSTEM,
			prompt: JSON.stringify(translationPromptPayload(input)),
			maxOutputTokens: TRANSLATION_MAX_OUTPUT_TOKENS,
			providerOptions: reasoningProviderOptions(
				MODEL_ROLES.translator.reasoningEffort,
			),
			signal,
		});
}

export function normalizeTranslationUsage(
	usage: LanguageModelUsage | undefined,
): PersistedTranslationUsage | null {
	if (usage === undefined) return null;
	return {
		inputTokens: usage.inputTokens ?? 0,
		outputTokens: usage.outputTokens ?? 0,
		cacheReadTokens: usage.inputTokenDetails.cacheReadTokens ?? 0,
		cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens ?? 0,
	};
}

export function validateTranslationBatchOutput(
	units: readonly EncodedTranslationUnit[],
	output: PersistedTranslationBatchOutput,
): ReadonlyMap<string, LocalizedValue> {
	const expected = new Map(units.map((unit) => [unit.unitId, unit]));
	const translated = new Map<string, LocalizedValue>();
	for (const item of output.translations) {
		const unit = expected.get(item.unitId);
		if (unit === undefined) {
			throw new Error(
				`Translation output included unexpected unit ${item.unitId}.`,
			);
		}
		if (translated.has(item.unitId)) {
			throw new Error(`Translation output repeated unit ${item.unitId}.`);
		}
		translated.set(
			item.unitId,
			decodeTranslatedValue(unit, item.translatedText),
		);
	}
	if (translated.size !== expected.size) {
		const missing = [...expected.keys()].filter((id) => !translated.has(id));
		throw new Error(
			`Translation output omitted ${missing.length} requested unit(s).`,
		);
	}
	return translated;
}

export function glossaryEntriesFromAcceptedBatch(
	units: readonly EncodedTranslationUnit[],
	output: PersistedTranslationBatchOutput,
): readonly TranslationGlossaryEntry[] {
	const byId = new Map(output.translations.map((item) => [item.unitId, item]));
	return units.flatMap((unit) => {
		const target = byId.get(unit.unitId)?.translatedText;
		return target === undefined || unit.protectedTokens.length > 0
			? []
			: [{ source: unit.sourceText, target }];
	});
}
