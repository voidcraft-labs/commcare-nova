/** Structured extraction and durable translation batch compositions. */

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
import { newestContext, recordedItemsOf } from "./recordedItems";
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
		note: "Static instructions from current code. Recorded runs may have used a different prompt version.",
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
	file: "lib/agent/translation/translateLanguage.ts",
	symbol: "translateLanguage",
};

const TRANSLATOR_MOMENTS: readonly MomentSpec[] = [
	{
		id: "batch",
		label: "One batch",
		why: "A requested translation groups current app text into bounded batches. Responses and usage persist before the workspace saves all accepted translations together. Invalid output receives bounded feedback in the same batch conversation.",
		needs: ["live-call"],
		source: TRANSLATOR,
	},
	{
		id: "recorded",
		label: "Recorded batch",
		why: "The newest translation batch in this session, including responses, repair feedback and recorded usage. The run timeline includes all batches.",
		needs: ["design-session"],
		source: TRANSLATOR,
	},
];

export const translatorComposition: RoleComposition = {
	role: "translator",
	moments: TRANSLATOR_MOMENTS,
	async compose(momentId, inputs) {
		const spec = specById(TRANSLATOR_MOMENTS, momentId, "translator");
		const recorded =
			momentId === "recorded" && inputs.session
				? newestContext(inputs.session.contexts, "translator")
				: undefined;
		return moment(spec, [
			oneShotSystem(TRANSLATION_SYSTEM, "Translator instructions", {
				file: "lib/agent/translation/translator.ts",
				symbol: "TRANSLATION_SYSTEM",
			}),
			...(recorded
				? recordedItemsOf(recorded)
				: [
						liveOnly(
							"prompt",
							"Batch payload",
							"One user message holding JSON: sourceLanguage, targetLanguage, appObjective, the accepted glossary, and the units, each with unitId, sourceText, role, breadcrumb, context, valueKind, contentPolicy, and protectedTokens.",
							{
								file: "lib/agent/translation/translator.ts",
								symbol: "translationPromptPayload",
							},
						),
					]),
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
