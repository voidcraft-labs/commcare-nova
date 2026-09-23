import type { XPathNode } from "./runtimeValues";

/** A generated snapshot target exists before any repeated answers do. This
 * expression-local carrier preserves its ancestry without inserting an answer
 * row into the main instance or its worker world. */
export interface XPathInitializationContext {
	readonly parentPath: string;
	readonly name: string;
	readonly attributes?: Readonly<Record<string, string>>;
	readonly attribute?: string;
}

export function initializationContextNode(
	parent: XPathNode,
	carrier: XPathInitializationContext,
): XPathNode {
	const attributes: XPathNode[] = [];
	const element: XPathNode = {
		instanceId: parent.instanceId,
		path: `${parent.path}/${carrier.name}`,
		name: carrier.name,
		kind: "element",
		multiplicity: 0,
		value: () => "",
		parent: () => parent,
		children: () => [],
		attributes: (name) =>
			attributes.filter((node) => name === undefined || node.name === name),
		hasChildTemplate: () => false,
		hasAttributeTemplate: (name) =>
			attributes.some((node) => name === undefined || node.name === name),
		isRelevant: () => parent.isRelevant(),
	};
	for (const [name, value] of Object.entries(carrier.attributes ?? {})) {
		attributes.push({
			instanceId: parent.instanceId,
			path: `${element.path}/@${name}`,
			name,
			kind: "attribute",
			multiplicity: 0,
			value: () => value,
			parent: () => element,
			children: () => [],
			attributes: () => [],
			hasChildTemplate: () => false,
			hasAttributeTemplate: () => false,
			isRelevant: () => parent.isRelevant(),
		});
	}
	if (carrier.attribute === undefined) return element;
	const target = attributes.find((node) => node.name === carrier.attribute);
	if (target === undefined)
		throw new Error("Missing initialization attribute.");
	return target;
}
