/**
 * React component for rendering label text with inline reference chips.
 *
 * Uses markdown-to-jsx (via shared `previewMarkdownOptions`) with a chip
 * injection renderRule that intercepts text nodes containing `#type/path`
 * hashtag patterns and replaces them with ReferenceChip components directly.
 * Markdown handles all formatting natively; we only touch text nodes that
 * contain refs. The chip rule composes on top of the shared breaksRenderRule
 * via `withChipInjection`.
 */

"use client";
import type { IconifyIcon } from "@iconify/react/offline";
import Markdown, { type MarkdownToJSX, RuleType } from "markdown-to-jsx";
import { Fragment, type ReactNode, useMemo } from "react";
import { PREVIEW_OPTIONS, withChipInjection } from "@/lib/markdown";
import { HASHTAG_REF_PATTERN } from "./config";
import type { ReferenceProvider } from "./provider";
import { ReferenceChip } from "./ReferenceChip";
import { useReferenceProvider } from "./ReferenceContext";
import { parseLabelSegments, resolveRefFromExpr } from "./renderLabel";

interface LabelContentProps {
	/** Raw label text (bare `#type/path` hashtags and markdown). */
	label: string;
	/** Engine-resolved label (hashtag refs evaluated to values). Undefined when no refs present. */
	resolvedLabel?: string;
	/** Whether we're in design/edit mode. */
	isEditMode: boolean;
	/** Text variant classes (font-size, weight, color) merged onto the
	 *  `preview-markdown` wrapper. Use `FIELD_STYLES.label` or `.hint`. */
	className: string;
}

/**
 * Split a text node on ref patterns and render chips inline. Uses
 * parseLabelSegments (canonical regex split) so the pattern logic lives
 * in one place. Optional `iconOverrides` enriches form refs with
 * question-type icons when rendering outside the ReferenceProvider context.
 */
export function textWithChips(
	text: string,
	provider: ReferenceProvider | null,
	iconOverrides?: Map<string, IconifyIcon>,
): ReactNode {
	/* Fast path: skip regex work for the ~95% of labels with no refs. */
	if (!text.includes("#")) return text;
	return parseLabelSegments(text).map((seg) => {
		if (seg.kind === "text") return seg.text;
		const ref = resolveRefFromExpr(seg.value, provider, iconOverrides);
		return ref ? <ReferenceChip key={seg.key} reference={ref} /> : seg.value;
	});
}

/**
 * Build a renderRule that intercepts text nodes containing ref patterns and
 * replaces them with ReferenceChip components. Composed on top of the shared
 * preview options (which include breaksRenderRule) via withChipInjection.
 */
function chipRenderRule(
	provider: ReferenceProvider | null,
): NonNullable<MarkdownToJSX.Options["renderRule"]> {
	return (next, node, _renderChildren, state) => {
		if (node.type === RuleType.text && HASHTAG_REF_PATTERN.test(node.text)) {
			return (
				<Fragment key={state.key}>
					{textWithChips(node.text, provider)}
				</Fragment>
			);
		}
		return next();
	};
}

function useMarkdownOptions(): MarkdownToJSX.Options {
	const provider = useReferenceProvider();
	return useMemo(
		() => withChipInjection(PREVIEW_OPTIONS, chipRenderRule(provider)),
		[provider],
	);
}

export function LabelContent({
	label,
	resolvedLabel,
	isEditMode,
	className,
}: LabelContentProps) {
	const options = useMarkdownOptions();
	const wrapperCls = `preview-markdown ${className}`;

	/* Preview mode: use engine-resolved values (no chips, just substituted text). */
	if (!isEditMode && resolvedLabel !== undefined) {
		return (
			<div className={wrapperCls}>
				<Markdown options={options}>{resolvedLabel}</Markdown>
			</div>
		);
	}

	return (
		<div className={wrapperCls}>
			<Markdown options={options}>{label}</Markdown>
		</div>
	);
}
