/**
 * Namespace-aware reading of a parsed XForm (`xmlParse.ts::parseXml`, which
 * keeps each element's and attribute's name as the source wrote it, prefix
 * included, and its namespace declarations among its attributes). An element
 * or attribute is found by its namespace and local name, never by the prefix a
 * source happened to use, and a name is spelled for a log or a finding the way
 * the proof lane spells it (`proof/checks/manifest_usage.py::qualified`).
 */

import type { ChildNode, Document, Element } from "domhandler";
import { isTag } from "domhandler";

export const XFORMS_NS = "http://www.w3.org/2002/xforms";
export const XHTML_NS = "http://www.w3.org/1999/xhtml";
export const JAVAROSA_NS = "http://openrosa.org/javarosa";
export const VELLUM_NS = "http://commcarehq.org/xforms/vellum";
export const OPENROSA_NS = "http://openrosa.org/jr/xforms";

/** The namespace XML itself binds to the prefix `xml`, which no document declares. */
const XML_NS = "http://www.w3.org/XML/1998/namespace";

/** Prefix to namespace URI, as declared at one element; the empty prefix is the default namespace. */
export type NamespaceScope = ReadonlyMap<string, string>;

/** `element`'s namespace scope: its declarations over its parent's. */
export function scopeOf(
	element: Element,
	parent: NamespaceScope,
): NamespaceScope {
	let scope: Map<string, string> | undefined;
	for (const [name, value] of Object.entries(element.attribs)) {
		const prefix =
			name === "xmlns"
				? ""
				: name.startsWith("xmlns:")
					? name.slice("xmlns:".length)
					: undefined;
		if (prefix === undefined) continue;
		scope ??= new Map(parent);
		scope.set(prefix, value);
	}
	return scope ?? parent;
}

/** A name as written: its prefix (empty where it has none) and its local name. */
export function splitName(name: string): { prefix: string; local: string } {
	const colon = name.indexOf(":");
	return colon < 0
		? { prefix: "", local: name }
		: { prefix: name.slice(0, colon), local: name.slice(colon + 1) };
}

/** Whether `element`, in `scope`, is `local` in namespace `uri`. */
export function isElement(
	element: Element,
	scope: NamespaceScope,
	uri: string,
	local: string,
): boolean {
	const name = splitName(element.name);
	return name.local === local && scope.get(name.prefix) === uri;
}

/** The value of the attribute `local` in namespace `uri`; an attribute with
 *  no prefix is in no namespace. */
export function namespacedAttribute(
	element: Element,
	scope: NamespaceScope,
	uri: string,
	local: string,
): string | undefined {
	for (const [name, value] of Object.entries(element.attribs)) {
		const split = splitName(name);
		if (
			split.prefix !== "" &&
			split.prefix !== "xmlns" &&
			split.local === local &&
			scope.get(split.prefix) === uri
		)
			return value;
	}
	return undefined;
}

export function elementChildren(
	nodes: readonly ChildNode[],
	scope: NamespaceScope,
): { element: Element; scope: NamespaceScope }[] {
	return nodes.filter(isTag).map((element) => ({
		element,
		scope: scopeOf(element, scope),
	}));
}

/** The namespace of an element's own name in `scope`, null where it is in none. */
export function elementNamespace(
	element: Element,
	scope: NamespaceScope,
): string | null {
	const { prefix } = splitName(element.name);
	if (prefix === "xml") return XML_NS;
	return scope.get(prefix) || null;
}

/** The namespace of an attribute of an element in `scope`: an unprefixed attribute is in none. */
export function attributeNamespace(
	name: string,
	scope: NamespaceScope,
): string | null {
	const { prefix } = splitName(name);
	if (prefix === "") return null;
	if (prefix === "xml") return XML_NS;
	return scope.get(prefix) ?? null;
}

/**
 * Every element's scope in a parsed document, computed once on first ask: the
 * scope `elementWhere` and the namespace helpers read. An element of another
 * document answers the empty scope.
 */
export function namespaceScopes(
	document: Document,
): (element: Element) => NamespaceScope {
	let scopes: Map<Element, NamespaceScope> | undefined;
	const build = () => {
		const built = new Map<Element, NamespaceScope>();
		const walk = (nodes: readonly ChildNode[], scope: NamespaceScope) => {
			for (const { element, scope: own } of elementChildren(nodes, scope)) {
				built.set(element, own);
				walk(element.children, own);
			}
		};
		walk(document.children, new Map());
		return built;
	};
	return (element) => {
		scopes ??= build();
		return scopes.get(element) ?? new Map();
	};
}

/**
 * The prefix the XForm vocabulary is written with, by namespace: those HQ and
 * Vellum write, as the surface's xform family spells them
 * (`proof/checks/manifest_usage.py::PREFIXES`).
 */
const PREFIXES: ReadonlyMap<string, string> = new Map([
	[XFORMS_NS, ""],
	[XHTML_NS, "h"],
	[JAVAROSA_NS, "jr"],
	[OPENROSA_NS, "orx"],
	["http://commcarehq.org/xforms", "cc"],
	[VELLUM_NS, "vellum"],
	["http://opendatakit.org/xforms", "odkx"],
	["http://www.w3.org/2001/XMLSchema", "xsd"],
]);

/**
 * A name as the XForm vocabulary writes it (`jr:constraintMsg`, `h:body`,
 * `bind`), whatever prefix the document used: the namespace decides the
 * prefix, the XForms namespace takes none, and an unknown namespace is written
 * `{uri}local`. `namespace` is the expanded name's URI, null for none.
 */
export function qualifiedName(namespace: string | null, local: string): string {
	if (namespace === null) return local;
	const prefix = PREFIXES.get(namespace);
	if (prefix === undefined) return `{${namespace}}${local}`;
	return prefix === "" ? local : `${prefix}:${local}`;
}
