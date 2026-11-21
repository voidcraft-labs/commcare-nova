/**
 * The one whole comparison of two XML elements, a stored one and the one Nova's emitter builds
 * for what a reading proposes: name and namespace, every attribute as a set (by namespace and
 * local name, namespace declarations left out), the own text trimmed, and every child element
 * alike in order. A reader that claims a stored subtree whole under a held entry
 * (`XmlCursor.takeSubtree`, `derivedSubtree`) does so only where this comparison, or one that
 * reads at least as much, holds the subtree to the emitter's, since a claim on a subtree covers
 * every node under it from the close's report.
 */

import type { Element } from "domhandler";
import { isTag } from "domhandler";
import {
	attributeNamespace,
	elementNamespace,
	type NamespaceScope,
	scopeOf,
	splitName,
} from "../xmlNamespaces";

/** An element's namespace scope, as `xmlNamespaces.ts::namespaceScopes` answers it. */
export type ScopeOf = (element: Element) => NamespaceScope;

function childElements(element: Element): Element[] {
	return element.children.filter(isTag);
}

/** An element's own text, its children's left out, trimmed of XML's whitespace. */
function trimmedOwnText(element: Element): string {
	let text = "";
	for (const child of element.children)
		if (child.type === "text") text += child.data;
	const space = (at: number) => {
		const character = text[at];
		return (
			character === " " ||
			character === "\t" ||
			character === "\n" ||
			character === "\r"
		);
	};
	let start = 0;
	let end = text.length;
	while (start < end && space(start)) start += 1;
	while (end > start && space(end - 1)) end -= 1;
	return text.slice(start, end);
}

/** An element's attributes by namespace and local name, the namespace declarations and every
 *  attribute `skip` names by its namespace left out. */
export function attributesByName(
	element: Element,
	scope: NamespaceScope,
	skip: (namespace: string | null) => boolean = () => false,
): Map<string, string> {
	const out = new Map<string, string>();
	for (const [name, value] of Object.entries(element.attribs)) {
		if (name === "xmlns" || name.startsWith("xmlns:")) continue;
		const namespace = attributeNamespace(name, scope);
		if (skip(namespace)) continue;
		out.set(`${namespace ?? ""} ${splitName(name).local}`, value);
	}
	return out;
}

/** Two attribute maps alike, key for key and value for value. */
export function sameAttributeMaps(
	a: ReadonlyMap<string, string>,
	b: ReadonlyMap<string, string>,
): boolean {
	if (a.size !== b.size) return false;
	for (const [key, value] of a) if (b.get(key) !== value) return false;
	return true;
}

/**
 * Whether `a` and `b` are alike: name and namespace, attributes as sets, the own text trimmed,
 * and, where `deep`, every child element alike in order. With `deep` false only the element's
 * own name, attributes and text are compared.
 */
export function sameElementWhole(
	a: Element,
	aScope: ScopeOf,
	b: Element,
	bScope: ScopeOf,
	deep = true,
): boolean {
	const aOwn = aScope(a);
	const bOwn = bScope(b);
	if (
		splitName(a.name).local !== splitName(b.name).local ||
		elementNamespace(a, aOwn) !== elementNamespace(b, bOwn)
	)
		return false;
	if (!sameAttributeMaps(attributesByName(a, aOwn), attributesByName(b, bOwn)))
		return false;
	if (trimmedOwnText(a) !== trimmedOwnText(b)) return false;
	if (!deep) return true;
	const aChildren = childElements(a);
	const bChildren = childElements(b);
	return (
		aChildren.length === bChildren.length &&
		aChildren.every((child, i) =>
			sameElementWhole(child, aScope, bChildren[i] as Element, bScope, true),
		)
	);
}

/**
 * The scope of every element of a tree the emitter built outside any document, as it stands
 * under `outer`: the namespaces in force where the stored element it is compared with stands,
 * with the prefixes the emitter's document declares at its root.
 */
export function builtScopes(root: Element, outer: NamespaceScope): ScopeOf {
	const scopes = new Map<Element, NamespaceScope>();
	const walk = (element: Element, parent: NamespaceScope) => {
		const own = scopeOf(element, parent);
		scopes.set(element, own);
		for (const child of childElements(element)) walk(child, own);
	};
	walk(root, outer);
	return (element) => scopes.get(element) ?? outer;
}
