import { Table } from "@tiptap/extension-table";
import { type DOMOutputSpec, DOMSerializer, type Node } from "@tiptap/pm/model";
import type { MarkdownNodeSpec } from "tiptap-markdown";
import { serializedProseReferencePart } from "./commcareRefNode";

function fitsPipeTable(table: Node): boolean {
	let fits = true;
	table.forEach((row, _offset, rowIndex) => {
		row.forEach((cell) => {
			if (
				cell.type.name !== (rowIndex === 0 ? "tableHeader" : "tableCell") ||
				cell.attrs.colspan > 1 ||
				cell.attrs.rowspan > 1 ||
				cell.childCount !== 1
			)
				fits = false;
		});
	});
	return fits;
}

/**
 * tiptap-markdown 0.9 skips cells without textContent. Inline atoms (images
 * and Nova references) have no textContent but must survive saving. Keep its
 * pipe-table format and HTML fallback, rendering every cell's actual content.
 */
const markdown: MarkdownNodeSpec = {
	serialize(state, node, parent) {
		if (!fitsPipeTable(node)) {
			/* The fallback is stored HTML for the worker's app. Serialize native
			 * image addresses in a document with no browsing context, so saving
			 * the table keeps its pictures without requesting any of them. */
			const inert = document.implementation.createHTMLDocument();
			const schema = DOMSerializer.fromSchema(node.type.schema);
			/* These two nodes write Markdown directly. Hold their places in the
			 * HTML, so escaping a DOM attribute cannot rewrite authored text. */
			const parts: string[] = [];
			const placeholder = (source: string): DOMOutputSpec => [
				"span",
				{ "data-nova-table-slot": parts.push(source) - 1 },
			];
			const serializer = new DOMSerializer(
				{
					...schema.nodes,
					image: (image) => ["img", image.attrs],
					commcareRef: (ref) =>
						placeholder(serializedProseReferencePart(ref.attrs.part)),
					labelHtml: (html) => placeholder(html.textContent),
				},
				{ ...schema.marks, link: (link) => ["a", link.attrs, 0] },
			);
			const table = serializer.serializeNode(node, {
				document: inert,
			}) as HTMLTableElement;
			if (parent.type === node.type.schema.topNodeType)
				table.innerHTML = `\n${table.innerHTML}\n`;
			state.write(
				table.outerHTML.replace(
					/<span data-nova-table-slot="(\d+)"><\/span>/g,
					(_slot, position: string) => parts[Number(position)],
				),
			);
			state.closeBlock(node);
			return;
		}
		// tiptap-markdown's hard-break serializer consults this extension flag.
		const tableState = state as typeof state & { inTable: boolean };
		const previous = tableState.inTable;
		tableState.inTable = true;
		try {
			node.forEach((row, _offset, rowIndex) => {
				state.write("| ");
				row.forEach((cell, _cellOffset, cellIndex) => {
					if (cellIndex > 0) state.write(" | ");
					if (cell.firstChild) state.renderInline(cell.firstChild);
				});
				state.write(" |");
				state.ensureNewLine();
				if (rowIndex === 0) {
					state.write(
						`| ${Array.from({ length: row.childCount }, () => "---").join(" | ")} |`,
					);
					state.ensureNewLine();
				}
			});
			state.closeBlock(node);
		} finally {
			tableState.inTable = previous;
		}
	},
};

export const MarkdownTable = Table.extend({
	addStorage() {
		return { ...this.parent?.(), markdown };
	},
});
