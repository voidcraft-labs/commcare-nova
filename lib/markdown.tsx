/**
 * Unified read-only markdown rendering via markdown-to-jsx.
 *
 * Single source of truth for all non-editor markdown surfaces. Two variants:
 * - **Chat** (`ChatMarkdown`) — allowlist security: strips links + images and
 *   renders raw HTML as inert text. Used for the SA's chat + reasoning output, which
 *   is model-generated and must not produce clickable links, injected markup, or
 *   stray elements (the model's thinking routinely contains XML-ish tokens like
 *   `<mother>` — without `disableParsingRawHTML` those parse to unknown DOM
 *   elements and crash the render).
 * - **Preview** (`PreviewMarkdown`) — links (`target="_blank"`) + images allowed,
 *   raw HTML still rendered as inert text. Used for form labels, validation
 *   errors, and select option labels (SA-authored, so the same raw-HTML guard
 *   applies; markdown links/images come from markdown syntax, not raw tags).
 *
 * Both variants support `breaks: true` semantics (single newlines → `<br>`)
 * via a custom `renderRule`, since markdown-to-jsx has no native breaks option.
 *
 * Reference chip injection (for `#form/x`, `#patient/x`, `#user/x` patterns)
 * is composed on top of either variant via `withChipInjection()` — used by
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

/** Options for chat messages — strips links + images; raw HTML is escaped to
 *  text (`disableParsingRawHTML`) so model output like `<mother>` renders as the
 *  literal text rather than parsing to an unknown DOM element that crashes. */
export const CHAT_OPTIONS: MarkdownToJSX.Options = {
	overrides: { ...TABLE_KEY_OVERRIDES, ...CHAT_SECURITY_OVERRIDES },
	renderRule: breaksRenderRule,
	slugify: noSlug,
	disableParsingRawHTML: true,
};

/** Options for preview surfaces — links open in new tab, images allowed (both
 *  from markdown syntax); raw `<tag>` HTML is escaped to text, same guard as
 *  chat (these labels are SA-authored). */
export const PREVIEW_OPTIONS: MarkdownToJSX.Options = {
	overrides: { ...TABLE_KEY_OVERRIDES, ...PREVIEW_LINK_OVERRIDES },
	renderRule: breaksRenderRule,
	slugify: noSlug,
	disableParsingRawHTML: true,
};

/** Preview with forceInline — for rendering inside <span> contexts. */
const PREVIEW_OPTIONS_INLINE: MarkdownToJSX.Options = {
	...PREVIEW_OPTIONS,
	forceInline: true,
};

/* ---------------------------------------------------------------------------
 * Label rendering per runtime
 *
 * Each CommCare runtime renders a label's markdown form with its own
 * renderer: Web Apps with markdown-it (`breaks: true`, raw HTML shown as
 * written), Android with Markwon. The running preview draws the platform it
 * plays (`lib/preview/platform.ts`, `labelMarkdown`), so these three choices
 * reshape the preview options:
 *
 * - `singleNewline: "space"` drops the breaks rule, so a single newline
 *   inside a paragraph reads as a space;
 * - `html: "dropped"` removes raw HTML tags and keeps their text;
 * - `images: "alt-text"` draws an image as its alt text, with no image.
 *
 * `PREVIEW_LABEL_RENDERING` is today's preview rendering, the Web Apps one.
 * ------------------------------------------------------------------------ */

export interface LabelMarkdownRendering {
	readonly singleNewline: "break" | "space";
	readonly html: "literal" | "dropped";
	readonly images: "shown" | "alt-text";
}

export const PREVIEW_LABEL_RENDERING: LabelMarkdownRendering = Object.freeze({
	singleNewline: "break",
	html: "literal",
	images: "shown",
});

/** A raw HTML tag as it stands in a text node once raw HTML parsing is off:
 *  `<b>`, `</b>`, `<br/>`, `<span class="x">`. */
const RAW_HTML_TAG = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/;
const RAW_HTML_TAGS = new RegExp(RAW_HTML_TAG.source, "g");

/** One text-node rule for a label rendering: raw HTML tags dropped (their
 *  text kept) where the runtime drops them, then single newlines broken
 *  where it breaks them. */
function labelTextRule(rendering: LabelMarkdownRendering): RenderRule {
	return (next, node, _renderChildren, state) => {
		if (node.type !== RuleType.text || typeof node.text !== "string")
			return next();
		const dropTags =
			rendering.html === "dropped" && RAW_HTML_TAG.test(node.text);
		const text = dropTags ? node.text.replace(RAW_HTML_TAGS, "") : node.text;
		if (rendering.singleNewline === "break" && text.includes("\n")) {
			const parts = text.split("\n");
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
		return dropTags ? <Fragment key={state.key}>{text}</Fragment> : next();
	};
}

function AltTextImage({ alt }: { alt?: string }) {
	return <>{alt ?? ""}</>;
}

const renderingOptionsCache = new Map<string, MarkdownToJSX.Options>();

/** The preview options for one label rendering, built once per combination
 *  so markdown-to-jsx keeps seeing the same object. */
export function previewOptionsFor(
	rendering: LabelMarkdownRendering = PREVIEW_LABEL_RENDERING,
	inline = false,
): MarkdownToJSX.Options {
	const key = `${rendering.singleNewline}:${rendering.html}:${rendering.images}:${inline}`;
	const cached = renderingOptionsCache.get(key);
	if (cached !== undefined) return cached;
	const options: MarkdownToJSX.Options = {
		...PREVIEW_OPTIONS,
		overrides: {
			...TABLE_KEY_OVERRIDES,
			...PREVIEW_LINK_OVERRIDES,
			...(rendering.images === "alt-text"
				? { img: { component: AltTextImage } }
				: {}),
		},
		renderRule: labelTextRule(rendering),
		...(inline ? { forceInline: true } : {}),
	};
	renderingOptionsCache.set(key, options);
	return options;
}

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
	/** How the runtime Preview plays renders a label; absent is today's
	 *  preview rendering. */
	rendering?: LabelMarkdownRendering;
}

/** Render markdown for preview surfaces (links/images allowed). */
export function PreviewMarkdown({
	children,
	inline,
	rendering,
}: PreviewMarkdownProps) {
	const options =
		rendering === undefined
			? inline
				? PREVIEW_OPTIONS_INLINE
				: PREVIEW_OPTIONS
			: previewOptionsFor(rendering, inline);
	return <Markdown options={options}>{children}</Markdown>;
}
