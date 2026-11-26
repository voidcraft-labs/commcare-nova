import type { ChildNode } from "domhandler";
import { parseDocument } from "htmlparser2";
import { createElement, type ReactNode } from "react";

/** Android’s tile treats text as inline HTML (EntityViewTile and MarkupUtil).
 * Only local formatting tags generate elements. All stored text goes through React. */
function textNodes(nodes: readonly ChildNode[]): ReactNode[] {
	return nodes.map((node) => {
		if (node.type === "text") return node.data;
		if (node.type !== "tag") return null;
		const key = node.startIndex;
		if (node.name === "br") return <br key={key} />;
		const children = textNodes(node.children);
		switch (node.name) {
			case "b":
			case "strong":
				return createElement("strong", { key }, children);
			case "i":
			case "em":
				return createElement("em", { key }, children);
			case "u":
			case "sup":
			case "sub":
			case "s":
				return createElement(node.name, { key }, children);
			default:
				return children;
		}
	});
}

export function NativeTileText({ value }: { value: string }) {
	return (
		<>{textNodes(parseDocument(value, { withStartIndices: true }).children)}</>
	);
}
