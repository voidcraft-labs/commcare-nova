/**
 * Render canonical prose templates as Markdown with structural reference chips.
 *
 * Literal text is handed to Markdown unchanged, including hashtag-looking
 * text. Only typed parts become chips: a reference as its reference chip, a
 * calculated value as its formula, printed in the text's prose slot. A text
 * shown as typed (`lib/domain/plainText.ts`: its owner's `plainLabel` or
 * `plainHelp`, or its form's `plainText`) skips Markdown: its text shows as
 * written, line breaks kept,
 * with the same chips, which is what Android and the Web Apps client show
 * for a label with no markdown form. A tag in it stays text: no surface
 * here renders author HTML. The temporary render markers
 * below exist solely inside this render call; they are never authored, parsed
 * into domain state, or persisted.
 */

"use client";
import Markdown, { type MarkdownToJSX, RuleType } from "markdown-to-jsx";
import { Fragment, type ReactNode, useMemo } from "react";
import type { ProseAtomPart, ProseTemplate } from "@/lib/domain";
import type { ProseSlotRef } from "@/lib/domain/expression/types";
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
import {
	ProseSlotScope,
	useCurrentFormUuid,
	useReferenceProvider,
} from "./ReferenceContext";
import { ProseValueAtom } from "./ValueChip";

interface LabelContentProps {
	label: ProseTemplate;
	resolvedLabel?: string;
	isEditMode: boolean;
	className: string;
	/** How the runtime the running preview plays renders a label's markdown
	 *  (`lib/preview/platform.ts`, `labelMarkdown`). Edit mode always shows
	 *  the default rendering. */
	rendering?: LabelMarkdownRendering;
	/** The text shows as written (`lib/domain/plainText.ts`), which the
	 *  caller decides for its platform and mode. */
	plainLabel?: boolean;
	/** The text's prose slot, where a calculated value's chip prints its
	 *  formula. Absent leaves the nearest `ProseSlotScope`'s. */
	proseSlot?: ProseSlotRef;
}

/** One atom's chip: a reference resolved through the provider, or a
 *  calculated value's formula. */
function atomChip(
	part: ProseAtomPart,
	key: string | number,
	provider: ReferenceProvider | null,
	formUuid: string | undefined,
): ReactNode {
	if (part.kind === "value") return <ProseValueAtom key={key} part={part} />;
	const projected =
		provider?.projectPart(part, formUuid) ??
		({
			ok: false,
			unresolved: unresolvedReferenceProjection(part),
		} as const);
	return projected.ok ? (
		<ReferenceChip key={key} reference={projected.reference} />
	) : (
		<UnresolvedReferenceChip key={key} unresolved={projected.unresolved} />
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
		return (
			// biome-ignore lint/suspicious/noArrayIndexKey: canonical ordered prose parts
			<Fragment key={index}>
				{atomChip(part, index, provider, formUuid)}
			</Fragment>
		);
	});
}

interface RenderTemplate {
	markdown: string;
	refs: Map<string, ProseAtomPart>;
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

	const refs = new Map<string, ProseAtomPart>();
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
	refs: ReadonlyMap<string, ProseAtomPart>,
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
		result.push(atomChip(part, marker, provider, formUuid));
		cursor = index + marker.length;
	}
	if (cursor < text.length) result.push(text.slice(cursor));
	return result;
}

function chipRule(
	refs: ReadonlyMap<string, ProseAtomPart>,
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
	proseSlot,
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
	const scoped = (content: ReactNode) =>
		proseSlot === undefined ? (
			content
		) : (
			<ProseSlotScope slot={proseSlot}>{content}</ProseSlotScope>
		);

	/* The wrapper's `white-space: break-spaces` keeps the written line
	 * breaks; nothing here parses the text. */
	if (plainLabel) {
		return (
			<div className={wrapperCls}>
				{!isEditMode && resolvedLabel !== undefined
					? resolvedLabel
					: scoped(textWithChips(label, provider, formUuid))}
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
			{scoped(<Markdown options={options}>{rendered.markdown}</Markdown>)}
		</div>
	);
}
