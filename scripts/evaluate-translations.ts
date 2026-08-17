/**
 * Paid, human-adjudicated evaluation for one exact Sol translation direction.
 *
 * Usage:
 *   npm run eval:translations -- \
 *     --confirm-paid --direction eng:spa --out /tmp/nova-translation-eng-spa
 *
 * The script intentionally has no default direction and refuses to reuse an
 * output directory. A passing structural report never changes production
 * policy: a bilingual reviewer must complete review-template.json, and a
 * separate reviewed code change may then update capabilityPolicy.ts.
 */

import "dotenv/config";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DesignGenerationContext } from "../lib/agent/design/designGenerationContext";
import {
	boundedGlossary,
	createProductionTranslationBatchRunner,
	glossaryEntriesFromAcceptedBatch,
	planTranslationBatches,
	TRANSLATION_PROMPT_VERSION,
	TRANSLATION_SCHEMA_VERSION,
	translationLanguage,
	translationPromptPayload,
	validateTranslationBatchOutput,
} from "../lib/agent/translation/translator";
import {
	type LanguageTag,
	languageTagSchema,
	parseLanguageTag,
} from "../lib/domain";
import { identityIssues } from "../lib/domain/languageRegistry";
import { MODEL_ROLES } from "../lib/models";
import {
	isTranslationEvaluationSourceLanguage,
	TRANSLATION_EVALUATION_CRITERIA,
	TRANSLATION_EVALUATION_FIXTURE_VERSION,
	TRANSLATION_EVALUATION_FIXTURES,
	TRANSLATION_EVALUATION_SOURCE_LANGUAGES,
	type TranslationEvaluationSourceLanguage,
	translationEvaluationUnits,
} from "./translation-evaluation-fixtures";

function usage(message?: string, exitCode = 1): never {
	if (message !== undefined) console.error(`${message}\n`);
	console.error(
		"Usage: npm run eval:translations -- --confirm-paid " +
			"--direction <source>:<target> --out <new-directory>\n" +
			`Fixture source languages: ${TRANSLATION_EVALUATION_SOURCE_LANGUAGES.join(", ")}\n` +
			"WARNING: this sends paid requests to the live Sol translator. A run never enables production policy.",
	);
	process.exit(exitCode);
}

function option(args: readonly string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index === -1) return undefined;
	const value = args[index + 1];
	if (value === undefined || value.startsWith("--")) {
		usage(`${name} requires a value.`);
	}
	return value;
}

function parseDirection(value: string): {
	source: TranslationEvaluationSourceLanguage;
	target: LanguageTag;
} {
	const parts = value.split(":");
	if (parts.length !== 2)
		usage("--direction must have the form source:target, such as eng:spa.");
	const source = languageTagSchema.safeParse(parts[0]?.trim());
	const target = languageTagSchema.safeParse(parts[1]?.trim());
	if (!source.success || !target.success) {
		usage(
			"--direction takes two language tags: an ISO 639:2023 Set 3 code with optional ISO 15924 script and ISO 3166-1 region segments (eng, spa-MX, cmn-Hans).",
		);
	}
	if (source.data === target.data) {
		usage("Source and target languages must differ.");
	}
	for (const tag of [source.data, target.data]) {
		const issues = identityIssues(parseLanguageTag(tag));
		if (issues.length > 0) usage(issues.join("\n"));
	}
	if (!isTranslationEvaluationSourceLanguage(source.data)) {
		usage(
			`The fixture set does not yet contain reviewed source copy for ${source.data}.`,
		);
	}
	return { source: source.data, target: target.data };
}

function countOccurrences(text: string, marker: string): number {
	let count = 0;
	let cursor = 0;
	while (true) {
		const index = text.indexOf(marker, cursor);
		if (index === -1) return count;
		count += 1;
		cursor = index + marker.length;
	}
}

function markdownReview(args: {
	sourceName: string;
	targetName: string;
	rows: readonly {
		key: string;
		role: string;
		sourceText: string;
		translatedText: string;
		criteria: readonly string[];
	}[];
}): string {
	const escapeCell = (value: string) =>
		value.replaceAll("|", "\\|").replaceAll("\n", "<br>");
	return `# Nova translation review: ${args.sourceName} → ${args.targetName}

This sheet is a reading aid. Record the binding decision in
\`review-template.json\`. Structural passing is necessary but not sufficient;
production remains disabled until a bilingual reviewer explicitly accepts this
exact direction, model, prompt, schema, and fixture version in a reviewed code
change.

| Case | Role | Source | Candidate | Review criteria |
|---|---|---|---|---|
${args.rows
	.map(
		(row) =>
			`| ${escapeCell(row.key)} | ${escapeCell(row.role)} | ${escapeCell(row.sourceText)} | ${escapeCell(row.translatedText)} | ${escapeCell(row.criteria.join(", "))} |`,
	)
	.join("\n")}
`;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.includes("--help")) usage(undefined, 0);
	if (!args.includes("--confirm-paid")) {
		usage("Refusing to make paid calls without --confirm-paid.");
	}
	const directionValue = option(args, "--direction");
	const outValue = option(args, "--out");
	if (directionValue === undefined || outValue === undefined) usage();
	const direction = parseDirection(directionValue);
	const apiKey = process.env.OPENAI_API_KEY;
	if (apiKey === undefined || apiKey.trim() === "") {
		usage("OPENAI_API_KEY is not set; no request was sent.");
	}
	const outDir = resolve(outValue);
	if (existsSync(outDir)) {
		usage(`Output directory already exists: ${outDir}`);
	}
	mkdirSync(outDir, { recursive: true });

	const sourceLanguage = translationLanguage(
		parseLanguageTag(direction.source),
	);
	const targetLanguage = translationLanguage(
		parseLanguageTag(direction.target),
	);
	const units = translationEvaluationUnits(direction.source);
	const fixtureById = new Map(
		units.map((unit, index) => {
			const fixture = TRANSLATION_EVALUATION_FIXTURES[index];
			if (fixture === undefined) {
				throw new Error(
					`Evaluation fixture metadata is missing for ${unit.id}.`,
				);
			}
			return [unit.id, fixture] as const;
		}),
	);
	const usageTotals = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	};
	const context = new DesignGenerationContext({
		apiKey,
		userId: "translation-evaluation",
		projectId: "translation-evaluation",
		runId: `translation-evaluation-${crypto.randomUUID()}`,
		designSessionId: crypto.randomUUID(),
		meter: {
			track(usage) {
				usageTotals.inputTokens += usage.inputTokens;
				usageTotals.outputTokens += usage.outputTokens;
				usageTotals.cacheReadTokens += usage.cacheReadTokens ?? 0;
				usageTotals.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
			},
		},
		usagePhase: "translation",
	});
	const runner = createProductionTranslationBatchRunner(context);
	const batches = planTranslationBatches(units);
	const startedAt = new Date().toISOString();
	const batchRecords: Array<Record<string, unknown>> = [];
	const candidates = new Map<string, string>();
	let glossary: readonly { source: string; target: string }[] = [];
	let failure: string | null = null;

	try {
		for (let index = 0; index < batches.length; index += 1) {
			const batch = batches[index];
			if (batch === undefined) continue;
			const input = {
				sourceLanguage,
				targetLanguage,
				appObjective:
					"Support a community health worker conducting household follow-up visits, symptom screening, and referrals.",
				units: batch,
				glossary: boundedGlossary(glossary),
			};
			const result = await runner(input, AbortSignal.timeout(600_000));
			batchRecords.push({
				index,
				input: translationPromptPayload(input),
				output: result.object,
				finishReason: result.finishReason,
				warningCount: result.warnings?.length ?? 0,
				usage: result.usage,
			});
			if (result.object === null) {
				throw new Error(
					`Batch ${index + 1} did not produce schema-valid structured output.`,
				);
			}
			validateTranslationBatchOutput(batch, result.object);
			for (const item of result.object.translations) {
				candidates.set(item.unitId, item.translatedText);
			}
			glossary = boundedGlossary([
				...glossary,
				...glossaryEntriesFromAcceptedBatch(batch, result.object),
			]);
		}
	} catch (error) {
		failure =
			error instanceof Error ? error.message : "Unknown evaluation error";
	}

	const rows = units.map((unit) => {
		const fixture = fixtureById.get(unit.id);
		if (fixture === undefined) {
			throw new Error(`Evaluation fixture metadata is missing for ${unit.id}.`);
		}
		const encodedSource = planTranslationBatches([unit])[0]?.[0];
		if (encodedSource === undefined) {
			throw new Error(`Evaluation unit ${unit.id} could not be encoded.`);
		}
		const translatedText = candidates.get(unit.id) ?? "";
		const formattingChecks = (fixture.formattingMarkers ?? []).map(
			(marker) => ({
				marker,
				sourceCount: countOccurrences(encodedSource.sourceText, marker),
				targetCount: countOccurrences(translatedText, marker),
				passed:
					countOccurrences(encodedSource.sourceText, marker) ===
					countOccurrences(translatedText, marker),
			}),
		);
		return {
			key: fixture.key,
			unitId: unit.id,
			role: unit.role,
			breadcrumb: unit.breadcrumb,
			context: unit.context,
			sourceText: encodedSource.sourceText,
			translatedText,
			protectedTokens: encodedSource.protectedTokens,
			criteria: fixture.criterionIds,
			formattingChecks,
		};
	});
	const structuralChecks = {
		exactUnitCoverage:
			failure === null &&
			candidates.size === units.length &&
			rows.every((row) => row.translatedText !== ""),
		protectedReferenceIntegrity: failure === null,
		formattingMarkers: rows.every((row) =>
			row.formattingChecks.every((check) => check.passed),
		),
	};
	const structurallyPassed = Object.values(structuralChecks).every(Boolean);
	const completedAt = new Date().toISOString();
	const candidateReport = {
		status: failure === null ? "completed" : "failed",
		failure,
		direction: {
			source: sourceLanguage,
			target: targetLanguage,
		},
		model: MODEL_ROLES.translator,
		promptVersion: TRANSLATION_PROMPT_VERSION,
		schemaVersion: TRANSLATION_SCHEMA_VERSION,
		fixtureVersion: TRANSLATION_EVALUATION_FIXTURE_VERSION,
		startedAt,
		completedAt,
		usage: usageTotals,
		structuralChecks,
		structurallyPassed,
		batches: batchRecords,
		candidates: rows,
	};
	const reviewTemplate = {
		decision: "pending",
		reviewer: "",
		reviewerLanguageQualifications: "",
		reviewedAt: null,
		direction: candidateReport.direction,
		model: candidateReport.model,
		promptVersion: candidateReport.promptVersion,
		schemaVersion: candidateReport.schemaVersion,
		fixtureVersion: candidateReport.fixtureVersion,
		structurallyPassed,
		criteria: TRANSLATION_EVALUATION_CRITERIA.map((criterion) => ({
			...criterion,
			pass: null,
			notes: "",
		})),
		cases: rows.map((row) => ({
			key: row.key,
			criterionIds: row.criteria,
			pass: null,
			notes: "",
		})),
		limitations: "",
		policyExplanation: "",
	};
	writeFileSync(
		resolve(outDir, "candidate.json"),
		`${JSON.stringify(candidateReport, null, 2)}\n`,
	);
	writeFileSync(
		resolve(outDir, "review-template.json"),
		`${JSON.stringify(reviewTemplate, null, 2)}\n`,
	);
	writeFileSync(
		resolve(outDir, "review.md"),
		markdownReview({
			sourceName: sourceLanguage.descriptor,
			targetName: targetLanguage.descriptor,
			rows,
		}),
	);

	console.log(`Wrote evaluation artifacts to ${outDir}`);
	console.log(
		structurallyPassed
			? "Structural checks passed. Production remains disabled pending bilingual review and a reviewed policy change."
			: `Structural checks failed: ${failure ?? "formatting marker mismatch"}`,
	);
	if (!structurallyPassed) process.exitCode = 1;
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
