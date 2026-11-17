/**
 * CommCare HQ's question summary of the forms the capture peer holds, as
 * `corehq/apps/api/resources/v0_4.py::ApplicationResource.dehydrate_module`
 * serves it at the pinned commit: each form's `questions`, from
 * `xform.py::XForm.get_questions` with triggers, groups, translations and
 * fixtures, and each form's `unique_id` and `xmlns`.
 *
 * A review of changes made in CommCare HQ reads the app through that
 * resource, and acceptance holds the reading to HQ's summary
 * (`lib/deployment/reading/summaryAgreement.ts`). The peer models the summary
 * for the forms a content save leaves, which are flat: every control a
 * direct child of the body, each a question HQ's `_get_control_nodes`
 * reads with no group or repeat around it (`repeat` and `group` null), and
 * every other leaf of the data tree a `DataBindOnly` row
 * (`get_questions`' second pass over `_get_leaf_data_nodes`). A form that
 * holds a group, a repeat, an itemset, a label with an output or a control
 * the model has no type for is refused by name: the peer answers only what
 * it models. What it answered is recorded beside the capture
 * (`BringInRecord.assumedSummary`), for the HQ side to hold to HQ's own
 * answer after the same saves.
 *
 * Pure.
 */

import type { AnyNode, Document, Element } from "domhandler";
import { isTag, isText } from "domhandler";
import type {
	HqApplicationModule,
	HqQuestionSummary,
} from "@/lib/commcare/hq/application";
import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import { parseXml } from "@/lib/commcare/xmlParse";

/** An element's name without its prefix. */
function localName(element: Element): string {
	const at = element.name.indexOf(":");
	return at === -1 ? element.name : element.name.slice(at + 1);
}

function children(node: { readonly children: readonly AnyNode[] }): Element[] {
	return node.children.filter((child): child is Element => isTag(child));
}

function childNamed(
	node: { readonly children: readonly AnyNode[] },
	name: string,
): Element | undefined {
	return children(node).find((child) => localName(child) === name);
}

function refused(xmlns: string | null, what: string): Error {
	return new Error(
		`The capture peer models CommCare HQ's question summary of flat forms alone, and the form ${xmlns ?? "with no xmlns"} holds ${what}. Give the targeted document a form the model reads, or model what HQ's XForm.get_questions does with it.`,
	);
}

/**
 * `_infer_vellum_type` over `VELLUM_TYPES` for the controls the model reads:
 * the tag, the bind's `type` and the control's `appearance`.
 */
function vellumType(
	tag: string,
	type: string | undefined,
	appearance: string | undefined,
	xmlns: string | null,
): string {
	if (appearance !== undefined)
		throw refused(xmlns, `a ${tag} with the appearance ${appearance}`);
	if (tag === "select1") return "Select";
	if (tag === "select") return "MSelect";
	if (tag === "trigger") return "Trigger";
	if (tag === "input") {
		if (type === undefined || type === "xsd:string") return "Text";
		if (type === "xsd:int" || type === "xsd:integer") return "Int";
		if (type === "xsd:double") return "Double";
		if (type === "xsd:date") return "Date";
	}
	throw refused(xmlns, `a ${tag} of type ${type ?? "none"}`);
}

/** A `<value>`'s text, as `ItextValue.from_node` gives one that holds no output. */
function valueText(value: Element, xmlns: string | null): string {
	let text = "";
	for (const child of value.children) {
		if (isText(child)) text += child.data;
		else if (isTag(child)) throw refused(xmlns, "a text with an output");
	}
	return text;
}

/** `jr:itext('<id>')` read as HQ's `_normalize_itext_id` reads it. */
function itextId(ref: string): string | null {
	const prefix = "jr:itext('";
	if (!ref.startsWith(prefix) || !ref.endsWith("')")) return null;
	return ref.slice(prefix.length, -2);
}

interface FormParts {
	readonly dataRoot: Element;
	readonly binds: ReadonlyMap<string, Readonly<Record<string, string>>>;
	readonly setvalues: ReadonlyMap<string, string>;
	/** Each language's texts by id: the value with no `form`. */
	readonly itext: ReadonlyMap<string, ReadonlyMap<string, string>>;
	readonly body: Element;
}

function formParts(document: Document, xmlns: string | null): FormParts {
	const html = children(document).find((child) => localName(child) === "html");
	const head = html === undefined ? undefined : childNamed(html, "head");
	const body = html === undefined ? undefined : childNamed(html, "body");
	const model = head === undefined ? undefined : childNamed(head, "model");
	if (model === undefined || body === undefined)
		throw refused(xmlns, "no model or no body");
	const instance = children(model).find(
		(child) =>
			localName(child) === "instance" && child.attribs.id === undefined,
	);
	const dataRoot = instance === undefined ? undefined : children(instance)[0];
	if (dataRoot === undefined) throw refused(xmlns, "no main instance");
	const binds = new Map<string, Readonly<Record<string, string>>>();
	const setvalues = new Map<string, string>();
	const itext = new Map<string, Map<string, string>>();
	for (const child of children(model)) {
		const name = localName(child);
		const nodeset = child.attribs.nodeset;
		if (name === "bind" && nodeset !== undefined && !binds.has(nodeset))
			binds.set(nodeset, child.attribs);
		const ref = child.attribs.ref;
		if (name === "setvalue" && ref !== undefined && !setvalues.has(ref))
			setvalues.set(ref, child.attribs.value ?? "");
		if (name !== "itext") continue;
		for (const translation of children(child)) {
			const lang = translation.attribs.lang;
			if (localName(translation) !== "translation" || lang === undefined)
				continue;
			const texts = itext.get(lang) ?? new Map<string, string>();
			itext.set(lang, texts);
			for (const text of children(translation)) {
				const id = text.attribs.id;
				if (localName(text) !== "text" || id === undefined) continue;
				const plain = children(text).find(
					(value) =>
						localName(value) === "value" && value.attribs.form === undefined,
				);
				if (plain !== undefined) texts.set(id, valueText(plain, xmlns));
			}
		}
	}
	return { dataRoot, binds, setvalues, itext, body };
}

/** `_get_label_translations`: each language whose text for the label's id is not blank. */
function labelTranslations(
	prompt: Element,
	parts: FormParts,
	langs: readonly string[],
	xmlns: string | null,
): Record<string, string> {
	const label = childNamed(prompt, "label");
	const ref = label?.attribs.ref;
	if (label === undefined || ref === undefined) return {};
	const id = itextId(ref);
	if (id === null) throw refused(xmlns, `a label ref ${ref}`);
	const found: Record<string, string> = {};
	for (const lang of langs) {
		const text = parts.itext.get(lang)?.get(id);
		if (text) found[lang] = text;
	}
	return found;
}

/** Each leaf of the data tree by its path, in document order (`_get_leaf_data_nodes`). */
function leafPaths(root: Element): string[] {
	const found: string[] = [];
	const walk = (node: Element, path: string) => {
		const kids = children(node);
		if (kids.length === 0 && path !== `/${root.name}`) found.push(path);
		for (const kid of kids) walk(kid, `${path}/${kid.name}`);
	};
	walk(root, `/${root.name}`);
	return found;
}

/** `XForm.get_questions` of one flat form, as `dehydrate_module` asks for it, in `langs`. */
export function hqFormQuestions(
	xml: string,
	langs: readonly string[],
	xmlns: string | null,
): HqQuestionSummary[] {
	const parts = formParts(parseXml(xml), xmlns);
	const questions: HqQuestionSummary[] = [];
	const controlled = new Set<string>();
	for (const control of children(parts.body)) {
		const tag = localName(control);
		if (tag === "label") continue;
		if (tag === "group" || tag === "repeat") throw refused(xmlns, `a ${tag}`);
		const path = control.attribs.ref ?? control.attribs.nodeset;
		if (path === undefined) throw refused(xmlns, `a ${tag} with no ref`);
		if (childNamed(control, "itemset") !== undefined)
			throw refused(xmlns, "a select over an itemset");
		const bind = parts.binds.get(path);
		controlled.add(path);
		const items =
			tag === "select1" || tag === "select"
				? children(control).filter((child) => localName(child) === "item")
				: null;
		questions.push({
			path,
			tag,
			type: vellumType(tag, bind?.type, control.attribs.appearance, xmlns),
			repeat: null,
			group: null,
			isGroup: false,
			required: bind?.required === "true()",
			relevant: bind?.relevant ?? null,
			constraint: bind?.constraint ?? null,
			calculate: null,
			setvalue: parts.setvalues.get(path) ?? null,
			labelTranslations: labelTranslations(control, parts, langs, xmlns),
			options:
				items === null
					? null
					: items.map((item) => {
							const value = childNamed(item, "value");
							if (value === undefined)
								throw refused(xmlns, "an item with no value");
							return {
								value: valueText(value, xmlns).trim(),
								labelTranslations: labelTranslations(item, parts, langs, xmlns),
							};
						}),
		});
	}
	for (const path of leafPaths(parts.dataRoot)) {
		if (controlled.has(path)) continue;
		const bind = parts.binds.get(path);
		questions.push({
			path,
			tag: "hidden",
			type: "DataBindOnly",
			repeat: null,
			group: null,
			isGroup: false,
			required: null,
			relevant: bind?.relevant ?? null,
			constraint: bind?.constraint ?? null,
			calculate: bind?.calculate ?? null,
			setvalue: parts.setvalues.get(path) ?? null,
			labelTranslations: {},
			options: null,
		});
	}
	return questions;
}

/** `ApplicationResource.dehydrate_modules` of the source the peer holds, in `app.langs`. */
export function hqApplicationModules(
	source: HqAppSource,
): HqApplicationModule[] {
	return source.modules.map((menu) => ({
		kind: "summarized",
		uniqueId: menu.uniqueId,
		caseType: menu.caseType,
		forms: menu.forms.map((form) => {
			if (form.attachment === null)
				throw refused(form.xmlns, "no XForm in the source");
			return {
				uniqueId: form.readUniqueId,
				xmlns: form.xmlns,
				questions: hqFormQuestions(form.attachment, source.langs, form.xmlns),
			};
		}),
	}));
}
