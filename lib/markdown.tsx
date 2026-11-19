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
 * - **Label** (`PreviewMarkdown`, and `LabelContent` through it): a label,
 *   hint, help text, choice or Search subtitle as the runtime Preview plays
 *   formats it. Its text is not only the author's: in the running preview a
 *   value is substituted into the label before the whole is formatted, as
 *   Core does before Web Apps or Android draws it
 *   (`FormEntryCaption.getSpecialFormQuestionText` →
 *   `FormDef.fillTemplateString`), and a lookup-backed choice's label is a
 *   lookup row's cell. So formatting inside a case property or an answer
 *   shows as it does on a device, and one policy holds whoever wrote the
 *   text (`labelMarkdownOptions`): label text makes the builder's page do
 *   nothing a device's label cannot do, and nothing without a click. A bare
 *   address is text, as on both runtimes; a link opens only a web address;
 *   a picture is drawn only from inside the label itself, never fetched, so
 *   label text causes no network request; raw HTML stays inert text.
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
import {
	Children,
	createElement,
	Fragment,
	type ReactNode,
	useMemo,
} from "react";
import { isOpenableAddress } from "@/lib/links/openableAddress";

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

export type RenderRule = NonNullable<MarkdownToJSX.Options["renderRule"]>;

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

/* ---------------------------------------------------------------------------
 * Label rendering per runtime
 *
 * Each CommCare runtime renders a label's markdown form with its own
 * renderer: Web Apps with markdown-it (`breaks: true`, raw HTML shown as
 * written), Android with Markwon. The running preview draws the platform it
 * plays (`lib/preview/platform.ts`, `labelMarkdown`), so these three choices
 * reshape the label options:
 *
 * - `singleNewline: "space"` drops the breaks rule, so a single newline
 *   inside a paragraph reads as a space;
 * - `html: "dropped"` removes raw HTML tags and keeps their text;
 * - `images: "alt-text"` draws an image as its alt text, with no image.
 *
 * `PREVIEW_LABEL_RENDERING` is the Web Apps one, which the builder's edit
 * mode shows.
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

/* ---------------------------------------------------------------------------
 * What label text may make the page do
 *
 * A link opens in a new tab, as both runtimes open one, and only where its
 * address is a web address (`lib/links/openableAddress.ts`, the guard the
 * link column holds too): any other scheme (`file:`, `intent:`, `tel:`, a
 * relative path) draws the link's words with no anchor. A picture is drawn
 * only where its address is inside the label, an image `data:` address of a
 * kind markdown-it draws (`validateLink`'s `GOOD_DATA_RE`: GIF, PNG, JPEG,
 * WebP); a picture at any other address draws its description, as Android
 * draws every picture, so no label text, the author's or a value's, makes the
 * builder's page request anything.
 * ------------------------------------------------------------------------ */

function LabelLink({
	children,
	href,
	...rest
}: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
	if (href === undefined || !isOpenableAddress(href)) return <>{children}</>;
	return (
		<a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
			{children}
		</a>
	);
}

/** An image `data:` address of a kind Web Apps' renderer draws: the picture
 *  is inside the label, so drawing it requests nothing. */
function isInlinePicture(src: string): boolean {
	try {
		const address = new URL(src);
		if (address.protocol !== "data:") return false;
		const kind = address.pathname.toLowerCase();
		return ["image/gif;", "image/png;", "image/jpeg;", "image/webp;"].some(
			(prefix) => kind.startsWith(prefix),
		);
	} catch {
		return false;
	}
}

function DescribedPicture({ alt }: { alt?: string }) {
	return <>{alt ?? ""}</>;
}

/** The picture of a label the runtime draws pictures for. */
function InlinePicture({
	alt,
	src,
	title,
}: {
	alt?: string;
	src?: string;
	title?: string;
}) {
	if (src === undefined || !isInlinePicture(src))
		return <DescribedPicture alt={alt} />;
	// biome-ignore lint/performance/noImgElement: a markdown picture drawn from its own data address, never fetched
	return <img alt={alt ?? ""} src={src} title={title} />;
}

const labelOptionsCache = new Map<string, MarkdownToJSX.Options>();

/** The options a label renders with on one runtime: the runtime's own
 *  formatting rules, and what label text may make the page do (above). Built
 *  once per combination so markdown-to-jsx keeps seeing the same object. */
export function labelMarkdownOptions(
	rendering: LabelMarkdownRendering,
	inline = false,
): MarkdownToJSX.Options {
	const key = `${rendering.singleNewline}:${rendering.html}:${rendering.images}:${inline}`;
	const cached = labelOptionsCache.get(key);
	if (cached !== undefined) return cached;
	const options: MarkdownToJSX.Options = {
		overrides: {
			...TABLE_KEY_OVERRIDES,
			a: { component: LabelLink },
			img: {
				component:
					rendering.images === "shown" ? InlinePicture : DescribedPicture,
			},
		},
		renderRule: labelTextRule(rendering),
		slugify: noSlug,
		disableParsingRawHTML: true,
		disableAutoLink: true,
		...(inline ? { forceInline: true } : {}),
	};
	labelOptionsCache.set(key, options);
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
	/** How the runtime the text is shown for renders a label
	 *  (`lib/preview/platform.ts`, `labelMarkdown`); the builder's edit mode
	 *  passes `PREVIEW_LABEL_RENDERING`. */
	rendering: LabelMarkdownRendering;
	/**
	 * When true, forces inline rendering (no block elements like <p>).
	 * Use when the markdown content lives inside a <span> or other inline context.
	 */
	inline?: boolean;
	/** A text-node rule layered on the label's own (`withChipInjection`):
	 *  `LabelContent`'s reference chips. Keep its identity stable across
	 *  renders, as markdown-to-jsx re-parses on a new options object. */
	textRule?: RenderRule;
}

/** Render a label, hint, help text, choice or Search subtitle under the one
 *  label policy (`labelMarkdownOptions`). */
export function PreviewMarkdown({
	children,
	rendering,
	inline,
	textRule,
}: PreviewMarkdownProps) {
	const base = labelMarkdownOptions(rendering, inline);
	const options = useMemo(
		() => (textRule === undefined ? base : withChipInjection(base, textRule)),
		[base, textRule],
	);
	return <Markdown options={options}>{children}</Markdown>;
}
