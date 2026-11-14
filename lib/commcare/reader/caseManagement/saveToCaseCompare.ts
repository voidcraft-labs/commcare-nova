/**
 * Test 4 of a Save to Case block's recognition: the block Nova's emitter
 * writes at the stored block's path, with the wrappers it stands under,
 * holds the same elements, attributes, binds and setvalues as the stored
 * one. Paths are read by the XPath grammar (`xform/model.ts::pathSteps`) and
 * every expression is compared as a syntax tree (`sameXPathText`); no text
 * is matched. The `vellum:` shadows of a bind are not compared: the form
 * reader already held each to its real attribute.
 */
import type { Document, Element } from "domhandler";
import { isTag } from "domhandler";
import {
	attributeNamespace,
	elementNamespace,
	type NamespaceScope,
	namespaceScopes,
	splitName,
	VELLUM_NS,
} from "../../xmlNamespaces";
import { tryParseXml } from "../../xmlParse";
import { sameXPathText } from "../syntaxCompare";
import type { ReadSaveToCaseBlock } from "../xform";
import { pathSteps } from "../xform/model";
import type { ParsedXForm } from "../xform/parse";

/** One form's source as the comparison reads it: its data root, its model's
 *  binds and setvalues, and each element's namespace scope. */
export interface FormSourceModel {
	readonly dataRoot: Element;
	readonly binds: readonly Element[];
	readonly setvalues: readonly Element[];
	readonly scope: (element: Element) => NamespaceScope;
}

/** A stored block with the form it was read from. */
export interface StoredSaveToCaseBlock {
	readonly block: ReadSaveToCaseBlock;
	readonly form: FormSourceModel;
}

/** The stored form's source, as the form reader parsed it. */
export function storedFormSource(parsed: ParsedXForm): FormSourceModel {
	return {
		dataRoot: parsed.dataRoot,
		binds: parsed.binds,
		setvalues: parsed.setvalues,
		scope: (element) => parsed.scope(element),
	};
}

function children(element: Element): Element[] {
	return element.children.filter(isTag);
}

function childNamed(element: Element, local: string): Element | undefined {
	return children(element).find(
		(child) => splitName(child.name).local === local,
	);
}

/** The source a form Nova emitted holds, read from its XML: `<h:html>`,
 *  its head's model, the model's first instance with no `src` and that
 *  instance's root element. Undefined where the text is no such form. */
export function emittedFormSource(xml: string): FormSourceModel | undefined {
	const parsed = tryParseXml(xml);
	if ("issue" in parsed) return undefined;
	const document: Document = parsed.doc;
	const html = document.children.find(isTag);
	const head = html === undefined ? undefined : childNamed(html, "head");
	const model = head === undefined ? undefined : childNamed(head, "model");
	if (model === undefined) return undefined;
	const instance = children(model).find(
		(child) =>
			splitName(child.name).local === "instance" &&
			child.attribs.src === undefined,
	);
	const dataRoot = instance === undefined ? undefined : children(instance)[0];
	if (dataRoot === undefined) return undefined;
	const scopes = namespaceScopes(document);
	return {
		dataRoot,
		binds: children(model).filter(
			(child) => splitName(child.name).local === "bind",
		),
		setvalues: children(model).filter(
			(child) => splitName(child.name).local === "setvalue",
		),
		scope: scopes,
	};
}

/** A path's steps from the data root, a final attribute step as `@name`;
 *  undefined where the text is no path of the form's data. A relative
 *  path is taken from the data root, as the form builder reads a bind's. */
function dataPath(
	text: string | undefined,
	root: string,
): string[] | undefined {
	if (text === undefined) return undefined;
	const steps = pathSteps(text);
	if (steps === undefined) return undefined;
	let rest = steps;
	if (steps[0] === "/") {
		if (steps[1] !== root) return undefined;
		rest = steps.slice(2);
	}
	const out: string[] = [];
	for (const step of rest) {
		if (step === ".") continue;
		if (step === "..") {
			if (out.length === 0) return undefined;
			out.pop();
			continue;
		}
		out.push(step);
	}
	return out;
}

function startsWith(
	path: readonly string[],
	prefix: readonly string[],
): boolean {
	return (
		path.length >= prefix.length && prefix.every((step, i) => path[i] === step)
	);
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && startsWith(a, b);
}

/** The element at `path` under the data root, by name, first of each name. */
function elementAt(
	form: FormSourceModel,
	path: readonly string[],
): Element | undefined {
	let at: Element | undefined = form.dataRoot;
	for (const name of path) {
		if (at === undefined) return undefined;
		at = children(at).find((child) => child.name === name);
	}
	return at;
}

/** An element's attributes by namespace and local name, the namespace
 *  declarations left out. */
function attributesOf(
	element: Element,
	scope: NamespaceScope,
	skip: (namespace: string | null) => boolean,
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

function sameMap(
	a: ReadonlyMap<string, string>,
	b: ReadonlyMap<string, string>,
): boolean {
	if (a.size !== b.size) return false;
	for (const [key, value] of a) if (b.get(key) !== value) return false;
	return true;
}

/** Two data elements alike: name and namespace, attributes as sets, own
 *  text, and every child alike in order. */
function sameDataElement(
	a: Element,
	aForm: FormSourceModel,
	b: Element,
	bForm: FormSourceModel,
	deep: boolean,
): boolean {
	const aScope = aForm.scope(a);
	const bScope = bForm.scope(b);
	if (
		splitName(a.name).local !== splitName(b.name).local ||
		elementNamespace(a, aScope) !== elementNamespace(b, bScope)
	)
		return false;
	const keep = () => false;
	if (!sameMap(attributesOf(a, aScope, keep), attributesOf(b, bScope, keep)))
		return false;
	if (!deep) return true;
	const aChildren = children(a);
	const bChildren = children(b);
	if (aChildren.length !== bChildren.length) return false;
	if (aChildren.length === 0) return ownText(a) === ownText(b);
	return aChildren.every((child, i) =>
		sameDataElement(child, aForm, bChildren[i] as Element, bForm, true),
	);
}

function ownText(element: Element): string {
	return element.children
		.map((child) =>
			"data" in child && child.type === "text" ? child.data : "",
		)
		.join("")
		.trim();
}

const EXPRESSION_ATTRIBUTES = new Set([
	"calculate",
	"relevant",
	"constraint",
	"required",
	"readonly",
]);

/** The binds and setvalues of `form` whose path `select` takes, in order. */
function modelElements(
	form: FormSourceModel,
	elements: readonly Element[],
	pathAttribute: (element: Element) => string | undefined,
	select: (path: readonly string[]) => boolean,
): { element: Element; path: string[] }[] {
	const root = form.dataRoot.name;
	const out: { element: Element; path: string[] }[] = [];
	for (const element of elements) {
		const path = dataPath(pathAttribute(element), root);
		if (path !== undefined && select(path)) out.push({ element, path });
	}
	return out;
}

function bindPathText(element: Element): string | undefined {
	return element.attribs.nodeset ?? element.attribs.ref;
}

/** Two binds alike: one path, the same plain attributes, each expression
 *  as a tree; a `vellum:` shadow is not compared. */
function sameBind(
	a: { element: Element; path: string[] },
	aForm: FormSourceModel,
	b: { element: Element; path: string[] },
	bForm: FormSourceModel,
): boolean {
	if (!samePath(a.path, b.path)) return false;
	const skip = (namespace: string | null) => namespace === VELLUM_NS;
	const aAttributes = attributesOf(a.element, aForm.scope(a.element), skip);
	const bAttributes = attributesOf(b.element, bForm.scope(b.element), skip);
	for (const key of ["nodeset", "ref"]) {
		aAttributes.delete(` ${key}`);
		bAttributes.delete(` ${key}`);
	}
	if (aAttributes.size !== bAttributes.size) return false;
	for (const [key, value] of aAttributes) {
		const other = bAttributes.get(key);
		if (other === undefined) return false;
		const local = key.slice(key.indexOf(" ") + 1);
		const plain = key.startsWith(" ");
		if (plain && EXPRESSION_ATTRIBUTES.has(local)) {
			if (!sameXPathText(value, other, { ruleSet: "form" })) return false;
		} else if (value !== other) return false;
	}
	return true;
}

/** Two setvalues alike: one event, one target path, the value as a tree. */
function sameSetvalue(
	a: { element: Element; path: string[] },
	b: { element: Element; path: string[] },
): boolean {
	if (!samePath(a.path, b.path)) return false;
	if ((a.element.attribs.event ?? "") !== (b.element.attribs.event ?? ""))
		return false;
	const aValue = a.element.attribs.value;
	const bValue = b.element.attribs.value;
	if (aValue === undefined || bValue === undefined) return aValue === bValue;
	return sameXPathText(aValue, bValue, { ruleSet: "form" });
}

function sameLists<T>(
	a: readonly T[],
	b: readonly T[],
	same: (x: T, y: T) => boolean,
): boolean {
	return a.length === b.length && a.every((one, i) => same(one, b[i] as T));
}

/**
 * Whether the block the emitter writes at `stored.block.path` equals the
 * stored one, with its wrappers: elements by name and order, attributes as
 * sets, each bind by its path with each expression as a syntax tree, each
 * setvalue by event, ref and value tree. The block is compared with
 * everything under it; a wrapper by its own element, the binds on its own
 * node and the setvalues that set it, since its children are other
 * blocks, each judged on its own: what is compared of them is their names,
 * in order, so a guard or a block the emitter writes beside it and the
 * source lacks is a difference.
 */
export function blockTreesEqual(
	stored: StoredSaveToCaseBlock,
	emitted: FormSourceModel,
): boolean {
	const { block, form } = stored;
	const blockPath = block.path;
	const emittedBlock = elementAt(emitted, blockPath);
	if (emittedBlock === undefined) return false;
	if (!sameDataElement(block.element, form, emittedBlock, emitted, true))
		return false;
	const under = (path: readonly string[]) => startsWith(path, blockPath);
	const pathOf = (element: Element) => element.attribs.ref;
	if (
		!sameLists(
			modelElements(form, form.binds, bindPathText, under),
			modelElements(emitted, emitted.binds, bindPathText, under),
			(a, b) => sameBind(a, form, b, emitted),
		) ||
		!sameLists(
			modelElements(form, form.setvalues, pathOf, under),
			modelElements(emitted, emitted.setvalues, pathOf, under),
			sameSetvalue,
		)
	)
		return false;
	for (const wrapper of block.wrappers) {
		const emittedWrapper = elementAt(emitted, wrapper.path);
		if (
			emittedWrapper === undefined ||
			!sameDataElement(wrapper.element, form, emittedWrapper, emitted, false) ||
			!sameLists(
				children(wrapper.element).map((child) => child.name),
				children(emittedWrapper).map((child) => child.name),
				(a, b) => a === b,
			)
		)
			return false;
		const at = (path: readonly string[]) =>
			samePath(path, wrapper.path) ||
			(path.length === wrapper.path.length + 1 &&
				startsWith(path, wrapper.path) &&
				(path[path.length - 1] as string).startsWith("@"));
		if (
			!sameLists(
				modelElements(form, form.binds, bindPathText, at),
				modelElements(emitted, emitted.binds, bindPathText, at),
				(a, b) => sameBind(a, form, b, emitted),
			) ||
			!sameLists(
				modelElements(form, form.setvalues, pathOf, at),
				modelElements(emitted, emitted.setvalues, pathOf, at),
				sameSetvalue,
			)
		)
			return false;
	}
	return true;
}
