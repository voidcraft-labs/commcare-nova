import type { XPathValue } from "./types";

/** One concrete node in an XPath data instance. */
export interface XPathNode {
	readonly instanceId: string | null;
	readonly path: string;
	readonly name: string;
	readonly kind: "element" | "attribute";
	/** Zero-based sibling multiplicity, matching JavaRosa TreeReference. */
	readonly multiplicity: number;
	value(): XPathValue;
	parent(): XPathNode | undefined;
	children(name?: string): readonly XPathNode[];
	attributes(name?: string): readonly XPathNode[];
	/** Schema/template traversal used when no live node exists. */
	templateChildren?(name?: string): readonly XPathNode[];
	templateAttributes?(name?: string): readonly XPathNode[];
	/** Exact schema names, including `*`, that cannot always be represented by
	 * a concrete template node. Worker snapshots use these to preserve dynamic
	 * secondary-instance paths across the structured-clone boundary. */
	childTemplateNames?(): readonly string[];
	attributeTemplateNames?(): readonly string[];
	hasChildTemplate(name?: string): boolean;
	hasAttributeTemplate(name?: string): boolean;
	/** JavaRosa removes irrelevant nodes while expanding a nodeset. */
	isRelevant(): boolean;
}

export interface XPathInstance {
	readonly id: string | null;
	root(): XPathNode;
}

/**
 * Ordered JavaRosa-shaped nodeset. `validPath` distinguishes a real empty
 * selection from a reference whose authored template path does not exist.
 */
export class XPathNodeSet {
	readonly kind = "nodeset" as const;
	/** Expanded candidates before JavaRosa's final relevance filter. */
	readonly candidates: readonly XPathNode[];
	readonly nodes: readonly XPathNode[];
	/** Schema representatives that survive an empty live selection. */
	readonly schemaNodes: readonly XPathNode[];
	readonly validPath: boolean;

	constructor(
		candidates: readonly XPathNode[],
		validPath = true,
		schemaNodes: readonly XPathNode[] = candidates,
	) {
		this.candidates = candidates;
		this.nodes = candidates.filter((node) => node.isRelevant());
		this.schemaNodes = schemaNodes;
		this.validPath = validPath;
	}

	get size(): number {
		return this.nodes.length;
	}
}

/** Core's provisional Object[] sequence, currently produced by collections. */
export class XPathSequence {
	readonly kind = "sequence" as const;
	readonly values: readonly XPathValue[];

	constructor(values: readonly XPathValue[]) {
		this.values = values;
	}
}

export type XPathRuntimeValue = XPathValue | XPathNodeSet | XPathSequence;

export function isXPathNodeSet(value: unknown): value is XPathNodeSet {
	return value instanceof XPathNodeSet;
}

export function isXPathSequence(value: unknown): value is XPathSequence {
	return value instanceof XPathSequence;
}

/** Mirrors XPathNodeset.unpack(): empty → blank, singleton → value, many → error. */
export function unpackXPathRuntimeValue(value: XPathRuntimeValue): XPathValue {
	if (isXPathSequence(value)) {
		throw new Error("XPath sequence cannot be converted to a scalar value.");
	}
	if (!isXPathNodeSet(value)) return value;
	if (!value.validPath) {
		throw new Error(
			"XPath references a path that does not exist in the instance.",
		);
	}
	if (value.nodes.length === 0) return "";
	if (value.nodes.length > 1) {
		throw new Error(
			`XPath nodeset has more than one node [${value.nodes.map((node) => node.path).join(";")}]; cannot convert multiple nodes to a raw value. Refine path expression to match only one node.`,
		);
	}
	return value.nodes[0]?.value() ?? "";
}
