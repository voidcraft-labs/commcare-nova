import { Node } from "@tiptap/core";
import { DOMParser, DOMSerializer, type Schema } from "@tiptap/pm/model";
import type { MarkdownNodeSpec } from "tiptap-markdown";
import {
	decodeProseReferencePart,
	PROSE_CARRIER_COMMENT,
	PROSE_CARRIER_MARK,
} from "./commcareRefNode";

/** A table the editor wrote as HTML must reopen as a table. Read it in an
 * inert template and pass only the schema's drawing of it to the editor's
 * HTML parser, including inert descriptions for external pictures. */
function editorTable(source: string, schema: Schema): string | null {
	const trimmed = source.trim();
	if (!/^<table[\s>]/i.test(trimmed)) return null;
	const template = document.createElement("template");
	template.innerHTML = trimmed;
	if (
		template.content.childNodes.length !== 1 ||
		template.content.firstElementChild?.localName !== "table"
	)
		return null;
	/* A label's own span can have the same attribute as a chip copied
	 * from an editor. Only a typed part was given the carrier comment. */
	for (const span of template.content.querySelectorAll(
		"span[data-nova-prose-ref]",
	)) {
		if (
			span.childNodes.length === 1 &&
			span.firstChild?.nodeType === 8 &&
			span.firstChild.nodeValue === PROSE_CARRIER_MARK
		)
			continue;
		const literal = template.content.ownerDocument.createElement("span");
		literal.setAttribute("data-nova-label-html", "");
		literal.textContent = span.outerHTML;
		span.replaceWith(literal);
	}
	const table = DOMParser.fromSchema(schema).parse(template.content).firstChild;
	if (table?.type !== schema.nodes.table) return null;
	const drawn = DOMSerializer.fromSchema(schema).serializeNode(table, {
		document: template.content.ownerDocument,
	});
	return (drawn as HTMLElement).outerHTML;
}

/** The editor writes HTML for a complex table, a break inside a pipe table,
 * and a typed reference. Other HTML in a label is the author's literal text.
 * Keep its spelling when the surrounding label is edited. */
const markdown: MarkdownNodeSpec = {
	serialize(state, node) {
		state.write(node.textContent);
	},
	parse: {
		setup(md) {
			if (md.renderer.rules.nova_label_html) return;
			md.renderer.rules.nova_label_html = (tokens, index) => {
				const token = tokens[index];
				const text = `<span data-nova-label-html="">${md.utils.escapeHtml(token.content)}</span>`;
				return token.block ? `<p>${text}</p>` : text;
			};
			const schema = this.editor.schema;
			const holdsReferences = schema.nodes.commcareRef !== undefined;
			const inert = document.implementation.createHTMLDocument();
			/* Markdown-it normally writes an img before TipTap parses the
			 * result. Use the same image drawing even for this first parse. */
			md.renderer.rules.image = (tokens, index, options, env, renderer) => {
				const token = tokens[index];
				const image = schema.nodes.image.create({
					src: token.attrGet("src"),
					title: token.attrGet("title"),
					alt: renderer.renderInlineAsText(token.children ?? [], options, env),
				});
				const drawn = DOMSerializer.fromSchema(schema).serializeNode(image, {
					document: inert,
				});
				return (drawn as HTMLElement).outerHTML;
			};
			md.core.ruler.after("inline", "nova_label_html", ({ tokens }) => {
				let inCell = false;
				for (const block of tokens) {
					if (block.type === "html_block") {
						const table = editorTable(block.content, schema);
						if (table === null) block.type = "nova_label_html";
						else block.content = table;
						continue;
					}
					if (block.type === "th_open" || block.type === "td_open")
						inCell = true;
					if (block.type === "th_close" || block.type === "td_close")
						inCell = false;
					const children = block.children ?? [];
					for (let i = 0; i < children.length; i++) {
						const token = children[i];
						if (token.type !== "html_inline") continue;
						if (inCell && /^<br\s*\/?>$/i.test(token.content)) continue;
						const part = /^<span data-nova-prose-ref="([^"]+)">$/.exec(
							token.content,
						);
						if (
							holdsReferences &&
							part &&
							children[i + 1]?.content === PROSE_CARRIER_COMMENT &&
							children[i + 2]?.content === "</span>" &&
							decodeProseReferencePart(part[1])
						) {
							i += 2;
							continue;
						}
						token.type = "nova_label_html";
					}
				}
			});
		},
	},
};

export const LabelHtml = Node.create({
	name: "labelHtml",
	group: "inline",
	inline: true,
	content: "text*",
	marks: "",
	parseHTML() {
		return [{ tag: "span[data-nova-label-html]", preserveWhitespace: "full" }];
	},
	renderHTML() {
		return ["span", { "data-nova-label-html": "" }, 0];
	},
	addStorage() {
		return { markdown };
	},
});
