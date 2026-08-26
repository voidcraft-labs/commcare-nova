import type { XFormDataRootRuntimeAttributes } from "@/lib/commcare/xform/dataRootAttributes";
import type {
	XPathInstance,
	XPathNode,
} from "@/lib/preview/xpath/runtimeValues";
import { XPathDate, type XPathValue } from "@/lib/preview/xpath/types";
import type { FieldTreeNode } from "./fieldTree";

interface XPathTemplateNode {
	readonly name: string;
	readonly kind: FieldTreeNode["field"]["kind"];
	readonly repeat: boolean;
	readonly children: readonly XPathTemplateNode[];
	readonly attributes?: Readonly<Record<string, string>>;
}

/**
 * Flat data store keyed by absolute path.
 * Paths: /data/field_id, /data/group_id/child_id, /data/repeat_id[0]/child_id
 *
 * Repeat cardinality is tracked EXPLICITLY in `counts`, keyed by the
 * concrete repeat container path (`/data/orders`, `/data/a[0]/b`) — never
 * derived from which value keys happen to exist. Deriving from keys broke
 * two ways: a repeat with no leaf descendants (only structural children)
 * counted 0 and went dead, and a repeat's count silently followed whatever
 * keys other operations left behind. `set` auto-extends counts from a
 * path's indexed segments so restore/rename flows that write indexed paths
 * directly keep the map consistent.
 */
export class DataInstance {
	private data = new Map<string, string>();
	private counts = new Map<string, number>();
	/** Per-occurrence attributes absent from Nova's authored field tree. Query-
	 * bound repeats use these for the JavaRosa-created `@id` and `@index`
	 * values on each materialized iteration. */
	private elementAttributes = new Map<
		string,
		Readonly<Record<string, string>>
	>();
	private xpathTemplate: readonly XPathTemplateNode[] = [];
	private rootAttributes: Readonly<Record<string, string>>;

	constructor(
		rootAttributes: XFormDataRootRuntimeAttributes | undefined = undefined,
	) {
		this.rootAttributes = rootAttributes ? { ...rootAttributes } : {};
	}

	setRootAttributes(rootAttributes: XFormDataRootRuntimeAttributes): void {
		this.rootAttributes = { ...rootAttributes };
	}

	/** Initialize from a field tree, creating an entry for each non-structural field. */
	initFromFields(tree: FieldTreeNode[], prefix = "/data"): void {
		if (prefix === "/data") {
			this.xpathTemplate = xpathTemplateFromFields(tree);
		}
		for (const node of tree) {
			const f = node.field;
			const path = `${prefix}/${f.id}`;

			if (f.kind === "group" || f.kind === "section") {
				// Groups and sections don't have values — recurse into children
				if (node.children) this.initFromFields(node.children, path);
			} else if (f.kind === "repeat") {
				// Repeats start with one instance [0]
				this.counts.set(path, 1);
				if (node.children) this.initFromFields(node.children, `${path}[0]`);
			} else {
				// Leaf field — empty string initial value
				this.data.set(path, "");
			}
		}
	}

	/** Structural view consumed by the nodeset-aware XPath evaluator. */
	asXPathInstance(
		isRelevant: (path: string) => boolean = () => true,
	): XPathInstance {
		return new FormXPathInstance(
			this,
			this.xpathTemplate,
			isRelevant,
			this.rootAttributes,
		);
	}

	get(path: string): string | undefined {
		return this.data.get(path);
	}

	set(path: string, value: string): void {
		this.data.set(path, value);
		this.extendCountsFor(path);
	}

	has(path: string): boolean {
		return this.data.has(path);
	}

	/** Drop a path's value — and, if the path is a repeat container, its
	 *  instance count. Used when a field is retyped (its old value is stale
	 *  under the new kind) or removed remotely, so a later re-seed at the
	 *  same path starts empty rather than resurfacing the old answer. */
	delete(path: string): void {
		this.data.delete(path);
		this.counts.delete(path);
		this.elementAttributes.delete(path);
	}

	/** Replace the runtime attributes for one concrete element occurrence. */
	setElementAttributes(
		path: string,
		attributes: Readonly<Record<string, string>>,
	): void {
		this.elementAttributes.set(path, { ...attributes });
	}

	elementAttributesAt(path: string): Readonly<Record<string, string>> {
		return this.elementAttributes.get(path) ?? {};
	}

	/** Register a repeat container, seeding one instance if it has no live
	 *  count yet. The incremental add-field path uses this — the full
	 *  `initFromFields` walk seeds counts itself. */
	ensureRepeat(repeatPath: string): void {
		if (!this.counts.has(repeatPath)) this.counts.set(repeatPath, 1);
	}

	/**
	 * Add a new repeat instance. Returns the new index.
	 *
	 * The new instance is seeded from the AUTHORED template shape — the
	 * `[0]` subtree with every nested repeat at one instance — not from
	 * instance `[0]`'s live shape. A user who grew a nested repeat to three
	 * rows inside instance 1 gets a fresh instance with one nested row,
	 * matching what the deployed form's `jr:template` would produce.
	 */
	addRepeatInstance(repeatPath: string): number {
		const count = this.getRepeatCount(repeatPath);
		const newIndex = count;

		const templatePrefix = `${repeatPath}[0]/`;
		for (const [key] of this.data) {
			if (!key.startsWith(templatePrefix)) continue;
			const suffix = key.slice(templatePrefix.length);
			// Skip keys inside nested instances >= 1 — template shape only.
			if (/\[[1-9]\d*\]/.test(suffix)) continue;
			this.data.set(`${repeatPath}[${newIndex}]/${suffix}`, "");
		}
		// Nested repeat containers restart at one instance in the new copy.
		for (const key of [...this.counts.keys()]) {
			if (!key.startsWith(templatePrefix)) continue;
			const suffix = key.slice(templatePrefix.length);
			if (/\[[1-9]\d*\]/.test(suffix)) continue;
			this.counts.set(`${repeatPath}[${newIndex}]/${suffix}`, 1);
		}

		this.counts.set(repeatPath, newIndex + 1);
		return newIndex;
	}

	/** Remove a repeat instance and renumber higher indices. */
	removeRepeatInstance(repeatPath: string, index: number): void {
		const count = this.getRepeatCount(repeatPath);
		if (count <= 1) return; // Keep at least one instance

		// Remove value + nested-count keys for this index
		const prefix = `${repeatPath}[${index}]/`;
		for (const key of [...this.data.keys()]) {
			if (key.startsWith(prefix)) this.data.delete(key);
		}
		for (const key of [...this.counts.keys()]) {
			if (key.startsWith(prefix)) this.counts.delete(key);
		}
		for (const key of [...this.elementAttributes.keys()]) {
			if (key === prefix.slice(0, -1) || key.startsWith(prefix)) {
				this.elementAttributes.delete(key);
			}
		}

		// Renumber higher indices
		for (let i = index + 1; i < count; i++) {
			const oldPrefix = `${repeatPath}[${i}]/`;
			const newPrefix = `${repeatPath}[${i - 1}]/`;
			for (const key of [...this.data.keys()]) {
				if (key.startsWith(oldPrefix)) {
					const suffix = key.slice(oldPrefix.length);
					const value = this.data.get(key) ?? "";
					this.data.delete(key);
					this.data.set(newPrefix + suffix, value);
				}
			}
			for (const key of [...this.counts.keys()]) {
				if (key.startsWith(oldPrefix)) {
					const suffix = key.slice(oldPrefix.length);
					const nested = this.counts.get(key) ?? 1;
					this.counts.delete(key);
					this.counts.set(newPrefix + suffix, nested);
				}
			}
			for (const key of [...this.elementAttributes.keys()]) {
				const oldElementPath = oldPrefix.slice(0, -1);
				if (key !== oldElementPath && !key.startsWith(oldPrefix)) continue;
				const suffix = key.slice(oldElementPath.length);
				const attributes = this.elementAttributes.get(key) ?? {};
				this.elementAttributes.delete(key);
				this.elementAttributes.set(newPrefix.slice(0, -1) + suffix, attributes);
			}
		}

		this.counts.set(repeatPath, count - 1);
	}

	/** Live instance count for a repeat container path. Zero for paths
	 *  that aren't registered repeats. */
	getRepeatCount(repeatPath: string): number {
		return this.counts.get(repeatPath) ?? 0;
	}

	/** Set an initialization-owned repeat cardinality, including zero.
	 * Interactive removal deliberately keeps one row; query/count-bound form
	 * initialization must still be able to materialize an empty nodeset. */
	setRepeatCount(repeatPath: string, target: number): void {
		if (!Number.isSafeInteger(target) || target < 0) {
			throw new Error("Repeat count must be a nonnegative safe integer.");
		}
		let current = this.getRepeatCount(repeatPath);
		if (target === 0) {
			const firstPrefix = `${repeatPath}[0]/`;
			for (const key of [...this.data.keys()]) {
				if (!key.startsWith(`${repeatPath}[`)) continue;
				if (key.startsWith(firstPrefix)) this.data.set(key, "");
				else this.data.delete(key);
			}
			for (const key of [...this.counts.keys()]) {
				if (key === repeatPath || !key.startsWith(`${repeatPath}[`)) continue;
				if (!key.startsWith(firstPrefix)) this.counts.delete(key);
			}
			for (const key of [...this.elementAttributes.keys()]) {
				if (key.startsWith(`${repeatPath}[`)) {
					this.elementAttributes.delete(key);
				}
			}
			this.counts.set(repeatPath, 0);
			return;
		}
		while (current < target) {
			this.addRepeatInstance(repeatPath);
			current += 1;
		}
		while (current > target) {
			this.removeRepeatInstance(repeatPath, current - 1);
			current -= 1;
		}
	}

	/** Move a key — its value and/or its repeat count — to a new path.
	 *  The old key is deleted so index-free reads can't resurrect the
	 *  pre-rename value. */
	rename(from: string, to: string): void {
		this.renameMany([{ from, to }]);
	}

	/**
	 * Atomically move a batch of value/count keys.
	 *
	 * Every source is snapshotted and removed before any destination is
	 * written. That ordering preserves swaps and chains (`a→b`, `b→c`) from
	 * the same authored mutation batch; sequential `rename` calls would let
	 * the first write overwrite the second move's source.
	 */
	renameMany(moves: ReadonlyArray<{ from: string; to: string | null }>): void {
		const snapshots = moves.map(({ from, to }) => ({
			from,
			to,
			hasData: this.data.has(from),
			value: this.data.get(from) ?? "",
			count: this.counts.get(from),
			attributes: this.elementAttributes.get(from),
		}));
		for (const { from } of snapshots) {
			this.data.delete(from);
			this.counts.delete(from);
			this.elementAttributes.delete(from);
		}
		for (const { to, hasData, value, count, attributes } of snapshots) {
			if (to === null) continue;
			if (hasData) this.set(to, value);
			if (count !== undefined) this.counts.set(to, count);
			if (attributes !== undefined) {
				this.elementAttributes.set(to, attributes);
			}
		}
	}

	/** Get all entries (for debugging). */
	entries(): [string, string][] {
		return [...this.data.entries()];
	}

	/** Values addressable by the XPath worker, including runtime attributes. */
	xpathValueEntries(): [string, string][] {
		return [
			...this.data.entries(),
			...[...this.elementAttributes.entries()].flatMap(([path, attributes]) =>
				Object.entries(attributes).map(
					([name, value]) => [`${path}/@${name}`, value] as [string, string],
				),
			),
		];
	}

	/** Repeat cardinality is topology even when the retained `[0]` template
	 * values make a zero-row repeat's value-key set look unchanged. */
	xpathRepeatCountEntries(): [string, number][] {
		return [...this.counts.entries()];
	}

	/** Grow every repeat count along a path's indexed segments so the map
	 *  admits the instance the path names — `/data/a[2]/b[1]/c` implies at
	 *  least 3 instances of `/data/a` and 2 of `/data/a[2]/b`. */
	private extendCountsFor(path: string): void {
		let rest = path;
		let prefix = "";
		for (;;) {
			const open = rest.indexOf("[");
			if (open === -1) return;
			const close = rest.indexOf("]", open);
			if (close === -1) return;
			const repeatPath = prefix + rest.slice(0, open);
			const index = Number.parseInt(rest.slice(open + 1, close), 10);
			if (Number.isInteger(index)) {
				const current = this.counts.get(repeatPath) ?? 0;
				if (index + 1 > current) this.counts.set(repeatPath, index + 1);
			}
			prefix += rest.slice(0, close + 1);
			rest = rest.slice(close + 1);
		}
	}
}

function xpathTemplateFromFields(
	tree: readonly FieldTreeNode[],
): readonly XPathTemplateNode[] {
	return tree.map((node) => ({
		name: node.field.id,
		kind: node.field.kind,
		repeat: node.field.kind === "repeat",
		children: xpathTemplateFromFields(node.children ?? []),
		...(node.field.kind === "repeat" && node.field.repeat_mode === "query_bound"
			? { attributes: { id: "", index: "" } }
			: {}),
	}));
}

class FormXPathInstance implements XPathInstance {
	readonly id = null;
	private readonly rootNode: FormXPathNode;

	constructor(
		readonly data: DataInstance,
		template: readonly XPathTemplateNode[],
		readonly relevance: (path: string) => boolean,
		rootAttributes: Readonly<Record<string, string>>,
	) {
		this.rootNode = new FormXPathNode({
			instance: this,
			name: "",
			path: "/",
			multiplicity: 0,
			children: [
				{
					name: "data",
					kind: "group",
					repeat: false,
					children: template,
					attributes: rootAttributes,
				},
			],
		});
	}

	root(): XPathNode {
		return this.rootNode;
	}
}

class FormXPathNode implements XPathNode {
	readonly instanceId = null;
	readonly kind = "element" as const;
	readonly name: string;
	readonly path: string;
	readonly multiplicity: number;
	private readonly instance: FormXPathInstance;
	private readonly template?: XPathTemplateNode;
	private readonly childTemplates: readonly XPathTemplateNode[];
	private readonly attributeSpecs: Readonly<Record<string, string>>;
	private readonly parentNode?: FormXPathNode;

	constructor(args: {
		instance: FormXPathInstance;
		name: string;
		path: string;
		multiplicity: number;
		template?: XPathTemplateNode;
		children?: readonly XPathTemplateNode[];
		attributes?: Readonly<Record<string, string>>;
		parent?: FormXPathNode;
	}) {
		this.instance = args.instance;
		this.name = args.name;
		this.path = args.path;
		this.multiplicity = args.multiplicity;
		this.template = args.template;
		this.childTemplates = args.children ?? args.template?.children ?? [];
		this.attributeSpecs = args.attributes ?? args.template?.attributes ?? {};
		this.parentNode = args.parent;
	}

	value(): XPathValue {
		if (this.template === undefined || this.childTemplates.length > 0)
			return "";
		const raw = this.instance.data.get(this.path) ?? "";
		if (raw === "") return "";
		switch (this.template.kind) {
			case "int":
			case "decimal": {
				const numeric = Number(raw);
				return Number.isNaN(numeric) ? raw : numeric;
			}
			case "date":
			case "datetime":
				return XPathDate.parse(raw) ?? raw;
			default:
				return raw;
		}
	}

	parent(): XPathNode | undefined {
		return this.parentNode;
	}

	children(name?: string): readonly XPathNode[] {
		const result: XPathNode[] = [];
		for (const template of this.childTemplates) {
			if (name !== undefined && name !== "*" && template.name !== name)
				continue;
			const unindexedPath =
				this.path === "/"
					? `/${template.name}`
					: `${this.path}/${template.name}`;
			const count = template.repeat
				? this.instance.data.getRepeatCount(unindexedPath)
				: 1;
			for (let index = 0; index < count; index += 1) {
				result.push(this.childNode(template, unindexedPath, index));
			}
		}
		return result;
	}

	templateChildren(name?: string): readonly XPathNode[] {
		return this.childTemplates
			.filter(
				(template) =>
					name === undefined || name === "*" || template.name === name,
			)
			.map((template) => {
				const unindexedPath =
					this.path === "/"
						? `/${template.name}`
						: `${this.path}/${template.name}`;
				return this.childNode(template, unindexedPath, 0);
			});
	}

	attributes(name?: string): readonly XPathNode[] {
		return Object.entries({
			...this.attributeSpecs,
			...this.instance.data.elementAttributesAt(this.path),
		})
			.filter(([attributeName]) =>
				name === undefined || name === "*" ? true : attributeName === name,
			)
			.map(
				([attributeName, value]) =>
					new FormXPathAttributeNode({
						parent: this,
						name: attributeName,
						value,
					}),
			);
	}

	templateAttributes(name?: string): readonly XPathNode[] {
		return this.attributes(name);
	}

	hasChildTemplate(name?: string): boolean {
		return this.childTemplates.some(
			(template) =>
				name === undefined || name === "*" || template.name === name,
		);
	}

	hasAttributeTemplate(name?: string): boolean {
		return Object.keys(this.attributeSpecs).some(
			(attributeName) =>
				name === undefined || name === "*" || attributeName === name,
		);
	}

	isRelevant(): boolean {
		return this.path === "/" || this.instance.relevance(this.path);
	}

	private childNode(
		template: XPathTemplateNode,
		unindexedPath: string,
		index: number,
	): FormXPathNode {
		return new FormXPathNode({
			instance: this.instance,
			name: template.name,
			path: template.repeat ? `${unindexedPath}[${index}]` : unindexedPath,
			multiplicity: template.repeat ? index : 0,
			template,
			parent: this,
		});
	}
}

class FormXPathAttributeNode implements XPathNode {
	readonly instanceId = null;
	readonly kind = "attribute" as const;
	readonly multiplicity = 0;
	readonly name: string;
	readonly path: string;
	private readonly parentNode: FormXPathNode;
	private readonly scalar: string;

	constructor(args: {
		readonly parent: FormXPathNode;
		readonly name: string;
		readonly value: string;
	}) {
		this.parentNode = args.parent;
		this.name = args.name;
		this.path = `${args.parent.path}/@${args.name}`;
		this.scalar = args.value;
	}

	value(): XPathValue {
		return this.scalar;
	}

	parent(): XPathNode {
		return this.parentNode;
	}

	children(): readonly XPathNode[] {
		return [];
	}

	attributes(): readonly XPathNode[] {
		return [];
	}

	templateChildren(): readonly XPathNode[] {
		return [];
	}

	templateAttributes(): readonly XPathNode[] {
		return [];
	}

	hasChildTemplate(): boolean {
		return false;
	}

	hasAttributeTemplate(): boolean {
		return false;
	}

	isRelevant(): boolean {
		return this.parentNode.isRelevant();
	}
}
