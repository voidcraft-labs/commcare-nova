import { SaxesParser } from "saxes";

export interface XmlEvidence {
	name: string;
	uri: string;
	attributes: Record<string, string>;
	children: XmlEvidence[];
	text: string;
}

/** The independent XML reader preserves namespace and decoded XML values. */
export function readXmlEvidence(xml: string): XmlEvidence {
	const stack: XmlEvidence[] = [];
	const roots: XmlEvidence[] = [];
	const parser = new SaxesParser({ xmlns: true });
	parser.on("opentag", (tag) => {
		const node: XmlEvidence = {
			name: tag.local,
			uri: tag.uri,
			attributes: Object.fromEntries(
				Object.values(tag.attributes).map((attribute) => [
					attribute.name,
					attribute.value,
				]),
			),
			children: [],
			text: "",
		};
		(stack.at(-1)?.children ?? roots).push(node);
		stack.push(node);
	});
	const append = (value: string) => {
		const node = stack.at(-1);
		if (node) node.text += value;
	};
	parser.on("text", append);
	parser.on("cdata", append);
	parser.on("closetag", () => {
		stack.pop();
	});
	parser.write(xml).close();
	return onlyXml(roots);
}

export function onlyXml(nodes: XmlEvidence[]): XmlEvidence {
	if (nodes.length !== 1 || !nodes[0])
		throw new Error(`Expected one XML element, received ${nodes.length}`);
	return nodes[0];
}

export function xmlChildren(node: XmlEvidence, name: string): XmlEvidence[] {
	return node.children.filter(
		(child) => child.name === name && child.uri === node.uri,
	);
}
