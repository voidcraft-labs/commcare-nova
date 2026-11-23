/** What HQ scans immediately before adding secondary instances
 * (FormBase.add_stuff_to_xform, XForm.normalize_itext, WrappedNode.render).
 * Work on a projection. The original DOM still supplies the editor and the
 * executable expressions, neither of which goes through html.unescape. */
import { type Element, isTag, isText } from "domhandler";
import type { HqAppSource } from "../../hq/appSource";
import { chargeWork } from "../../workMeter";
import {
	isElement,
	splitName,
	VELLUM_NS,
	XFORMS_NS,
} from "../../xmlNamespaces";
import {
	type InstanceFactories,
	scannedInstances,
} from "../../xpath/instanceSources";
import { scanAfterRenames } from "./itextReferences";
import { ItextValues } from "./itextValues";
import type { ParsedXForm } from "./parse";

function scalarOrder(left: string, right: string): number {
	// Python orders Unicode scalars; JS orders UTF-16 code units.
	let i = 0;
	while (i < left.length && i < right.length) {
		chargeWork("compare", 1);
		const a = left.codePointAt(i) ?? 0;
		const b = right.codePointAt(i) ?? 0;
		if (a !== b) return a - b;
		i += a > 0xffff ? 2 : 1;
	}
	return left.length - right.length;
}

const escapes = new Map(
	Object.entries({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"\r": "&#13;",
		"\t": "&#9;",
		"\n": "&#10;",
	}),
);
function xmlValue(text: string, attribute: boolean): string {
	chargeWork("print", text.length);
	return text.replace(attribute ? /[&<>"\r\t\n]/gu : /[&<>\r]/gu, (ch) => {
		const escaped = escapes.get(ch) ?? ch;
		chargeWork("print", escaped.length - 1);
		return escaped;
	});
}

function xformChildren(
	form: ParsedXForm,
	element: Element,
	name: string,
): Element[] {
	chargeWork("visit", element.children.length);
	return element.children.filter(
		(child): child is Element =>
			isTag(child) && isElement(child, form.scope(child), XFORMS_NS, name),
	);
}

/** HQ groups one text ID's rendered <value>s across the retained languages.
 * Its comparison includes the inherited namespace bindings and the tail of
 * each value. It sorts the value forms and keeps the lexically first text ID. */
function* renderBuild(
	form: ParsedXForm,
	langs: readonly string[],
	values: ItextValues,
): Generator<string> {
	if (!langs.length) return;
	const languages = new Set(langs);
	const removed = new Set<Element>();
	const translations = new Set<Element>();
	const groups = new Map<string, number[]>();
	const textNodes = new Map<string, Element[]>();
	const renames = new Map<string, string>();
	if (form.itext !== undefined) {
		const all = xformChildren(form, form.itext, "translation");
		const byLanguage = new Map<string, Element>();
		for (const trans of all) {
			if (trans.attribs.lang === undefined) return;
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
			return;
		byLanguage.clear();
		for (const trans of all)
			if (!removed.has(trans)) byLanguage.set(trans.attribs.lang, trans);
		for (const [lang, trans] of byLanguage) {
			translations.add(trans);
			const language = values.language(lang);
			const ids = new Set<string>();
			for (const text of xformChildren(form, trans, "text")) {
				const id = text.attribs.id;
				if (id === undefined || ids.has(id)) return;
				ids.add(id);
				const byForm = new Map<string | undefined, number>();
				for (const value of xformChildren(form, text, "value"))
					byForm.set(value.attribs.form, values.value(value));
				const group = groups.get(id) ?? [];
				group.push(values.translation(language, byForm));
				groups.set(id, group);
				const nodes = textNodes.get(id) ?? [];
				nodes.push(text);
				textNodes.set(id, nodes);
			}
		}
		const equivalent = new Map<string, string[]>();
		for (const [id, group] of groups) {
			chargeWork("compare", group.length);
			const key = group.join(",");
			const members = equivalent.get(key) ?? [];
			members.push(id);
			equivalent.set(key, members);
		}
		for (const members of equivalent.values()) {
			if (members.length < 2) continue;
			// Use HQ's duplicate group order as well when reference text embeds another ID.
			members.sort(scalarOrder);
			const [kept] = members;
			for (const id of members.slice(1)) {
				for (const text of textNodes.get(id) ?? []) removed.add(text);
				// A nested itext reference can affect a later rename's instance scan.
				renames.set(id, kept);
			}
		}
	}

	const parts: string[] = [];
	const markup = (text: string) => {
		chargeWork("print", text.length);
		parts.push(text);
	};
	const render = (element: Element): void => {
		chargeWork("visit", 1);
		markup(`<${element.name}`);
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
			markup(` ${name}="`);
			parts.push(xmlValue(value, true));
			markup('"');
		}
		const tagEnd = parts.length;
		markup(">");
		let paired = false;
		let omitTail = false;
		for (const child of element.children) {
			chargeWork("visit", 1);
			if (isText(child)) {
				if (!omitTail) {
					paired = true;
					parts.push(xmlValue(child.data, false));
				}
			} else if (isTag(child)) {
				omitTail = removed.has(child);
				if (!omitTail) {
					paired = true;
					render(child);
				}
			} else if (child.type === "directive") {
				omitTail = false;
				paired = true;
				markup(`<${child.data}>`);
			}
		}
		if (paired) markup(`</${element.name}>`);
		else {
			chargeWork("print", 1);
			parts[tagEnd] = "/>";
		}
	};
	render(form.html);
	// A plain itext ID cannot add or remove an instance pattern, unless
	// another ID embeds the reference whose replacement changes that pattern.
	const spellings = new Map<string, { nested: boolean; scanner: boolean }>();
	const spelling = (id: string) => {
		let facts = spellings.get(id);
		if (facts === undefined) {
			chargeWork("visit", id.length + 1);
			facts = {
				nested: id.includes("jr:itext('") || id.includes("&"),
				scanner: id.includes("instance"),
			};
			spellings.set(id, facts);
		}
		return facts;
	};
	let nested = false;
	for (const [old, kept] of renames) {
		if (spelling(old).nested || spelling(kept).nested) {
			nested = true;
			break;
		}
	}
	if (!nested)
		for (const [old, kept] of renames)
			if (!spelling(old).scanner && !spelling(kept).scanner)
				renames.delete(old);
	yield* scanAfterRenames(parts.join(""), renames);
}

export function builtFormInstanceSources(
	form: ParsedXForm,
	source: Pick<HqAppSource, "langs" | "buildProfiles">,
	declared: ReadonlyMap<string, string>,
	factories: InstanceFactories,
	generated: ReadonlyMap<string, string>,
	observe?: (profile?: string) => InstanceFactories["observe"],
): ReadonlyMap<string, string> {
	const declaredIds = new Set(form.instances.map(({ id }) => id));
	const profiles = [
		{ id: undefined, langs: source.langs },
		...source.buildProfiles,
	];
	const seen = new Set<string>();
	const values = new ItextValues();
	let common: Map<string, string> | undefined;
	for (const { id: profile, langs } of profiles) {
		const key = JSON.stringify([...new Set(langs)].sort());
		if (seen.has(key)) continue;
		seen.add(key);
		const actual = new Map(declared);
		const at = observe
			? { ...factories, observe: observe(profile) }
			: factories;
		for (const rendered of renderBuild(form, langs, values)) {
			for (const [id, src] of scannedInstances(rendered, at, declaredIds))
				if (!declaredIds.has(id)) actual.set(id, src);
		}
		if (common === undefined) common = new Map(actual);
		else for (const id of common.keys()) if (!actual.has(id)) common.delete(id);
		if (common.size === declared.size) break;
	}
	const sources = common ?? new Map(declared);
	for (const [id, source] of generated)
		if (!declaredIds.has(id) && !sources.has(id)) sources.set(id, source);
	return sources;
}
