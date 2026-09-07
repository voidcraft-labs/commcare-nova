import { getHTMLFromFragment } from "@tiptap/core";
import { Table } from "@tiptap/extension-table";
import { Fragment, type Node } from "@tiptap/pm/model";
import type { MarkdownNodeSpec } from "tiptap-markdown";

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
			const html = getHTMLFromFragment(Fragment.from(node), node.type.schema);
			if (parent.type === node.type.schema.topNodeType) {
				const container = document.createElement("div");
				container.innerHTML = html;
				const table = container.firstElementChild;
				if (table) {
					table.innerHTML = `\n${table.innerHTML}\n`;
					state.write(table.outerHTML);
				}
			} else state.write(html);
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
