/**
 * The four one-shot structured roles: design reviewer, executor helper,
 * document extractor, translator. Each is one call with a static system
 * prompt, one user message built per call, and a strict output schema.
 *
 * The user message is never stored anywhere Nova can read it back, so the
 * compositions show its exact composition as a `missing` item that needs a
 * live call, and render the output schema as the provider receives it.
 */

import {
	ARCHITECT_SYSTEM,
	architectBlockerDecisionWireSchemaFor,
} from "@/lib/agent/build/executionBlocker";
import { DESIGN_REVIEWER_SYSTEM } from "@/lib/agent/design/prompts";
import {
	EXTRACT_SYSTEM,
	extractDocumentSchema,
} from "@/lib/agent/documentExtraction";
import {
	TRANSLATION_SYSTEM,
	translationBatchOutputSchema,
} from "@/lib/agent/translation/translator";
import type {
	ContextItem,
	MomentSpec,
	RoleComposition,
	SourceRef,
} from "../types";
import {
	missingItem,
	moment,
	outputSchemaItem,
	specById,
	systemItem,
} from "./shared";

function oneShotSystem(
	text: string,
	title: string,
	source: SourceRef,
): ContextItem {
	return systemItem({
		text,
		segments: [{ id: "system", title, text, source }],
		source,
		note: "One static string. The call passes no cache key: nothing about it is shared with a next call.",
	});
}

function liveOnly(
	id: string,
	label: string,
	explanation: string,
	source: SourceRef,
): ContextItem {
	return missingItem({ id, label, needs: "live-call", explanation, source });
}

// ── Design reviewer ──────────────────────────────────────────────────────

const REVIEWER = {
	file: "lib/agent/design/reviewer.ts",
	symbol: "runDesignReviewer",
};
const REVIEW_PROMPT = {
	file: "lib/agent/design/prompts.ts",
	symbol: "renderReviewPrompt",
};

const REVIEWER_MOMENTS: readonly MomentSpec[] = [
	{
		id: "review",
		label: "The review call",
		why: "A fresh context per contract revision: the exact source package, the tag legend, the capability catalog, and the handle-projected contract. No author reasoning, no prior review prose.",
		needs: ["live-call"],
		source: REVIEWER,
	},
];

export const designReviewerComposition: RoleComposition = {
	role: "design-reviewer",
	moments: REVIEWER_MOMENTS,
	async compose(momentId) {
		const spec = specById(REVIEWER_MOMENTS, momentId, "design reviewer");
		return moment(spec, [
			oneShotSystem(DESIGN_REVIEWER_SYSTEM, "Reviewer instructions", {
				file: "lib/agent/design/prompts.ts",
				symbol: "DESIGN_REVIEWER_SYSTEM",
			}),
			liveOnly(
				"prompt",
				"Review prompt",
				'Built per call and not stored. In order: the source package rendered as tagged blocks (<nova:source tag="S1">), the tag legend, the same capability catalog the author reads, then the proposed contract as JSON with @handle symbols in place of raw identities, and one closing instruction. Attached images ride beside it, each labeled with its tag.',
				REVIEW_PROMPT,
			),
			liveOnly(
				"output-schema",
				"Output schema",
				"Strict, and derived per session: the citable source tags, the contract's printed symbols, and the platform constraint codes are exact enums, so an out-of-set citation is grammatically inexpressible. The Zod transform resolves the symbols back to identities after the parse.",
				{
					file: "lib/agent/design/reviewerSchema.ts",
					symbol: "designReviewSchemaFor",
				},
			),
		]);
	},
};

// ── Executor helper ──────────────────────────────────────────────────────

const HELPER = {
	file: "lib/agent/build/executionBlocker.ts",
	symbol: "resolveExecutionBlocker",
};

const HELPER_MOMENTS: readonly MomentSpec[] = [
	{
		id: "decision",
		label: "The blocker decision",
		why: "Bought when the executor reports a blocker or repeats a substantive failure. The decision returns inside the executor's tool result; the helper never speaks to the user.",
		needs: ["live-call"],
		source: HELPER,
	},
];

export const executorHelperComposition: RoleComposition = {
	role: "executor-helper",
	moments: HELPER_MOMENTS,
	async compose(momentId) {
		const spec = specById(HELPER_MOMENTS, momentId, "executor helper");
		return moment(spec, [
			oneShotSystem(ARCHITECT_SYSTEM, "Architect instructions", {
				file: "lib/agent/build/executionBlocker.ts",
				symbol: "ARCHITECT_SYSTEM",
			}),
			liveOnly(
				"prompt",
				"Blocker prompt",
				"Five sections joined by blank lines: the accepted design contract as JSON, the deterministic build plan as JSON, the accepted execution brief rendered exactly as the executor read it, the compiler report as JSON, and the current server diagnostics as JSON.",
				HELPER,
			),
			outputSchemaItem({
				schema: architectBlockerDecisionWireSchemaFor(),
				projection: "strict",
				source: {
					file: "lib/agent/build/executionBlocker.ts",
					symbol: "architectBlockerDecisionWireSchemaFor",
				},
				note: "Nova's strict projection: every property required, optional slots null-unioned, defaults stripped.",
			}),
		]);
	},
};

// ── Document extractor ───────────────────────────────────────────────────

const EXTRACTOR = {
	file: "lib/agent/documentExtraction.ts",
	symbol: "extractDocument",
};

const EXTRACTOR_MOMENTS: readonly MomentSpec[] = [
	{
		id: "text-document",
		label: "Text, docx, or xlsx",
		why: "The document rides as one user message: a metadata line with the filename (and a figures note for a docx), a blank line, then the decoded or converted markdown body. Readable docx figures ride the same message as image parts.",
		needs: ["live-call"],
		source: EXTRACTOR,
	},
	{
		id: "pdf",
		label: "PDF",
		why: "A PDF rides as a native file part beside one instruction sentence naming the file, so the model reads the document itself.",
		needs: ["live-call"],
		source: EXTRACTOR,
	},
];

export const documentExtractorComposition: RoleComposition = {
	role: "document-extractor",
	moments: EXTRACTOR_MOMENTS,
	async compose(momentId) {
		const spec = specById(EXTRACTOR_MOMENTS, momentId, "document extractor");
		const system = oneShotSystem(EXTRACT_SYSTEM, "Extractor instructions", {
			file: "lib/agent/documentExtraction.ts",
			symbol: "EXTRACT_SYSTEM",
		});
		const prompt =
			spec.id === "pdf"
				? liveOnly(
						"prompt",
						"Instruction and file",
						'One user message with two parts: the text "Extract every requirement from this document. Filename: <name>." and a file part carrying the PDF bytes as a data URL.',
						{ file: "lib/agent/subGeneration.ts", symbol: "streamObjectWith" },
					)
				: liveOnly(
						"prompt",
						"Metadata and body",
						'One user message: "Filename: <name>" (plus "Figures: …" for a docx with embedded images), a blank line, then the body verbatim. Each attached figure follows as a text part carrying its <nova:figure index="N"/> marker and an image part.',
						{
							file: "lib/agent/documentExtraction.ts",
							symbol: "docxToMarkdownWithFigures",
						},
					);
		return moment(spec, [
			system,
			prompt,
			outputSchemaItem({
				schema: extractDocumentSchema,
				projection: "provider-default",
				source: {
					file: "lib/agent/documentExtraction.ts",
					symbol: "extractDocumentSchema",
				},
				note: "The raw Zod emission: this flat all-required schema is already strict-compatible, so it skips Nova's projection. Field order is load-bearing: title and summary first, the large extract last.",
			}),
		]);
	},
};

// ── Translator ───────────────────────────────────────────────────────────

const TRANSLATOR = {
	file: "lib/agent/translation/translator.ts",
	symbol: "createProductionTranslationBatchRunner",
};

const TRANSLATOR_MOMENTS: readonly MomentSpec[] = [
	{
		id: "batch",
		label: "One batch",
		why: "After the last slice commits, the finalizer groups translation units by owning screen under a token bound and runs one call per batch. Output and usage persist before the canonical commit, so recovery never re-translates.",
		needs: ["live-call"],
		source: TRANSLATOR,
	},
];

export const translatorComposition: RoleComposition = {
	role: "translator",
	moments: TRANSLATOR_MOMENTS,
	async compose(momentId) {
		const spec = specById(TRANSLATOR_MOMENTS, momentId, "translator");
		return moment(spec, [
			oneShotSystem(TRANSLATION_SYSTEM, "Translator instructions", {
				file: "lib/agent/translation/translator.ts",
				symbol: "TRANSLATION_SYSTEM",
			}),
			liveOnly(
				"prompt",
				"Batch payload",
				"One user message holding JSON: sourceLanguage, targetLanguage, appObjective, the accepted glossary, and the units, each with unitId, sourceText, role, breadcrumb, context, valueKind, contentPolicy, and protectedTokens.",
				{
					file: "lib/agent/translation/translator.ts",
					symbol: "translationPromptPayload",
				},
			),
			outputSchemaItem({
				schema: translationBatchOutputSchema,
				projection: "strict",
				source: {
					file: "lib/agent/translation/translator.ts",
					symbol: "translationBatchOutputSchema",
				},
			}),
		]);
	},
};
