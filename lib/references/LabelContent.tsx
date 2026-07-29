/**
 * Render canonical prose templates as Markdown with structural reference chips.
 *
 * Literal text is handed to Markdown unchanged, including hashtag-looking
 * text. Only typed reference parts become chips. The temporary render markers
 * below exist solely inside this render call; they are never authored, parsed
 * into domain state, or persisted.
 */

"use client";
import Markdown, { type MarkdownToJSX, RuleType } from "markdown-to-jsx";
import { Fragment, type ReactNode, useMemo } from "react";
import type { ProseReferencePart, ProseTemplate } from "@/lib/domain";
import { PREVIEW_OPTIONS, withChipInjection } from "@/lib/markdown";
import type { ReferenceProvider } from "./provider";
import { ReferenceChip } from "./ReferenceChip";
import { useCurrentFormUuid, useReferenceProvider } from "./ReferenceContext";

interface LabelContentProps {
	label: ProseTemplate;
	resolvedLabel?: string;
	isEditMode: boolean;
	className: string;
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
		const ref = provider?.resolvePart(part, formUuid);
		return ref ? (
			// biome-ignore lint/suspicious/noArrayIndexKey: canonical ordered prose parts
			<ReferenceChip key={index} reference={ref} />
		) : (
			// biome-ignore lint/suspicious/noArrayIndexKey: canonical ordered prose parts
			<Fragment key={index}>{fallbackProjection(part)}</Fragment>
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
		const ref = provider?.resolvePart(part, formUuid);
		result.push(
			ref ? (
				<ReferenceChip key={marker} reference={ref} />
			) : (
				<Fragment key={marker}>{fallbackProjection(part)}</Fragment>
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
}: LabelContentProps) {
	const provider = useReferenceProvider();
	const formUuid = useCurrentFormUuid();
	const rendered = useMemo(() => makeRenderTemplate(label), [label]);
	const options = useMemo(
		() =>
			withChipInjection(
				PREVIEW_OPTIONS,
				chipRule(rendered.refs, provider, formUuid),
			),
		[rendered, provider, formUuid],
	);
	const wrapperCls = `preview-markdown ${className}`;

	if (!isEditMode && resolvedLabel !== undefined) {
		return (
			<div className={wrapperCls}>
				<Markdown options={PREVIEW_OPTIONS}>{resolvedLabel}</Markdown>
			</div>
		);
	}

	return (
		<div className={wrapperCls}>
			<Markdown options={options}>{rendered.markdown}</Markdown>
		</div>
	);
}

function fallbackProjection(part: ProseReferencePart): string {
	switch (part.kind) {
		case "field-ref":
			return `#form/${part.uuid}`;
		case "case-ref":
			return `#${part.caseType}/${part.property}`;
		case "user-property-ref":
			return `#user/${part.userPropertyUuid}`;
		case "user-ref":
			return `#user/${part.property}`;
		default: {
			const _exhaustive: never = part;
			return _exhaustive;
		}
	}
}
