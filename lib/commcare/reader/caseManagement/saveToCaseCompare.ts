/**
 * Test 4 of a Save to Case block's recognition (`saveToCase.ts`, content): the block Nova's emitter
 * writes at the stored block's path, with the wrappers it stands under,
 * holds the same elements, attributes, binds and setvalues as the stored
 * one. Paths are read by the XPath grammar (`xform/model.ts::pathSteps`) and
 * every expression is compared as a syntax tree (`sameXPathText`); no text
 * is matched. The `vellum:` shadows of a bind and a setvalue are not compared:
 * the form reader already held each to its real attribute.
 */
import type { Document, Element } from "domhandler";
import { isTag } from "domhandler";
import { GUARD_KINDS, generatedBaseName } from "../../xform/generatedNodes";
import {
	type NamespaceScope,
	namespaceScopes,
	splitName,
	VELLUM_NS,
} from "../../xmlNamespaces";
import { tryParseXml } from "../../xmlParse";
import {
	attributesByName,
	sameAttributeMaps,
	sameElementWhole,
} from "../sameElement";
import { sameXPathText } from "../syntaxCompare";
import type { ReadSaveToCaseBlock } from "../xform";
import { isAllocatedName } from "../xform/generated";
import { heldSetvalueRef, pathSteps } from "../xform/model";
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
 *  path is taken from the data root, as Core reads a bind's `nodeset`
 *  (`XFormParser.processStandardBindAttributes`); a setvalue's path is read
 *  only where it is absolute (`setvaluePath`). */
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
 *  through the one path of its kind (`bindPathText`, `setvaluePath`). */
function modelElements(
	form: FormSourceModel,
	elements: readonly Element[],
	pathAttribute: (
		element: Element,
		form: FormSourceModel,
	) => string | undefined,
	select: (path: readonly string[]) => boolean,
): { element: Element; path: string[] }[] {
	let paths = ELEMENT_PATHS.get(elements);
	if (paths === undefined) {
		const root = form.dataRoot.name;
		paths = elements.map((element) => ({
			element,
			path: dataPath(pathAttribute(element, form), root),
		}));
		ELEMENT_PATHS.set(elements, paths);
	}
	const out: { element: Element; path: string[] }[] = [];
	for (const { element, path } of paths)
		if (path !== undefined && select(path)) out.push({ element, path });
	return out;
}

/** A bind's path, its `nodeset`: the one attribute Core reads a bind's node from
 *  (`XFormParser.processStandardBindAttributes`). */
function bindPathText(element: Element): string | undefined {
	return element.attribs.nodeset;
}

/**
 * `binds` (the binds of `form` a comparison takes) less each one that does nothing: a bind with
 * no attribute but its path and `vellum:` shadows, on a node no other bind of the form names.
 * Core gives the node such a bind binds its defaults, no type, relevant, not required, enabled
 * and no constraint (`XFormParser.java::processStandardBindAttributes`, `attachBind`), which a
 * node with no bind holds; HQ's form builder writes one for every group and repeat it saves and
 * for a close-only block's `case/close` (`saveToCase.js`, the close's `relevant` left blank).
 * Beside another bind of its node it is no such thing: it sets the node's type back to none.
 */
function actingBinds(
	form: FormSourceModel,
	binds: readonly { element: Element; path: string[] }[],
): { element: Element; path: string[] }[] {
	return binds.filter(({ element, path }) => {
		const scope = form.scope(element);
		const own = attributesByName(
			element,
			scope,
			(namespace) => namespace === VELLUM_NS,
		);
		own.delete(" nodeset");
		if (own.size > 0) return true;
		return (
			modelElements(form, form.binds, bindPathText, (other) =>
				samePath(other, path),
			).length > 1
		);
	});
}

/** A setvalue's path: its `ref` where it is spelled as Nova writes one, read as Core reads it
 *  (`xform/model.ts::heldSetvalueRef`), so a setvalue Core would aim elsewhere (by a `bind`, a
 *  relative `ref`) is under no block on either side. */
function setvaluePath(
	element: Element,
	form: FormSourceModel,
): string | undefined {
	return heldSetvalueRef(element, form.scope(element));
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
	const aAttributes = attributesByName(a.element, aForm.scope(a.element), skip);
	const bAttributes = attributesByName(b.element, bForm.scope(b.element), skip);
	aAttributes.delete(" nodeset");
	bAttributes.delete(" nodeset");
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

/** Two setvalues alike, as a bind is: one target path, every attribute outside the form
 *  builder's namespace as a set, the `value` as a tree and every other attribute as written,
 *  and the same content (none, since a setvalue with any names no path). */
function sameSetvalue(
	a: { element: Element; path: string[] },
	aForm: FormSourceModel,
	b: { element: Element; path: string[] },
	bForm: FormSourceModel,
): boolean {
	if (!samePath(a.path, b.path)) return false;
	const skip = (namespace: string | null) => namespace === VELLUM_NS;
	const aAttributes = attributesByName(a.element, aForm.scope(a.element), skip);
	const bAttributes = attributesByName(b.element, bForm.scope(b.element), skip);
	aAttributes.delete(" ref");
	bAttributes.delete(" ref");
	const aValue = aAttributes.get(" value");
	const bValue = bAttributes.get(" value");
	aAttributes.delete(" value");
	bAttributes.delete(" value");
	if (!sameAttributeMaps(aAttributes, bAttributes)) return false;
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
 * setvalue whole, as a bind is. The block is compared with
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
		if (
			!sameElementWhole(
				storedElement,
				form.scope,
				emittedElement,
				emitted.scope,
				true,
			)
		)
			return false;
		const under = (one: readonly string[]) => startsWith(one, path);
		return (
			sameLists(
				actingBinds(form, modelElements(form, form.binds, bindPathText, under)),
				actingBinds(
					emitted,
					modelElements(emitted, emitted.binds, bindPathText, under),
				),
				(a, b) => sameBind(a, form, b, emitted, heldPrint, earlier),
			) &&
			sameLists(
				modelElements(form, form.setvalues, setvaluePath, under),
				modelElements(emitted, emitted.setvalues, setvaluePath, under),
				(a, b) => sameSetvalue(a, form, b, emitted),
			)
		);
	};
	if (!sameSubtree(block.element, block.path)) return false;
	if (block.authoredScopeLength !== undefined) {
		const parentPath = block.path.slice(0, -1);
		const name = block.path.at(-1) ?? "";
		const ownGuard = (element: Element) =>
			GUARD_KINDS.some((kind) =>
				isAllocatedName(
					splitName(element.name).local,
					generatedBaseName("guard", name, kind),
				),
			);
		const following = (model: FormSourceModel) => {
			const parent = elementAt(model, parentPath);
			if (!parent) return [];
			const siblings = children(parent);
			const start =
				siblings.findIndex(
					(element) => splitName(element.name).local === name,
				) + 1;
			const remaining = siblings.slice(start);
			const end = remaining.findIndex((sibling) => !ownGuard(sibling));
			return end === -1 ? remaining : remaining.slice(0, end);
		};
		const guards = following(form);
		const printed = following(emitted);
		if (
			!sameLists(
				guards,
				printed,
				(kept, expected) =>
					kept.name === expected.name &&
					sameSubtree(kept, [...parentPath, kept.name]),
			)
		)
			return false;
	}

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
			!sameElementWhole(
				wrapper.element,
				form.scope,
				emittedWrapper,
				emitted.scope,
				false,
			) ||
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
				actingBinds(form, modelElements(form, form.binds, bindPathText, at)),
				actingBinds(
					emitted,
					modelElements(emitted, emitted.binds, bindPathText, at),
				),
				(a, b) => sameBind(a, form, b, emitted, heldPrint, earlier),
			) &&
			sameLists(
				modelElements(form, form.setvalues, setvaluePath, at),
				modelElements(emitted, emitted.setvalues, setvaluePath, at),
				(a, b) => sameSetvalue(a, form, b, emitted),
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
