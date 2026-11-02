/**
 * Render canonical prose templates as Markdown with structural reference chips.
 *
 * Literal text is handed to Markdown unchanged, including hashtag-looking
 * text. Only typed reference parts become chips. A label whose owner holds
 * `plainLabel` skips Markdown: its text shows as written, line breaks kept,
 * with the same chips, which is what Android and the Web Apps client show
 * for a label with no markdown form. A tag in it stays text: no surface
 * here renders author HTML. The temporary render markers
 * below exist solely inside this render call; they are never authored, parsed
 * into domain state, or persisted.
 */

"use client";
import Markdown, { type MarkdownToJSX, RuleType } from "markdown-to-jsx";
import { Fragment, type ReactNode, useMemo } from "react";
import type { ProseReferencePart, ProseTemplate } from "@/lib/domain";
import {
	type LabelMarkdownRendering,
	previewOptionsFor,
	withChipInjection,
} from "@/lib/markdown";
import {
	type ReferenceProvider,
	unresolvedReferenceProjection,
} from "./provider";
import { ReferenceChip, UnresolvedReferenceChip } from "./ReferenceChip";
import { useCurrentFormUuid, useReferenceProvider } from "./ReferenceContext";

interface LabelContentProps {
	label: ProseTemplate;
	resolvedLabel?: string;
	isEditMode: boolean;
	className: string;
	/** How the runtime the running preview plays renders a label's markdown
	 *  (`lib/preview/platform.ts`, `labelMarkdown`). Edit mode always shows
	 *  the default rendering. */
	rendering?: LabelMarkdownRendering;
	/** The owner (a question, group, repeat or section) holds `plainLabel`:
	 *  the text shows as written on every platform and in edit mode. */
	plainLabel?: boolean;
}

/** Whether a label's owner (a field, a section or a choice) holds
 *  `plainLabel`: its text shows as written, with no markdown. */
export function ownerHoldsPlainLabel(owner: object | undefined): boolean {
	return (
		owner !== undefined && "plainLabel" in owner && owner.plainLabel === true
	);
}

export function textWithChips(
	template: ProseTemplate,
	provider: ReferenceProvider | null,
	formUuid?: string,
): ReactNode {
	return template.parts.map((part, index) => {
		if (part.kind === "text") {
			return (
				// biome-ignore lint/suspicious/noArrayIndexKey: canonical ordered prose parts
				<Fragment key={index}>{part.text}</Fragment>
			);
		}
		const projected =
			provider?.projectPart(part, formUuid) ??
			({
				ok: false,
				unresolved: unresolvedReferenceProjection(part),
			} as const);
		return projected.ok ? (
			// biome-ignore lint/suspicious/noArrayIndexKey: canonical ordered prose parts
			<ReferenceChip key={index} reference={projected.reference} />
		) : (
			// biome-ignore lint/suspicious/noArrayIndexKey: canonical ordered prose parts
			<Fragment key={index}>
				<UnresolvedReferenceChip unresolved={projected.unresolved} />
			</Fragment>
		);
	});
}

interface RenderTemplate {
	markdown: string;
	refs: Map<string, ProseReferencePart>;
}

function makeRenderTemplate(template: ProseTemplate): RenderTemplate {
	let nonce = 0;
	let prefix = "";
	const literal = template.parts
		.filter((part) => part.kind === "text")
		.map((part) => part.text)
		.join("");
	do {
		prefix = `\uE000NOVA_REF_${nonce++}_`;
	} while (literal.includes(prefix));

	const refs = new Map<string, ProseReferencePart>();
	let markdown = "";
	let refIndex = 0;
	for (const part of template.parts) {
		if (part.kind === "text") {
			markdown += part.text;
			continue;
		}
		const marker = `${prefix}${refIndex++}\uE001`;
		refs.set(marker, part);
		markdown += marker;
	}
	return { markdown, refs };
}

function renderMarkedText(
	text: string,
	refs: ReadonlyMap<string, ProseReferencePart>,
	provider: ReferenceProvider | null,
	formUuid: string | undefined,
): ReactNode {
	if (refs.size === 0) return text;
	const result: ReactNode[] = [];
	let cursor = 0;
	for (const [marker, part] of refs) {
		const index = text.indexOf(marker, cursor);
		if (index < 0) continue;
		if (index > cursor) result.push(text.slice(cursor, index));
		const projected =
			provider?.projectPart(part, formUuid) ??
			({
				ok: false,
				unresolved: unresolvedReferenceProjection(part),
			} as const);
		result.push(
			projected.ok ? (
				<ReferenceChip key={marker} reference={projected.reference} />
			) : (
				<UnresolvedReferenceChip
					key={marker}
					unresolved={projected.unresolved}
				/>
			),
		);
		cursor = index + marker.length;
	}
	if (cursor < text.length) result.push(text.slice(cursor));
	return result;
}

function chipRule(
	refs: ReadonlyMap<string, ProseReferencePart>,
	provider: ReferenceProvider | null,
	formUuid: string | undefined,
): NonNullable<MarkdownToJSX.Options["renderRule"]> {
	return (next, node, _renderChildren, state) => {
		if (
			node.type === RuleType.text &&
			[...refs.keys()].some((marker) => node.text.includes(marker))
		) {
			return (
				<Fragment key={state.key}>
					{renderMarkedText(node.text, refs, provider, formUuid)}
				</Fragment>
			);
		}
		return next();
	};
}

export function LabelContent({
	label,
	resolvedLabel,
	isEditMode,
	className,
	rendering,
	plainLabel = false,
}: LabelContentProps) {
	const provider = useReferenceProvider();
	const formUuid = useCurrentFormUuid();
	const rendered = useMemo(() => makeRenderTemplate(label), [label]);
	const baseOptions = previewOptionsFor(isEditMode ? undefined : rendering);
	const options = useMemo(
		() =>
			withChipInjection(
				baseOptions,
				chipRule(rendered.refs, provider, formUuid),
			),
		[baseOptions, rendered, provider, formUuid],
	);
	const wrapperCls = `preview-markdown ${className}`;

	/* The wrapper's `white-space: break-spaces` keeps the written line
	 * breaks; nothing here parses the text. */
	if (plainLabel) {
		return (
			<div className={wrapperCls}>
				{!isEditMode && resolvedLabel !== undefined
					? resolvedLabel
					: textWithChips(label, provider, formUuid)}
			</div>
		);
	}

	if (!isEditMode && resolvedLabel !== undefined) {
		return (
			<div className={wrapperCls}>
				<Markdown options={baseOptions}>{resolvedLabel}</Markdown>
			</div>
		);
	}

	return (
		<div className={wrapperCls}>
			<Markdown options={options}>{rendered.markdown}</Markdown>
		</div>
	);
}
