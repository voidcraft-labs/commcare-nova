/** What HQ scans immediately before adding secondary instances
 * (FormBase.add_stuff_to_xform, XForm.normalize_itext, WrappedNode.render).
 * Work on a projection. The original DOM still supplies the editor and the
 * executable expressions, neither of which goes through html.unescape. */
import { type ChildNode, type Element, isTag, isText } from "domhandler";
import type { HqAppSource } from "../../hq/appSource";
import { chargeWork } from "../../workMeter";
import {
	isElement,
	splitName,
	VELLUM_NS,
	XFORMS_NS,
} from "../../xmlNamespaces";
import { instanceSourcesAfterScan } from "../../xpath/instanceSources";
import type { ParsedXForm } from "./parse";

function xmlText(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll("\r", "&#13;");
}

function xmlAttribute(value: string): string {
	return xmlText(value)
		.replaceAll('"', "&quot;")
		.replaceAll("\t", "&#9;")
		.replaceAll("\n", "&#10;");
}

/** lxml removes a discarded element's tail too. Parsing with remove_comments
 * joins text on both sides of a comment; an instruction inside the root stays. */
function tail(node: ChildNode): string {
	let text = "";
	for (
		let next = node.next;
		next && (isText(next) || next.type === "comment");
		next = next.next
	)
		if (isText(next)) text += next.data;
	return text;
}

function childXml(
	element: Element,
	render: (child: Element) => string,
	removed: ReadonlySet<Element>,
): string {
	const result: string[] = [];
	let omitTail = false;
	for (const child of element.children) {
		if (child.type === "comment") continue;
		if (isText(child)) {
			if (!omitTail) result.push(xmlText(child.data));
		} else if (isTag(child)) {
			omitTail = removed.has(child);
			if (!omitTail) result.push(render(child));
		} else if (child.type === "directive") {
			omitTail = false;
			result.push(`<${child.data}>`);
		}
	}
	return result.join("");
}

function elementXml(
	element: Element,
	attributes: string,
	children: string,
): string {
	return children
		? `<${element.name}${attributes}>${children}</${element.name}>`
		: `<${element.name}${attributes}/>`;
}

const noneRemoved = new Set<Element>();
function namespaceAttributes(element: Element): [string, string][] {
	return Object.entries(element.attribs).filter(
		([name]) => name === "xmlns" || name.startsWith("xmlns:"),
	);
}

/** etree.tostring(value) copies the value node's own namespace declarations,
 * then the prefixes used by its name and attributes, then the remaining
 * inherited declarations from its nearest ancestor outward. */
function valueXml(
	element: Element,
	form: ParsedXForm,
	standalone: boolean,
): string {
	chargeWork("visit", 1);
	const namespaces = new Map(namespaceAttributes(element));
	if (standalone) {
		const addPrefix = (prefix: string) => {
			const name = prefix ? `xmlns:${prefix}` : "xmlns";
			const uri = form.scope(element).get(prefix);
			if (uri && prefix !== "xml" && !namespaces.has(name))
				namespaces.set(name, uri);
		};
		addPrefix(splitName(element.name).prefix);
		for (const name of Object.keys(element.attribs)) {
			const prefix = splitName(name).prefix;
			if (prefix && prefix !== "xmlns") addPrefix(prefix);
		}
		for (
			let parent = element.parent;
			parent && isTag(parent);
			parent = parent.parent
		)
			for (const [name, value] of namespaceAttributes(parent))
				if (!namespaces.has(name)) namespaces.set(name, value);
	}
	const regular = Object.entries(element.attribs).filter(
		([name]) => name !== "xmlns" && !name.startsWith("xmlns:"),
	);
	const attributes = [...namespaces, ...regular]
		.map(([key, value]) => ` ${key}="${xmlAttribute(value)}"`)
		.join("");
	return elementXml(
		element,
		attributes,
		childXml(element, (child) => valueXml(child, form, false), noneRemoved),
	);
}

function xformChildren(
	form: ParsedXForm,
	element: Element,
	name: string,
): Element[] {
	return element.children.filter(
		(child): child is Element =>
			isTag(child) && isElement(child, form.scope(child), XFORMS_NS, name),
	);
}

/** HQ groups one text ID's rendered <value>s across the retained languages.
 * Its comparison includes the inherited namespace bindings and the tail of
 * each value. It sorts the value forms and keeps the lexically first text ID. */
function renderBuild(form: ParsedXForm, langs: readonly string[]): string {
	if (!langs.length) return "";
	const languages = new Set(langs);
	const removed = new Set<Element>();
	const translations = new Set<Element>();
	const groups = new Map<string, unknown[]>();
	const textNodes = new Map<string, Element[]>();
	const renames = new Map<string, string>();
	if (form.itext !== undefined) {
		const all = xformChildren(form, form.itext, "translation");
		const byLanguage = new Map<string, Element>();
		for (const trans of all) {
			if (trans.attribs.lang === undefined) return "";
			byLanguage.set(trans.attribs.lang, trans);
		}
		// XForm.translations() retains the last node for a repeated language.
		for (const [lang, trans] of byLanguage)
			if (!languages.has(lang)) removed.add(trans);
		if (
			removed.size > 0 &&
			!form.itext.children.some(
				(child) =>
					child.type === "directive" || (isTag(child) && !removed.has(child)),
			)
		)
			return "";
		byLanguage.clear();
		for (const trans of all)
			if (!removed.has(trans)) byLanguage.set(trans.attribs.lang, trans);
		for (const [lang, trans] of byLanguage) {
			translations.add(trans);
			const ids = new Set<string>();
			for (const text of xformChildren(form, trans, "text")) {
				const id = text.attribs.id;
				if (id === undefined || ids.has(id)) return "";
				ids.add(id);
				const byForm = new Map<string | undefined, string>();
				for (const value of xformChildren(form, text, "value")) {
					const trailing = xmlText(tail(value)).replace(/[\t\n\v\f\r ]+$/u, "");
					byForm.set(
						value.attribs.form,
						valueXml(value, form, true) + trailing,
					);
				}
				const group = groups.get(id) ?? [];
				group.push([lang, [...byForm.values()].sort()]);
				groups.set(id, group);
				const nodes = textNodes.get(id) ?? [];
				nodes.push(text);
				textNodes.set(id, nodes);
			}
		}
		const first = new Map<string, string>();
		// Python compares Unicode scalars; bytewise UTF-8 has the same order.
		for (const id of [...groups.keys()].sort((a, b) =>
			Buffer.compare(Buffer.from(a), Buffer.from(b)),
		)) {
			const key = JSON.stringify(groups.get(id));
			const kept = first.get(key);
			if (kept === undefined) first.set(key, id);
			else {
				for (const text of textNodes.get(id) ?? []) removed.add(text);
				// Only a reference containing this word can change the instance scan.
				if (id.includes("instance") || kept.includes("instance"))
					renames.set(id, kept);
			}
		}
	}

	const render = (element: Element): string => {
		chargeWork("visit", 1);
		const attributes: string[] = [];
		for (const [name, value] of Object.entries(element.attribs)) {
			const { prefix } = splitName(name);
			if (
				(element !== form.html &&
					prefix &&
					form.scope(element).get(prefix) === VELLUM_NS) ||
				(element === form.dataRoot && name === "version") ||
				(translations.has(element) && name === "default")
			)
				continue;
			attributes.push(` ${name}="${xmlAttribute(value)}"`);
		}
		return elementXml(
			element,
			attributes.join(""),
			childXml(element, render, removed),
		);
	};
	let rendered = render(form.html);
	for (const [old, kept] of renames) {
		chargeWork("visit", rendered.length);
		rendered = rendered.replaceAll(
			`jr:itext('${old}')`,
			() => `jr:itext('${kept}')`,
		);
	}
	return rendered;
}

export function builtFormInstanceSources(
	form: ParsedXForm,
	source: Pick<HqAppSource, "langs" | "buildProfiles">,
	declared: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
	const declaredIds = new Set(form.instances.map(({ id }) => id));
	const profiles = [
		source.langs,
		...source.buildProfiles.map((profile) => profile.langs),
	];
	const seen = new Set<string>();
	let common: Map<string, string> | undefined;
	for (const langs of profiles) {
		const key = JSON.stringify([...new Set(langs)].sort());
		if (seen.has(key)) continue;
		seen.add(key);
		const rendered = renderBuild(form, langs);
		chargeWork("visit", rendered.length);
		const actual = instanceSourcesAfterScan(
			declared,
			{ rendered },
			declaredIds,
		);
		if (common === undefined) common = new Map(actual);
		else for (const id of common.keys()) if (!actual.has(id)) common.delete(id);
		if (common.size === declared.size) break;
	}
	return common ?? declared;
}
