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

/** The data node at `path` under `form`'s root, with its bind's `calculate`. */
export function modelNodeAt(
	form: FormSourceModel,
	path: readonly string[],
):
	| { readonly name: string; readonly calculate: string | undefined }
	| undefined {
	const element = elementAt(form, path);
	if (element === undefined) return undefined;
	const [bind] = modelElements(form, form.binds, bindPathText, (one) =>
		samePath(one, path),
	);
	return { name: element.name, calculate: bind?.element.attribs.calculate };
}

/**
 * A form some of whose Save to Case rows hold a date and time in the spelling
 * Nova wrote before its clock nodes existed, as the comparison reads it.
 */
export interface EarlierSpelling {
	/** Whether a stored bind's `calculate` is that spelling of the emitted bind's `calculate`. */
	readonly calculate: (
		stored: Element,
		emitted: string,
		emittedForm: FormSourceModel,
	) => boolean;
	/** Whether the emitted node at `path` is a clock node that spelling never wrote. */
	readonly emittedOnly: (path: readonly string[]) => boolean;
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

/** Each model element's path, read once per list of a form's binds or setvalues, since every
 *  block of a form is compared against the same lists. */
const ELEMENT_PATHS = new WeakMap<
	readonly Element[],
	readonly { readonly element: Element; readonly path: string[] | undefined }[]
>();

/** The binds and setvalues of `form` whose path `select` takes, in order. A list is always read
 *  through the one path attribute of its kind (`bindPathText`, `setvalueRef`). */
function modelElements(
	form: FormSourceModel,
	elements: readonly Element[],
	pathAttribute: (element: Element) => string | undefined,
	select: (path: readonly string[]) => boolean,
): { element: Element; path: string[] }[] {
	let paths = ELEMENT_PATHS.get(elements);
	if (paths === undefined) {
		const root = form.dataRoot.name;
		paths = elements.map((element) => ({
			element,
			path: dataPath(pathAttribute(element), root),
		}));
		ELEMENT_PATHS.set(elements, paths);
	}
	const out: { element: Element; path: string[] }[] = [];
	for (const { element, path } of paths)
		if (path !== undefined && select(path)) out.push({ element, path });
	return out;
}

function bindPathText(element: Element): string | undefined {
	return element.attribs.nodeset ?? element.attribs.ref;
}

function setvalueRef(element: Element): string | undefined {
	return element.attribs.ref;
}

/** Each wrapper's verdict, per emitted form and per set of paths judged apart: a wrapper and the
 *  children no block owns are the same for every block a form holds under it, so each is judged
 *  once. */
const WRAPPER_VERDICTS = new WeakMap<
	FormSourceModel,
	WeakMap<ReadonlySet<string>, Map<Element, boolean>>
>();

function wrapperVerdicts(
	emitted: FormSourceModel,
	judgedApart: ReadonlySet<string>,
): Map<Element, boolean> {
	let byApart = WRAPPER_VERDICTS.get(emitted);
	if (byApart === undefined) {
		byApart = new WeakMap();
		WRAPPER_VERDICTS.set(emitted, byApart);
	}
	let verdicts = byApart.get(judgedApart);
	if (verdicts === undefined) {
		verdicts = new Map();
		byApart.set(judgedApart, verdicts);
	}
	return verdicts;
}

/**
 * Nova's own print of the tree the expression stage held for the slot whose
 * text a stored bind's attribute holds (`element`, the attribute's local
 * name); `undefined` where the attribute holds no such slot's text, or the
 * stage held none.
 */
export type HeldSlotPrint = (
	element: Element,
	attribute: string,
) => string | undefined;

/** Two binds alike: one path, the same plain attributes, each expression
 *  as a tree; a `vellum:` shadow is not compared. An expression `a` holds
 *  that the expression stage held as a slot's tree is the emitter's where
 *  `b`'s is that tree's print (`heldPrint`): the stage compared it with the
 *  source and reported what a first publish changes in it. A `calculate` in
 *  the spelling Nova wrote before is the emitter's where `earlier` says so. */
function sameBind(
	a: { element: Element; path: string[] },
	aForm: FormSourceModel,
	b: { element: Element; path: string[] },
	bForm: FormSourceModel,
	heldPrint?: HeldSlotPrint,
	earlier?: EarlierSpelling,
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
			if (sameXPathText(value, other, { ruleSet: "form" })) continue;
			const held = heldPrint?.(a.element, local);
			if (held !== undefined && sameXPathText(held, other, { ruleSet: "form" }))
				continue;
			if (
				local !== "calculate" ||
				earlier?.calculate(a.element, other, bForm) !== true
			)
				return false;
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
 * source lacks is a difference. Every other child of a wrapper, one not in
 * `judgedApart` (the paths of the blocks and wrappers judged on their own),
 * is compared whole with its binds and setvalues: a guard, a keyed create's
 * count and a clock node are the emitter's, and an edit to one is a
 * difference. A stored child in `leftOut` (a block the reading refuses, a
 * wrapper only such blocks stand in, a refused keyed create's count) is in
 * no document the reading proposes, so it is left out of the comparison: its
 * own finding names it, and the blocks beside it are judged as Nova prints
 * them without it.
 * Where `earlier` is given, a row in the spelling Nova wrote
 * before is compared by the value it holds, and a clock node that spelling
 * never wrote is left out of the emitted wrapper's children.
 */
export function blockTreesEqual(
	stored: StoredSaveToCaseBlock,
	emitted: FormSourceModel,
	judgedApart: ReadonlySet<string> = new Set(),
	heldPrint?: HeldSlotPrint,
	leftOut: ReadonlySet<string> = new Set(),
	earlier?: EarlierSpelling,
): boolean {
	const { block, form } = stored;
	/** The element at `path` on both sides alike with everything under it,
	 *  and the binds and setvalues under it. */
	const sameSubtree = (
		storedElement: Element,
		path: readonly string[],
	): boolean => {
		const emittedElement = elementAt(emitted, path);
		if (emittedElement === undefined) return false;
		if (!sameDataElement(storedElement, form, emittedElement, emitted, true))
			return false;
		const under = (one: readonly string[]) => startsWith(one, path);
		return (
			sameLists(
				modelElements(form, form.binds, bindPathText, under),
				modelElements(emitted, emitted.binds, bindPathText, under),
				(a, b) => sameBind(a, form, b, emitted, heldPrint, earlier),
			) &&
			sameLists(
				modelElements(form, form.setvalues, setvalueRef, under),
				modelElements(emitted, emitted.setvalues, setvalueRef, under),
				sameSetvalue,
			)
		);
	};
	if (!sameSubtree(block.element, block.path)) return false;
	const ownPath = new Set([
		block.path.join("/"),
		...block.wrappers.map((wrapper) => wrapper.path.join("/")),
	]);
	const wrapperHolds = (wrapper: ReadSaveToCaseBlock["wrappers"][number]) => {
		const emittedWrapper = elementAt(emitted, wrapper.path);
		const storedChildren = children(wrapper.element).filter(
			(child) => !leftOut.has([...wrapper.path, child.name].join("/")),
		);
		if (
			emittedWrapper === undefined ||
			!sameDataElement(wrapper.element, form, emittedWrapper, emitted, false) ||
			!sameLists(
				storedChildren.map((child) => child.name),
				children(emittedWrapper)
					.map((child) => child.name)
					.filter(
						(name) => earlier?.emittedOnly([...wrapper.path, name]) !== true,
					),
				(a, b) => a === b,
			)
		)
			return false;
		// Each child no other comparison judges (a guard, a keyed create's
		// count, a clock node, a selected-cases query node) whole, with its
		// binds and setvalues.
		for (const child of storedChildren) {
			const path = [...wrapper.path, child.name];
			const key = path.join("/");
			if (ownPath.has(key) || judgedApart.has(key)) continue;
			if (!sameSubtree(child, path)) return false;
		}
		const at = (path: readonly string[]) =>
			samePath(path, wrapper.path) ||
			(path.length === wrapper.path.length + 1 &&
				startsWith(path, wrapper.path) &&
				(path[path.length - 1] as string).startsWith("@"));
		return (
			sameLists(
				modelElements(form, form.binds, bindPathText, at),
				modelElements(emitted, emitted.binds, bindPathText, at),
				(a, b) => sameBind(a, form, b, emitted, heldPrint, earlier),
			) &&
			sameLists(
				modelElements(form, form.setvalues, setvalueRef, at),
				modelElements(emitted, emitted.setvalues, setvalueRef, at),
				sameSetvalue,
			)
		);
	};
	// Where every path of this block is judged apart anyway, a wrapper's verdict is the same for
	// every block under it.
	const shared = [...ownPath].every((key) => judgedApart.has(key))
		? wrapperVerdicts(emitted, judgedApart)
		: undefined;
	for (const wrapper of block.wrappers) {
		let holds = shared?.get(wrapper.element);
		if (holds === undefined) {
			holds = wrapperHolds(wrapper);
			shared?.set(wrapper.element, holds);
		}
		if (!holds) return false;
	}
	return true;
}
