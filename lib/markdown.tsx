/**
 * Unified read-only markdown rendering via markdown-to-jsx.
 *
 * Single source of truth for all non-editor markdown surfaces. Two variants:
 * - **Chat** (`ChatMarkdown`) — allowlist security: strips links, images, and
 *   raw HTML. Used for assistant messages where untrusted content must not
 *   produce clickable links or injected markup.
 * - **Preview** (`PreviewMarkdown`) — full rendering with links (`target="_blank"`)
 *   and images. Used for form labels, validation errors, and
 *   select option labels.
 *
 * Both variants support `breaks: true` semantics (single newlines → `<br>`)
 * via a custom `renderRule`, since markdown-to-jsx has no native breaks option.
 *
 * Reference chip injection (for `#form/x`, `#case/x`, `#user/x` patterns) is
 * composed on top of either variant via `withChipInjection()` — used by
 * `LabelContent` to render chips inline within markdown formatting.
 *
 * tiptap-markdown handles editor I/O (markdown ↔ ProseMirror) separately —
 * that's a serialization layer, not a renderer.
 */

import Markdown, { type MarkdownToJSX, RuleType } from "markdown-to-jsx";
import { Children, createElement, Fragment, type ReactNode } from "react";

/* ---------------------------------------------------------------------------
 * Table key workaround
 *
 * markdown-to-jsx renders thead/tbody as a keyless array inside <table>,
 * triggering React's "unique key prop" console warning. Spreading the keyed
 * array as positional args to createElement bypasses the array wrapper.
 *
 * Upstream fix: https://github.com/quantizor/markdown-to-jsx/pull/859
 * TODO: Remove TABLE_KEY_OVERRIDES and keyedEl once PR #859 is merged and
 * markdown-to-jsx is bumped past 9.7.13.
 * ------------------------------------------------------------------------ */

interface KeyedElProps extends React.PropsWithChildren {
	[key: string]: unknown;
}

function keyedEl(tag: string, { children, ...rest }: KeyedElProps) {
	return createElement(tag, rest, ...Children.toArray(children));
}

const TABLE_KEY_OVERRIDES: MarkdownToJSX.Overrides = {
	table: { component: (p: KeyedElProps) => keyedEl("table", p) },
	thead: { component: (p: KeyedElProps) => keyedEl("thead", p) },
	tbody: { component: (p: KeyedElProps) => keyedEl("tbody", p) },
};

/* ---------------------------------------------------------------------------
 * Breaks renderRule
 *
 * markdown-to-jsx has no `breaks: true` option. This renderRule intercepts
 * text nodes containing literal newlines and splits them into text segments
 * interleaved with <br /> elements — replicating GFM softbreak behavior.
 * Runs after parsing, so code blocks and other non-text nodes are unaffected.
 * ------------------------------------------------------------------------ */

function breaksRenderRule(
	next: () => ReactNode,
	node: MarkdownToJSX.ASTNode,
	_renderChildren: MarkdownToJSX.ASTRender,
	state: MarkdownToJSX.State,
): ReactNode {
	if (
		node.type === RuleType.text &&
		typeof node.text === "string" &&
		node.text.includes("\n")
	) {
		const parts = node.text.split("\n");
		return (
			<Fragment key={state.key}>
				{parts.map((part, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: static text splits from \n — never reorder
					<Fragment key={i}>
						{part}
						{i < parts.length - 1 && <br />}
					</Fragment>
				))}
			</Fragment>
		);
	}
	return next();
}

/* ---------------------------------------------------------------------------
 * Render rule composition
 *
 * Chains multiple renderRule functions in middleware style: each rule receives
 * a `next` that delegates to the following rule, and the final rule calls
 * markdown-to-jsx's default renderer. Allows chip injection to layer on top
 * of breaks handling without either knowing about the other.
 * ------------------------------------------------------------------------ */

type RenderRule = NonNullable<MarkdownToJSX.Options["renderRule"]>;

export function composeRenderRules(
	...rules: (MarkdownToJSX.Options["renderRule"] | undefined)[]
): MarkdownToJSX.Options["renderRule"] {
	const defined = rules.filter(Boolean) as RenderRule[];
	if (defined.length === 0) return undefined;
	if (defined.length === 1) return defined[0];
	return (next, node, renderChildren, state) => {
		let i = 0;
		const chain = (): ReactNode => {
			if (i >= defined.length) return next();
			const rule = defined[i++];
			return rule(chain, node, renderChildren, state);
		};
		return chain();
	};
}

/* ---------------------------------------------------------------------------
 * Chat security overrides
 *
 * Strips links (renders text content only), images (renders alt text only),
 * raw HTML inputs (renders nothing), and blockquotes (renders content without
 * wrapper). Matches the allowlist behavior of the old marked-based renderer.
 * ------------------------------------------------------------------------ */

function StripLink({ children }: React.PropsWithChildren) {
	return <>{children}</>;
}

function StripImage({ alt, title }: { alt?: string; title?: string }) {
	return <>{title || alt || ""}</>;
}

function StripInput() {
	return null;
}

function PassthroughBlockquote({ children }: React.PropsWithChildren) {
	return <>{children}</>;
}

const CHAT_SECURITY_OVERRIDES: MarkdownToJSX.Overrides = {
	a: { component: StripLink },
	img: { component: StripImage },
	input: { component: StripInput },
	blockquote: { component: PassthroughBlockquote },
};

/* ---------------------------------------------------------------------------
 * Preview link override
 *
 * Links open in a new tab with noopener/noreferrer — standard CommCare
 * behavior for user-authored content.
 * ------------------------------------------------------------------------ */

function ExternalLink({
	children,
	href,
	...rest
}: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
	return (
		<a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
			{children}
		</a>
	);
}

const PREVIEW_LINK_OVERRIDES: MarkdownToJSX.Overrides = {
	a: { component: ExternalLink },
};

/* ---------------------------------------------------------------------------
 * Stable options objects
 *
 * Module-level constants so markdown-to-jsx's internal useMemo sees the same
 * reference across renders and skips re-parsing unchanged content.
 * ------------------------------------------------------------------------ */

const noSlug = () => "";

/** Options for chat messages — strips links, images, and raw HTML. */
export const CHAT_OPTIONS: MarkdownToJSX.Options = {
	overrides: { ...TABLE_KEY_OVERRIDES, ...CHAT_SECURITY_OVERRIDES },
	renderRule: breaksRenderRule,
	slugify: noSlug,
};

/** Options for preview surfaces — links open in new tab, images allowed. */
export const PREVIEW_OPTIONS: MarkdownToJSX.Options = {
	overrides: { ...TABLE_KEY_OVERRIDES, ...PREVIEW_LINK_OVERRIDES },
	renderRule: breaksRenderRule,
	slugify: noSlug,
};

/** Preview with forceInline — for rendering inside <span> contexts. */
const PREVIEW_OPTIONS_INLINE: MarkdownToJSX.Options = {
	...PREVIEW_OPTIONS,
	forceInline: true,
};

/* ---------------------------------------------------------------------------
 * Chip injection composition
 *
 * Layers a reference chip renderRule on top of a base options object. The
 * caller provides the chip renderRule (which detects ref patterns in text
 * nodes and replaces them with ReferenceChip components); this function
 * composes it with the base's existing renderRule (breaksRenderRule) so
 * both operate on the same text nodes without conflict.
 * ------------------------------------------------------------------------ */

/** Compose a chip-detecting renderRule on top of existing options. */
export function withChipInjection(
	baseOptions: MarkdownToJSX.Options,
	chipRule: RenderRule,
): MarkdownToJSX.Options {
	return {
		...baseOptions,
		renderRule: composeRenderRules(chipRule, baseOptions.renderRule),
	};
}

/* ---------------------------------------------------------------------------
 * Wrapper components
 * ------------------------------------------------------------------------ */

/** Render markdown for chat messages (links/images/HTML stripped). */
export function ChatMarkdown({ children }: { children: string }) {
	return <Markdown options={CHAT_OPTIONS}>{children}</Markdown>;
}

interface PreviewMarkdownProps {
	children: string;
	/**
	 * When true, forces inline rendering (no block elements like <p>).
	 * Use when the markdown content lives inside a <span> or other inline context.
	 */
	inline?: boolean;
}

/** Render markdown for preview surfaces (links/images allowed). */
export function PreviewMarkdown({ children, inline }: PreviewMarkdownProps) {
	return (
		<Markdown options={inline ? PREVIEW_OPTIONS_INLINE : PREVIEW_OPTIONS}>
			{children}
		</Markdown>
	);
}
