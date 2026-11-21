/**
 * CommCare HQ's question summary of the forms the capture peer holds, as
 * `corehq/apps/api/resources/v0_4.py::ApplicationResource.dehydrate_module`
 * serves it at the pinned commit: each form's `questions`, from
 * `xform.py::XForm.get_questions` with triggers, groups, translations and
 * fixtures, and each form's `unique_id` and `xmlns`.
 *
 * A review of changes made in CommCare HQ reads the app through that
 * resource, and acceptance holds the reading to HQ's summary
 * (`lib/deployment/reading/summaryAgreement.ts`). The peer models every
 * control of the body as `_get_control_nodes` walks it, each group and
 * repeat giving what it holds its context (a group that holds a repeat
 * directly is the repeat's wrapper and no question of its own), every other
 * leaf of the data tree as a `DataBindOnly` row in the innermost repeat and
 * group around it (`get_questions`' second pass over
 * `_get_leaf_data_nodes`), and each Save to Case block's `@case_id`,
 * `@user_id` and `@date_modified` (its last pass). A form that holds an
 * itemset, a label with an output, a control with no `ref` or one the model
 * has no type for is refused by name: the peer answers only what it models. What it answered is recorded beside the capture
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
		`The capture peer models only part of CommCare HQ's question summary, and the form ${xmlns ?? "with no xmlns"} holds ${what}, which it doesn't model. Give the targeted document a form the model reads, or model what HQ's XForm.get_questions does with it.`,
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
	if (tag === "repeat" && appearance === undefined) return "Repeat";
	if (tag === "group" && appearance === undefined) return "Group";
	if (tag === "group" && appearance === "field-list") return "FieldList";
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

/** `XForm.resolve_path`: a path against the context the control stands in. */
function resolvePath(path: string, context: string, root: Element): string {
	if (path === "") return context;
	if (path.startsWith("/")) return path;
	return context === "" ? `/${localName(root)}/${path}` : `${context}/${path}`;
}

/** Each leaf of the data tree by its path, in document order (`_get_leaf_data_nodes`), with its element. */
function leafNodes(root: Element): [string, Element][] {
	const found: [string, Element][] = [];
	const walk = (node: Element, path: string) => {
		const kids = children(node);
		for (const kid of kids) walk(kid, resolvePath(localName(kid), path, root));
		if (kids.length === 0 && path !== "") found.push([path, node]);
	};
	walk(root, "");
	return found;
}

/** One control `_get_control_nodes` keeps: its element, its path, and the repeat and group around it. */
interface ControlNode {
	readonly node: Element;
	readonly tag: string;
	readonly path: string;
	readonly repeat: string | null;
	readonly group: string | null;
	readonly isLeaf: boolean;
}

/**
 * `_get_control_nodes`: every control of the body in document order, each
 * group and repeat walked with the context HQ gives what it holds. A group
 * that holds a repeat directly is the repeat's wrapper and no control of its
 * own; a group with no `ref` stands at its context's path.
 */
function controlNodes(parts: FormParts, xmlns: string | null): ControlNode[] {
	const found: ControlNode[] = [];
	const walk = (
		parent: Element,
		context: string,
		repeat: string | null,
		group: string | null,
	) => {
		for (const node of children(parent)) {
			const tag = localName(node);
			if (node.name.includes(":") || tag === "label") continue;
			const written =
				node.attribs.nodeset ??
				node.attribs.ref ??
				(tag === "group" ? "" : undefined);
			if (written === undefined) throw refused(xmlns, `a ${tag} with no ref`);
			const path = resolvePath(written, context, parts.dataRoot);
			if (tag === "group") {
				const wrapsRepeat = childNamed(node, "repeat") !== undefined;
				if (!wrapsRepeat)
					found.push({ node, tag, path, repeat, group, isLeaf: false });
				walk(node, path, repeat, wrapsRepeat ? group : path);
			} else if (tag === "repeat") {
				found.push({ node, tag, path, repeat, group, isLeaf: false });
				walk(node, path, path, path);
			} else {
				found.push({ node, tag, path, repeat, group, isLeaf: true });
			}
		}
	};
	walk(parts.body, "", null, null);
	return found;
}

/** The innermost of `contexts` that holds `path` (`first_elem` over them sorted in reverse). */
function innermost(contexts: ReadonlySet<string>, path: string): string | null {
	return (
		[...contexts]
			.sort()
			.reverse()
			.find((context) => path.startsWith(`${context}/`)) ?? null
	);
}

const CASE_XMLNS = "http://commcarehq.org/case/transaction/v2";

/** The nearest `<case>` of the case transaction namespace above `node` (`iterancestors('{cx2}case')`). */
function caseAncestor(node: Element): Element | undefined {
	for (let at = node.parent; at !== null && isTag(at); at = at.parent) {
		if (localName(at) !== "case") continue;
		let declared: Element | null = at;
		while (declared !== null && declared.attribs.xmlns === undefined) {
			const parent: AnyNode | null = declared.parent;
			declared = parent !== null && isTag(parent) ? parent : null;
		}
		if (declared?.attribs.xmlns === CASE_XMLNS) return at;
	}
	return undefined;
}

/** `XForm.get_questions` of one form, as `dehydrate_module` asks for it, in `langs`. */
export function hqFormQuestions(
	xml: string,
	langs: readonly string[],
	xmlns: string | null,
): HqQuestionSummary[] {
	const parts = formParts(parseXml(xml), xmlns);
	const questions: HqQuestionSummary[] = [];
	const controls = controlNodes(parts, xmlns);
	for (const { node, tag, path, repeat, group, isLeaf } of controls) {
		if (childNamed(node, "itemset") !== undefined)
			throw refused(xmlns, "a select over an itemset");
		const bind = parts.binds.get(path);
		const items =
			tag === "select1" || tag === "select"
				? children(node).filter((child) => localName(child) === "item")
				: null;
		/* `_get_label_translations` reads a repeat's label off the group around it. */
		const labelled =
			tag === "repeat" && node.parent !== null && isTag(node.parent)
				? node.parent
				: node;
		questions.push({
			path,
			tag,
			type: vellumType(tag, bind?.type, node.attribs.appearance, xmlns),
			repeat,
			group,
			isGroup: !isLeaf,
			required: bind?.required === "true()",
			relevant: bind?.relevant ?? null,
			constraint: bind?.constraint ?? null,
			calculate: null,
			setvalue: parts.setvalues.get(path) ?? null,
			labelTranslations: labelTranslations(labelled, parts, langs, xmlns),
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
	const controlled = new Set(controls.map((control) => control.path));
	const repeats = new Set<string>();
	const groups = new Set<string>();
	for (const control of controls) {
		if (control.repeat !== null) repeats.add(control.repeat);
		if (control.group !== null) groups.add(control.group);
		if (control.tag === "repeat") {
			repeats.add(control.path);
			groups.add(control.path);
		}
		if (control.tag === "group") groups.add(control.path);
	}
	/* Each Save to Case block's `<case>`, by its path, with the context of the
	 * first leaf under it, kept in the order its first leaf comes. */
	const cases = new Map<
		string,
		{
			readonly node: Element;
			readonly repeat: string | null;
			readonly group: string | null;
		}
	>();
	for (const [path, node] of leafNodes(parts.dataRoot)) {
		if (controlled.has(path)) continue;
		const bind = parts.binds.get(path);
		const repeat = innermost(repeats, path);
		const group = innermost(groups, path);
		questions.push({
			path,
			tag: "hidden",
			type: "DataBindOnly",
			repeat,
			group,
			isGroup: false,
			required: null,
			relevant: bind?.relevant ?? null,
			constraint: bind?.constraint ?? null,
			calculate: bind?.calculate ?? null,
			setvalue: parts.setvalues.get(path) ?? null,
			labelTranslations: {},
			options: null,
		});
		const at = path.indexOf("/case/");
		if (at === -1) continue;
		/* The last leaf's context, at the place the first took: a Map keeps a
		 * key where it was first set, as a Python dict does. */
		cases.set(`${path.slice(0, at)}/case`, { node, repeat, group });
	}
	for (const [casePath, { node, repeat, group }] of cases) {
		const caseNode = caseAncestor(node);
		if (caseNode === undefined) continue;
		for (const attribute of ["case_id", "user_id", "date_modified"]) {
			if (caseNode.attribs[attribute] === undefined) continue;
			const path = `${casePath}/@${attribute}`;
			const bind = parts.binds.get(path);
			questions.push({
				path,
				tag: "hidden",
				type: "DataBindOnly",
				repeat,
				group,
				isGroup: false,
				required: null,
				relevant: bind?.relevant ?? null,
				constraint: bind?.constraint ?? null,
				calculate:
					bind !== undefined
						? (bind.calculate ?? null)
						: (parts.setvalues.get(casePath) ?? null),
				setvalue: null,
				labelTranslations: {},
				options: null,
			});
		}
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
