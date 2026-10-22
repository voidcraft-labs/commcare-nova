import { CoreUnroundableDateError, type XPathValue } from "./types";

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
 * Whether a path reached a node or template at every step, and where it did
 * not, the instance whose data it missed: `null` for the form's own instance,
 * else the secondary instance's id. A miss in a secondary instance is the
 * data a device holds being empty (no places, a table with no rows), which
 * Core refuses as it refuses any invalid path; Preview presents that as a
 * refusal, never a fault.
 */
export type XPathPathValidity = true | { readonly missedIn: string | null };

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
	readonly validity: XPathPathValidity;

	constructor(
		candidates: readonly XPathNode[],
		validity: XPathPathValidity | boolean = true,
		schemaNodes: readonly XPathNode[] = candidates,
	) {
		this.candidates = candidates;
		this.nodes = candidates.filter((node) => node.isRelevant());
		this.schemaNodes = schemaNodes;
		this.validity =
			validity === true
				? true
				: validity === false
					? { missedIn: null }
					: validity;
	}

	get validPath(): boolean {
		return this.validity === true;
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

/**
 * Java's `null` as an XPath value: what Core's `date()` gives where
 * `DateUtils.roundDate` refuses a day (`coreDays.ts::coreRoundDay`), a
 * Julian February 29 its date check calls common. Core passes it through
 * `if`, `cond` and `sleep`, `coalesce` skips it as blank
 * (`XpathCoalesceFunc.isNull`), and every other read of it throws
 * (`FunctionUtils.toString`, `toNumeric`, `toBoolean` and `toDate` of null),
 * so unpacking it throws here.
 */
export class XPathCoreNull {
	readonly kind = "core-null" as const;
	/** The value Core rounded, as the refusal names it. */
	readonly what: string;

	constructor(what: string) {
		this.what = what;
	}
}

export function isXPathCoreNull(value: unknown): value is XPathCoreNull {
	return value instanceof XPathCoreNull;
}

export type XPathRuntimeValue =
	| XPathValue
	| XPathNodeSet
	| XPathSequence
	| XPathCoreNull;

export function isXPathNodeSet(value: unknown): value is XPathNodeSet {
	return value instanceof XPathNodeSet;
}

export function isXPathSequence(value: unknown): value is XPathSequence {
	return value instanceof XPathSequence;
}

/** The one scalar failure a custom validation message may replace with its
 * normal invalid-answer wording. Other evaluation failures stay observable. */
export class XPathNodesetCardinalityError extends Error {
	constructor(paths: readonly string[]) {
		super(
			`XPath nodeset has more than one node [${paths.join(";")}]; cannot convert multiple nodes to a raw value. Refine path expression to match only one node.`,
		);
		this.name = "XPathNodesetCardinalityError";
	}
}

/**
 * Core's refusal of a value read through a path that reaches nothing
 * (`XPathNodeset.unpack` / `toArgList` on an invalid nodeset: "Logic
 * references … which is not a valid question or value"). `missedIn` names the
 * secondary instance the path missed, or `null` for the form's own.
 */
export class XPathInvalidPathError extends Error {
	readonly missedIn: string | null;

	constructor(missedIn: string | null) {
		super("XPath references a path that does not exist in the instance.");
		this.name = "XPathInvalidPathError";
		this.missedIn = missedIn;
	}
}

/** The refusal an invalid nodeset raises when a value is read from it. */
export function invalidPathError(nodeset: XPathNodeSet): XPathInvalidPathError {
	return new XPathInvalidPathError(
		nodeset.validity === true ? null : nodeset.validity.missedIn,
	);
}

/** Mirrors XPathNodeset.unpack(): empty → blank, singleton → value, many → error. */
export function unpackXPathRuntimeValue(value: XPathRuntimeValue): XPathValue {
	if (isXPathSequence(value)) {
		throw new Error("XPath sequence cannot be converted to a scalar value.");
	}
	if (isXPathCoreNull(value)) throw new CoreUnroundableDateError(value.what);
	if (!isXPathNodeSet(value)) return value;
	if (!value.validPath) throw invalidPathError(value);
	if (value.nodes.length === 0) return "";
	if (value.nodes.length > 1) {
		throw new XPathNodesetCardinalityError(
			value.nodes.map((node) => node.path),
		);
	}
	return value.nodes[0]?.value() ?? "";
}
