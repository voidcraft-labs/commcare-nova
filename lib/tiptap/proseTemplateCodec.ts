/**
 * Pure ProseTemplate <-> TipTap JSON mapping.
 *
 * Reference atoms carry the exact typed part. Display labels are projections
 * supplied by the caller and never participate in serialization.
 */

import {
	canonicalProseTemplate,
	type ProsePart,
	type ProseReferencePart,
	type ProseTemplate,
	prosePartSchema,
} from "@/lib/domain";
import { canonicalJsonText } from "@/lib/utils/canonicalJsonText";

export interface ProseTiptapNode {
	readonly type?: string;
	readonly text?: string;
	readonly attrs?: Record<string, unknown>;
	readonly content?: readonly ProseTiptapNode[];
}

export function proseTemplateToTiptapContent(
	value: ProseTemplate,
	labelFor?: (part: ProseReferencePart) => string,
): ProseTiptapNode {
	const paragraphs: Array<{
		type: "paragraph";
		content: ProseTiptapNode[];
	}> = [{ type: "paragraph", content: [] }];
	for (const part of value.parts) {
		if (part.kind === "text") {
			const lines = part.text.split("\n");
			for (let index = 0; index < lines.length; index++) {
				const line = lines[index];
				if (line) {
					paragraphs.at(-1)?.content.push({ type: "text", text: line });
				}
				if (index < lines.length - 1) {
					paragraphs.push({ type: "paragraph", content: [] });
				}
			}
			continue;
		}
		paragraphs.at(-1)?.content.push({
			type: "commcareRef",
			attrs: { part, label: labelFor?.(part) ?? "" },
		});
	}
	return {
		type: "doc",
		content: paragraphs.map((paragraph) => ({
			...paragraph,
			...(paragraph.content.length === 0 && { content: undefined }),
		})),
	};
}

export function tiptapContentToProseTemplate(
	doc: ProseTiptapNode,
): ProseTemplate {
	const parts: ProsePart[] = [];
	const paragraphs = doc.content ?? [];
	for (
		let paragraphIndex = 0;
		paragraphIndex < paragraphs.length;
		paragraphIndex++
	) {
		const paragraph = paragraphs[paragraphIndex];
		for (const node of paragraph.content ?? []) {
			if (node.type === "text") {
				parts.push({ kind: "text", text: node.text ?? "" });
				continue;
			}
			if (node.type !== "commcareRef") continue;
			const parsed = prosePartSchema.safeParse(node.attrs?.part);
			if (parsed.success && parsed.data.kind !== "text") {
				parts.push(parsed.data);
			}
		}
		if (paragraphIndex < paragraphs.length - 1) {
			parts.push({ kind: "text", text: "\n" });
		}
	}
	return canonicalProseTemplate(parts);
}

export function proseTemplateSurvivesTiptapRoundTrip(
	template: ProseTemplate,
): boolean {
	return (
		canonicalJsonText(
			tiptapContentToProseTemplate(proseTemplateToTiptapContent(template)),
		) === canonicalJsonText(template)
	);
}
