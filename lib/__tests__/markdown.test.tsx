import Markdown, { type MarkdownToJSX, RuleType } from "markdown-to-jsx";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	ChatMarkdown,
	composeRenderRules,
	type LabelMarkdownRendering,
	labelMarkdownOptions,
	PREVIEW_LABEL_RENDERING,
	PreviewMarkdown,
	withChipInjection,
} from "../markdown";

const WEB_APPS = PREVIEW_LABEL_RENDERING;
const ANDROID: LabelMarkdownRendering = {
	singleNewline: "space",
	html: "dropped",
	images: "alt-text",
};

/** A label rendered as the running preview renders it on a runtime. */
function label(text: string, rendering = WEB_APPS): string {
	return html(<PreviewMarkdown rendering={rendering}>{text}</PreviewMarkdown>);
}

/** Render a React element to an HTML string for assertion. */
function html(element: React.ReactElement): string {
	return renderToStaticMarkup(element);
}

/** The text a reader sees in rendered markup: every tag removed until none
 * is left, so a tag that removing another one forms is removed too. */
function visibleText(markup: string): string {
	let text = markup;
	for (;;) {
		const next = text.replace(/<[^>]*>/g, "");
		if (next === text) return text.replace(/\s+/g, " ").trim();
		text = next;
	}
}

/* ---------------------------------------------------------------------------
 * Chat security
 * ------------------------------------------------------------------------ */

describe("ChatMarkdown", () => {
	it("strips links, rendering text content only", () => {
		const output = html(
			<ChatMarkdown>{"[click me](https://evil.com)"}</ChatMarkdown>,
		);
		expect(output).toContain("click me");
		expect(output).not.toContain("<a");
		expect(output).not.toContain("href");
	});

	it("strips images, rendering alt text only", () => {
		const output = html(
			<ChatMarkdown>{"![photo](https://evil.com/img.png)"}</ChatMarkdown>,
		);
		expect(output).toContain("photo");
		expect(output).not.toContain("<img");
	});

	it("strips raw HTML tags", () => {
		const output = html(
			<ChatMarkdown>{'<script>alert("xss")</script>safe text'}</ChatMarkdown>,
		);
		expect(output).toContain("safe text");
		expect(output).not.toContain("<script");
	});

	it("renders an unknown tag from model output as inert text, not an element", () => {
		// The SA's reasoning routinely contains XML-ish tokens (e.g. discussing a
		// <mother> case). Without disabling raw-HTML parsing these became unknown
		// DOM elements and crashed the render — they must show as literal text.
		const output = html(
			<ChatMarkdown>{"closing the <mother> case"}</ChatMarkdown>,
		);
		expect(output).toContain("closing the &lt;mother&gt; case");
		expect(output).not.toContain("<mother");
	});

	it("renders bold, italic, and code", () => {
		const output = html(
			<ChatMarkdown>{"**bold** *italic* `code`"}</ChatMarkdown>,
		);
		expect(output).toContain("<strong>bold</strong>");
		expect(output).toContain("<em>italic</em>");
		expect(output).toContain("<code>code</code>");
	});

	it("renders headings", () => {
		const output = html(
			<ChatMarkdown>{"# Heading 1\n\n## Heading 2"}</ChatMarkdown>,
		);
		expect(output).toContain("<h1");
		expect(output).toContain("Heading 1");
		expect(output).toContain("<h2");
		expect(output).toContain("Heading 2");
	});

	it("renders lists", () => {
		const output = html(<ChatMarkdown>{"- item 1\n- item 2"}</ChatMarkdown>);
		expect(output).toContain("<ul>");
		expect(output).toContain("<li>item 1</li>");
		expect(output).toContain("<li>item 2</li>");
	});

	it("renders tables", () => {
		const output = html(
			<ChatMarkdown>{"| A | B |\n|---|---|\n| 1 | 2 |"}</ChatMarkdown>,
		);
		expect(output).toContain("<table>");
		expect(output).toContain("<th");
		expect(output).toContain("<td");
	});
});

/* ---------------------------------------------------------------------------
 * Preview rendering
 * ------------------------------------------------------------------------ */

describe("PreviewMarkdown", () => {
	it('renders a web link with target="_blank" and rel="noopener noreferrer"', () => {
		const output = label("[docs](https://example.com)");
		expect(output).toContain("<a");
		expect(output).toContain('href="https://example.com"');
		expect(output).toContain('target="_blank"');
		expect(output).toContain('rel="noopener noreferrer"');
		expect(output).toContain("docs</a>");
	});

	it("renders inline when inline prop is set (no block elements)", () => {
		const output = html(
			<PreviewMarkdown inline rendering={WEB_APPS}>
				{"**bold** text"}
			</PreviewMarkdown>,
		);
		/* forceInline should prevent <p> wrapping — content is inline. */
		expect(output).not.toContain("<p>");
		expect(output).toContain("<strong>bold</strong>");
	});
});

/* ---------------------------------------------------------------------------
 * What label text may make the page do
 *
 * In the running preview a value is substituted into a label before the
 * whole is formatted, as Core does before Web Apps or Android draws it, so a
 * case name or an answer can carry formatting: it shows as on a device, and
 * nothing in the text, the author's or a value's, opens a link a device
 * would not make, opens anything but a web address, or makes the page
 * request anything.
 * ------------------------------------------------------------------------ */

describe("a label's text on the builder's page", () => {
	it("formats a substituted value as the device does", () => {
		// `Patient: {{#case/case_name}}` over a case named with formatting.
		const output = label(
			"Patient: **Asha** [site](https://example.org) https://bare.example",
		);
		expect(output).toContain("<strong>Asha</strong>");
		expect(output).toContain('href="https://example.org"');
		// Neither runtime links a bare address: markdown-it is built without
		// linkify, and Android's Markwon has no linkify plugin.
		expect(output).not.toContain('href="https://bare.example"');
		expect(visibleText(output)).toContain("https://bare.example");
	});

	it("links no bare address, mail address or www name, and keeps a CommonMark autolink", () => {
		for (const text of [
			"see https://bare.example now",
			"write to a@b.example",
			"www.example.com",
		])
			expect(label(text)).not.toContain("<a");
		expect(label("<https://angle.example>")).toContain(
			'href="https://angle.example"',
		);
	});

	it("opens only a web address, and draws any other link as its words", () => {
		for (const address of [
			"intent://scan/#Intent;end",
			"file:///etc/hosts",
			"javascript:alert(1)",
			"tel:+15555550123",
			"mailto:a@b.example",
			"/build/app",
		]) {
			const output = label(`[open](${address})`);
			expect(output).not.toContain("<a");
			expect(output).not.toContain("href");
			expect(visibleText(output)).toBe("open");
		}
	});

	it("never fetches a picture: a picture at an address draws its description on every runtime", () => {
		for (const rendering of [WEB_APPS, ANDROID]) {
			const output = label(
				"![x-ray](https://storage.googleapis.com/any/p.png?case=asha)",
				rendering,
			);
			expect(output).not.toContain("<img");
			// React would preload an <img> it renders: no hint either.
			expect(output).not.toContain("<link");
			expect(output).not.toContain("storage.googleapis.com");
			expect(visibleText(output)).toBe("x-ray");
		}
	});

	it("draws a picture inside the label where Web Apps draws one, and its description on Android", () => {
		const png = "![dot](data:image/png;base64,iVBORw0KGgo=)";
		expect(label(png)).toContain('src="data:image/png;base64,iVBORw0KGgo="');
		expect(label(png, ANDROID)).not.toContain("<img");
		// A kind Web Apps' renderer refuses is described, not drawn.
		expect(label("![svg](data:image/svg+xml;base64,PHN2Zy8+)")).not.toContain(
			"<img",
		);
	});

	it("holds the same policy with reference chips layered on", () => {
		const options = withChipInjection(labelMarkdownOptions(WEB_APPS), (next) =>
			next(),
		);
		const output = html(
			<Markdown options={options}>
				{"https://bare.example [x](file:///etc) ![p](https://a.example/p.png)"}
			</Markdown>,
		);
		expect(output).not.toContain("<a");
		expect(output).not.toContain("<img");
	});
});

/* ---------------------------------------------------------------------------
 * Breaks behavior (single newlines → <br>)
 * ------------------------------------------------------------------------ */

describe("breaks behavior", () => {
	it("converts single newlines to <br> in chat markdown", () => {
		const output = html(<ChatMarkdown>{"line 1\nline 2"}</ChatMarkdown>);
		expect(output).toContain("<br/>");
		expect(output).toContain("line 1");
		expect(output).toContain("line 2");
	});

	it("converts single newlines to <br> in a Web Apps label", () => {
		expect(label("line 1\nline 2")).toContain("<br/>");
	});

	it("does not add <br> when there are no newlines", () => {
		const output = html(<ChatMarkdown>{"no newlines here"}</ChatMarkdown>);
		expect(output).not.toContain("<br");
	});
});

/* ---------------------------------------------------------------------------
 * composeRenderRules
 * ------------------------------------------------------------------------ */

describe("composeRenderRules", () => {
	/** Helper: a renderRule that matches text containing a marker and replaces it. */
	function markerRule(
		marker: string,
		replacement: string,
	): NonNullable<MarkdownToJSX.Options["renderRule"]> {
		return (next, node, _renderChildren, state) => {
			if (
				node.type === RuleType.text &&
				typeof node.text === "string" &&
				node.text.includes(marker)
			) {
				return (
					<span key={state.key}>{node.text.replace(marker, replacement)}</span>
				);
			}
			return next();
		};
	}

	it("returns undefined when no rules are provided", () => {
		expect(composeRenderRules()).toBeUndefined();
	});

	it("returns the single rule when only one is provided", () => {
		const rule = markerRule("x", "y");
		expect(composeRenderRules(rule)).toBe(rule);
	});

	it("first rule takes priority when both match", () => {
		const composed = composeRenderRules(
			markerRule("hello", "FIRST"),
			markerRule("hello", "SECOND"),
		);
		expect(composed).toBeDefined();
		const output = html(
			<Markdown options={{ renderRule: composed }}>{"hello world"}</Markdown>,
		);
		expect(output).toContain("FIRST");
		expect(output).not.toContain("SECOND");
	});

	it("falls through to second rule when first does not match", () => {
		const composed = composeRenderRules(
			markerRule("NOMATCH", "FIRST"),
			markerRule("hello", "SECOND"),
		);
		expect(composed).toBeDefined();
		const output = html(
			<Markdown options={{ renderRule: composed }}>{"hello world"}</Markdown>,
		);
		expect(output).toContain("SECOND");
	});

	it("falls through to default rendering when no rules match", () => {
		const composed = composeRenderRules(
			markerRule("NOMATCH1", "FIRST"),
			markerRule("NOMATCH2", "SECOND"),
		);
		expect(composed).toBeDefined();
		const output = html(
			<Markdown options={{ renderRule: composed }}>{"hello world"}</Markdown>,
		);
		expect(output).toContain("hello world");
	});

	it("filters out undefined rules", () => {
		const rule = markerRule("hello", "MATCH");
		const composed = composeRenderRules(undefined, rule, undefined);
		/* Should simplify to the single rule. */
		expect(composed).toBe(rule);
	});
});

/* ---------------------------------------------------------------------------
 * withChipInjection
 * ------------------------------------------------------------------------ */

describe("withChipInjection", () => {
	it("composes a chip rule on top of base options", () => {
		const chipRule: NonNullable<MarkdownToJSX.Options["renderRule"]> = (
			next,
			node,
			_rc,
			state,
		) => {
			if (
				node.type === RuleType.text &&
				typeof node.text === "string" &&
				node.text.includes("#chip")
			) {
				return (
					<span key={state.key} data-testid="chip">
						CHIP
					</span>
				);
			}
			return next();
		};

		const options = withChipInjection(labelMarkdownOptions(WEB_APPS), chipRule);
		const output = html(
			<Markdown options={options}>{"text with #chip ref"}</Markdown>,
		);
		expect(output).toContain('data-testid="chip"');
		expect(output).toContain("CHIP");
	});

	it("preserves breaks behavior when chip rule does not match", () => {
		const chipRule: NonNullable<MarkdownToJSX.Options["renderRule"]> = (next) =>
			next();

		const options = withChipInjection(labelMarkdownOptions(WEB_APPS), chipRule);
		const output = html(
			<Markdown options={options}>{"line 1\nline 2"}</Markdown>,
		);
		expect(output).toContain("<br/>");
	});
});

describe("untrusted HTML stays literal in both renderers", () => {
	it.each([
		["chat", (text: string) => html(<ChatMarkdown>{text}</ChatMarkdown>)],
		["a label", (text: string) => label(text)],
	])("escapes elements and preserves author text in %s", (_name, render) => {
		const output = render(
			'<img src=x onerror="run()"><iframe src="https://evil.test">literal</iframe>',
		);
		expect(output).not.toContain("<img");
		expect(output).not.toContain("<iframe");
		expect(output).toContain("&lt;img");
		expect(output).toContain("&lt;iframe");
		expect(output).toContain("literal");
	});
	it("preserves newlines inside code blocks instead of injecting breaks", () => {
		const output = html(
			<ChatMarkdown>{"```text\nfirst\nsecond\n```"}</ChatMarkdown>,
		);
		expect(output).toContain("first\nsecond");
		expect(output).not.toContain("<br");
	});
});

/* ---------------------------------------------------------------------------
 * Label rendering per runtime
 * ------------------------------------------------------------------------ */

describe("PreviewMarkdown's label rendering", () => {
	const LABEL = "a\nb ![x](y) <b>c</b>";

	it("renders Web Apps': breaks, literal HTML, a picture at an address described", () => {
		const output = label(LABEL);
		expect(output).toContain("<br/>");
		expect(output).not.toContain("<img");
		expect(output).toContain("&lt;b&gt;c&lt;/b&gt;");
	});

	it("joins a single newline, draws an image as its alt text and drops raw HTML", () => {
		const output = label(LABEL, ANDROID);
		expect(output).not.toContain("<br");
		expect(output).not.toContain("<img");
		expect(output).not.toContain("&lt;b&gt;");
		expect(visibleText(output)).toBe("a b x c");
	});

	it("drops raw HTML and still breaks lines where the runtime breaks them", () => {
		const output = label("one <i>two</i>\nthree", {
			singleNewline: "break",
			html: "dropped",
			images: "shown",
		});
		expect(output).toContain("<br/>");
		expect(output).not.toContain("&lt;i&gt;");
		expect(output).toContain("two");
	});
});
