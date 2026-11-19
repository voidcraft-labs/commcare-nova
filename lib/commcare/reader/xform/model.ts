/**
 * A form's model as HQ's form builder reads it (Vellum `parser.js`): the data
 * tree, the binds, the model's setvalues and the secondary instances. Paths
 * are read with the XPath grammar (`xpath/formSyntax.ts`), never by pattern.
 */

import type { Element } from "domhandler";
import { isTag } from "domhandler";
import type { FindingDetail, HqPlace } from "@/lib/publish/hqFindings";
import { rethrowWorkStop } from "../../workMeter";
import { FormPath } from "../../xform/formPath";
import {
	elementNamespace,
	JAVAROSA_NS,
	type NamespaceScope,
	namespacedAttribute,
	splitName,
	VELLUM_NS,
} from "../../xmlNamespaces";
import type { FormSyntax } from "../../xpath/formSyntax";
import type { Claim } from "../claims";
import { questionPlace } from "../place";
import { readFormSyntax } from "../syntaxRead";
import { ownText, type XmlCursor } from "../xmlCursor";
import { X } from "./claims";
import type { ParsedXForm } from "./parse";

export interface DataNode {
	readonly element: Element;
	readonly name: string;
	/** Names from the data root down, the root left out. */
	readonly path: readonly string[];
	readonly parent: DataNode | null;
	readonly children: readonly DataNode[];
	/** `vellum:role`. */
	readonly role: string | undefined;
	/** Carries `jr:template`. */
	readonly template: boolean;
	/** Its own text, where it has no element child. */
	readonly text: string;
}

/** Whether a node stands inside a repeat: under a repeat's row, or a model-iteration row. */
export function insideRepeat(node: DataNode): boolean {
	for (let at = node.parent; at !== null; at = at.parent)
		if (at.template) return true;
	return false;
}

/** The `FormPath` of a node from the form's root `data`; undefined where a name is no XML name
 *  Nova writes. */
export function formPathOf(node: DataNode): FormPath | undefined {
	try {
		let path = FormPath.root();
		for (const name of node.path) path = path.child(name);
		return path;
	} catch (error) {
		rethrowWorkStop(error);
		return undefined;
	}
}

export interface BindFacts {
	readonly element: Element;
	/** `type` as written. */
	readonly type: string | undefined;
	/** The logic attributes it carries, each with its text. */
	readonly logic: Readonly<
		Partial<
			Record<
				| "relevant"
				| "required"
				| "constraint"
				| "calculate"
				| "readonly"
				| "constraintMsg",
				string
			>
		>
	>;
}

export interface SetvalueFacts {
	readonly element: Element;
	readonly event: string;
	/** The path `ref` names, an attribute as a last step `@name`; undefined where it names none,
	 *  or where the setvalue is spelled otherwise than Nova writes one (`heldSetvalueRef`). */
	readonly target: readonly string[] | undefined;
	readonly value: string | undefined;
	/** The refusal of the data tree its `ref` reaches, where it reaches a node the tree refused
	 *  or names none past one: the setvalue stands under that refusal. */
	readonly refusal: NodeRefusal | undefined;
}

/** A refusal of the data tree itself, with the detail its one finding names and the place it
 *  stands at: the form's where none is named. */
export interface NodeRefusal {
	readonly claim: Claim<"refuse">;
	readonly detail?: FindingDetail;
	readonly place?: HqPlace;
}

/** A data tree read from the data root, every node by its path joined with "/". */
export interface DataTree {
	readonly root: Element;
	readonly nodes: ReadonlyMap<string, DataNode>;
	/** The nodes in document order. */
	readonly order: readonly DataNode[];
	/** The data root's own children. */
	readonly top: readonly DataNode[];
	/** Each node a refusal of the tree itself covers (two siblings of one name, an authored
	 *  `meta` block), with everything under it, and the Save to Case block a refused node stands
	 *  in, to the refusal. Every bind, setvalue and control that reaches one stands under it, so
	 *  the source's one cause is one finding. */
	readonly refused: ReadonlyMap<DataNode, NodeRefusal>;
}

/** What a path names in the data tree. */
export type NodePathRead =
	| {
			readonly kind: "node";
			readonly node: DataNode;
			/** An attribute's name where the path's last step is one. */
			readonly attribute?: string;
	  }
	/** A chain of steps that names the data root itself, or an attribute of it: `/data`, `/data/.`,
	 *  and a relative `.` from the root, which Core resolves to the root as well
	 *  (`XFormParser.getAbsRef` from the FormDef's own reference, `/data`). No question of the
	 *  form owns it. A path that steps down and back up to the root is no path (below). */
	| { readonly kind: "root"; readonly attribute?: string }
	/** A chain of steps that names no node of the tree, `/` above the data root included.
	 *  `through` is the last node the steps named before one named nothing. */
	| { readonly kind: "none"; readonly through?: DataNode }
	/** Not a chain of child steps with at most one final attribute step, or one Core's reference
	 *  parser refuses: a `..` in an absolute path, or after a name step of a relative one. */
	| { readonly kind: "not-a-path" };

/** The text's steps, `/` first for an absolute path; undefined where the text is no chain of
 *  name steps, `.` and `..`, with at most one final attribute step. */
export function pathSteps(
	text: string,
	predicates: "refuse" | "pass" = "refuse",
): readonly string[] | undefined {
	const read = readFormSyntax(text);
	if (!read.ok || read.node === undefined) return undefined;
	const steps: string[] = [];
	const walk = (node: FormSyntax): boolean => {
		switch (node.kind) {
			case "filter":
				return predicates === "pass" && walk(node.base);
			case "child":
				if (node.descendant) return false;
				if (node.left === undefined) steps.push("/");
				else if (!walk(node.left)) return false;
				return walk(node.step);
			case "name":
				if (node.wildcard) return false;
				steps.push(node.name);
				return true;
			case "self":
				steps.push(".");
				return true;
			case "parent":
				steps.push("..");
				return true;
			case "axis":
				if (node.axis !== "attribute" || node.value.kind !== "name")
					return false;
				steps.push(`@${node.value.name}`);
				return true;
			default:
				return false;
		}
	};
	if (!walk(read.node)) return undefined;
	const attributes = steps.filter((step) => step.startsWith("@"));
	if (
		attributes.length > 1 ||
		(attributes.length === 1 && !steps[steps.length - 1]?.startsWith("@"))
	)
		return undefined;
	return steps;
}

/** A path read from `context`, a node path with an optional final `@name`:
 *  absolute from the data root `root`, or from `current()`, which is `context`. */
export function resolveContextPath(
	node: FormSyntax,
	context: readonly string[],
	root: string,
): string[] | undefined {
	const steps: string[] = [];
	let start: "root" | "current" | undefined;
	const walk = (at: FormSyntax): boolean => {
		switch (at.kind) {
			case "group":
				return walk(at.value);
			case "child":
				if (at.descendant) return false;
				if (at.left === undefined) start = "root";
				else if (!walk(at.left)) return false;
				return walk(at.step);
			case "call":
				if (at.name !== "current" || at.args.length > 0 || start !== undefined)
					return false;
				start = "current";
				return true;
			case "name":
				if (at.wildcard) return false;
				steps.push(at.name);
				return true;
			case "self":
				steps.push(".");
				return true;
			case "parent":
				steps.push("..");
				return true;
			case "axis":
				if (at.axis !== "attribute" || at.value.kind !== "name") return false;
				steps.push(`@${at.value.name}`);
				return true;
			default:
				return false;
		}
	};
	if (!walk(node) || start === undefined) return undefined;
	let at: string[];
	let rest = steps;
	if (start === "root") {
		if (steps[0] !== root) return undefined;
		at = [];
		rest = steps.slice(1);
	} else at = [...context];
	for (const step of rest) {
		if (step === ".") continue;
		if (step === "..") {
			if (at.length === 0) return undefined;
			at.pop();
			continue;
		}
		at.push(step);
	}
	return at;
}

/**
 * What a path names, read as Vellum's `processPath` reads a bind's: an absolute path from the
 * form's root, whose first step must be the data root's name, or a relative path from `base`
 * (the data root where `base` is null). A `..` step anywhere but among the leading steps of a
 * relative path is no path: Core's reference parser refuses it (`XPathPathExpr.getReference`),
 * so the form does not load.
 */
export function readNodePath(
	text: string,
	tree: DataTree,
	base: DataNode | null,
): NodePathRead {
	const steps = pathSteps(text);
	if (steps === undefined) {
		// `/` alone is the document's root, above the data root: a path naming no node.
		const read = readFormSyntax(text);
		return read.ok && read.node?.kind === "root"
			? { kind: "none" }
			: { kind: "not-a-path" };
	}
	let at: DataNode | null = base;
	let rest = steps;
	// Core takes a `..` step only before every other step of a relative path
	// (`XPathPathExpr.getReference`, `parentsAllowed`), and refuses to load a form whose
	// reference holds one anywhere else.
	let parentsAllowed = steps[0] !== "/";
	if (steps[0] === "/") {
		if (steps[1] === "..") return { kind: "not-a-path" };
		if (steps[1] !== tree.root.name) return { kind: "none" };
		at = null;
		rest = steps.slice(2);
	}
	let attribute: string | undefined;
	for (const step of rest) {
		if (step.startsWith("@")) {
			attribute = step.slice(1);
			break;
		}
		if (step === ".") continue;
		if (step === "..") {
			if (!parentsAllowed) return { kind: "not-a-path" };
			if (at === null) return { kind: "none" };
			at = at.parent;
			continue;
		}
		parentsAllowed = false;
		const children: readonly DataNode[] = at === null ? tree.top : at.children;
		const next = children.find((child) => child.name === step);
		if (next === undefined)
			return at === null ? { kind: "none" } : { kind: "none", through: at };
		at = next;
	}
	if (at === null)
		return attribute === undefined
			? { kind: "root" }
			: { kind: "root", attribute };
	return attribute === undefined
		? { kind: "node", node: at }
		: { kind: "node", node: at, attribute };
}

/** The refusal of the data tree an absolute path stands under whatever predicates its steps
 *  hold: a plugin of the form builder names the nodes of its block with them
 *  (`/data/balance[@type='b']/entry/@quantity`). Undefined where the steps, read past their
 *  predicates, reach no node the tree refused. */
export function refusalBesidePredicates(
	text: string,
	tree: DataTree,
): NodeRefusal | undefined {
	const steps = pathSteps(text, "pass");
	if (steps === undefined || steps[0] !== "/" || steps[1] !== tree.root.name)
		return undefined;
	let at: DataNode | undefined;
	for (const step of steps.slice(2)) {
		if (step.startsWith("@") || step === "." || step === "..") break;
		const children: readonly DataNode[] =
			at === undefined ? tree.top : at.children;
		const next = children.find((child) => child.name === step);
		if (next === undefined) break;
		at = next;
		const refusal = tree.refused.get(at);
		if (refusal !== undefined) return refusal;
	}
	return undefined;
}

/** The refusal of the data tree a path stands under: the node's it names, or, where it names
 *  none, the last node its steps named, since a node the tree refused covers everything under
 *  it, and a path that names a node of a refused pair by its name may mean either. */
export function refusalOf(
	read: NodePathRead,
	tree: DataTree,
): NodeRefusal | undefined {
	if (read.kind === "node") return tree.refused.get(read.node);
	if (read.kind === "none" && read.through !== undefined)
		return tree.refused.get(read.through);
	return undefined;
}

/** `name`'s value among an element's attributes, by the name as written with no prefix. */
function plainAttribute(element: Element, name: string): string | undefined {
	return Object.hasOwn(element.attribs, name)
		? element.attribs[name]
		: undefined;
}

/** The attribute's name as the source wrote it, for an attribute in `uri` named `local`. */
export function attributeNameIn(
	element: Element,
	parsed: ParsedXForm,
	uri: string,
	local: string,
): string | undefined {
	const scope = parsed.scope(element);
	for (const name of Object.keys(element.attribs)) {
		const split = splitName(name);
		if (
			split.local === local &&
			split.prefix !== "" &&
			scope.get(split.prefix) === uri
		)
			return name;
	}
	return undefined;
}

/**
 * The data tree, as `parser.js::parseDataTree` and `parseDataElement` read it. Claims what
 * stands whatever the node becomes: two siblings of one name, an authored `meta` block, a
 * `vellum:comment`, a `vellum:lock`. A refused node inside a Save to Case block refuses the
 * block with it, under the same finding: a block is one change, and no reading holds part of
 * one (two rows of one name in a block, which HQ's form builder writes as one row).
 */
export function readDataTree(
	parsed: ParsedXForm,
	cursor: XmlCursor,
	formPlace: HqPlace,
	appended: ReadonlySet<string> = new Set(),
): DataTree {
	const nodes = new Map<string, DataNode>();
	const order: DataNode[] = [];
	const build = (element: Element, parent: DataNode | null): DataNode => {
		const children: DataNode[] = [];
		const elementChildren = element.children.filter(isTag);
		const node: DataNode = {
			element,
			name: element.name,
			path: parent === null ? [element.name] : [...parent.path, element.name],
			parent,
			children,
			role: namespacedAttribute(
				element,
				parsed.scope(element),
				VELLUM_NS,
				"role",
			),
			template:
				namespacedAttribute(
					element,
					parsed.scope(element),
					JAVAROSA_NS,
					"template",
				) !== undefined,
			text: elementChildren.length === 0 ? ownText(element) : "",
		};
		order.push(node);
		if (!nodes.has(node.path.join("/"))) nodes.set(node.path.join("/"), node);
		for (const child of elementChildren) children.push(build(child, node));
		return node;
	};
	const top = parsed.dataRoot.children
		.filter(isTag)
		.map((element) => build(element, null));
	const refused = new Map<DataNode, NodeRefusal>();
	const tree: DataTree = { root: parsed.dataRoot, nodes, order, top, refused };
	const refuseUnder = (node: DataNode, refusal: NodeRefusal) => {
		refused.set(node, refusal);
		for (const child of node.children) refuseUnder(child, refusal);
	};
	/** Refuses a node whole at its question, with what stands under it; `at`, where given, is
	 *  the node under it whose value makes the class, where the refusal's record stands. */
	const refuseAtQuestion = (
		node: DataNode,
		claim: Claim<"refuse">,
		detail?: FindingDetail,
		at?: DataNode,
	) => {
		const place = questionPlace(
			formPlace as Extract<HqPlace, { kind: "form" }>,
			node.path,
		);
		if (at === undefined)
			cursor.refuseSubtree(node.element, claim, place, detail);
		else
			cursor.refuseSubtreeAt(
				node.element,
				{ element: at.element },
				claim,
				place,
				detail,
			);
		refuseUnder(node, {
			claim,
			place,
			...(detail === undefined ? {} : { detail }),
		});
	};
	// Nodes CommCare HQ's build or a plugin of the form builder owns, each refused whole with
	// its bind, setvalues and control, which stand under the refusal of the data tree.
	for (const node of order) {
		if (refused.has(node)) continue;
		const namespace = elementNamespace(
			node.element,
			parsed.scope(node.element),
		);
		const ledger = ledgerRole(node, namespace);
		if (node.parent === null && appended.has(node.name))
			refuseAtQuestion(
				node,
				node.name === "case" ? X.rootQuestionCase : X.rootQuestionUsercase,
			);
		else if (ledger !== undefined)
			refuseAtQuestion(node, X.ledgerBlock[ledger]);
		else if (
			node.name === "case" &&
			namespace === CASE_TRANSACTION_NS &&
			!inSaveToCaseRole(node)
		) {
			// Where the form builder's Save to Case role would mark it: the node holding the case
			// element alone, or the case element itself. The class is the case element's, which
			// the refusal's record stands at, under the key its own depth gives it.
			const parent = node.parent;
			const block =
				parent !== null && parent.children.length === 1 ? parent : node;
			if (!refused.has(block))
				refuseAtQuestion(
					block,
					node.parent === null
						? X.handWrittenCaseBlock.root
						: X.handWrittenCaseBlock.nested,
					undefined,
					node,
				);
		} else if (ignoredButRetained(node.element, parsed))
			refuseAtQuestion(node, X.ignoreRetain);
	}

	for (const node of order) {
		const siblings: readonly DataNode[] =
			node.parent === null ? top : node.parent.children;
		if (
			!refused.has(node) &&
			siblings.filter((sibling) => sibling.name === node.name).length > 1
		) {
			const detail = { name: node.name };
			cursor.refuseSubtree(
				node.element,
				X.siblingsOfOneName,
				formPlace,
				detail,
			);
			refuseUnder(node, { claim: X.siblingsOfOneName, detail });
		}
		const comment = attributeNameIn(node.element, parsed, VELLUM_NS, "comment");
		if (comment !== undefined)
			cursor.drop(
				{ element: node.element, attribute: comment },
				X.vellumComment,
			);
		const lock = attributeNameIn(node.element, parsed, VELLUM_NS, "lock");
		if (lock !== undefined)
			cursor.refuse(
				{ element: node.element, attribute: lock },
				X.vellumLock.node,
				formPlace,
			);
	}
	for (const node of top)
		if (node.name.toLowerCase() === "meta" && !refused.has(node)) {
			cursor.refuseSubtree(node.element, X.authoredMeta, formPlace);
			refuseUnder(node, { claim: X.authoredMeta });
		}
	for (const node of order) {
		const refusal = refused.get(node);
		if (refusal === undefined) continue;
		let block: DataNode | null = node.parent;
		while (block !== null && block.role !== "SaveToCase") block = block.parent;
		if (block === null || refused.has(block)) continue;
		cursor.refuseSubtree(
			block.element,
			refusal.claim,
			refusal.place ?? formPlace,
			refusal.detail,
		);
		refuseUnder(block, refusal);
	}
	return tree;
}

/** A bind's path: its `nodeset`, the one attribute Core reads a bind's node from
 *  (`XFormParser.processStandardBindAttributes`, which refuses a bind with none). A bind that
 *  names its node by `ref` alone is a form no device loads, so it has no path here and is left
 *  for the close to report. */
function bindPath(
	element: Element,
): { readonly attribute: "nodeset"; readonly text: string } | undefined {
	const nodeset = plainAttribute(element, "nodeset");
	return nodeset === undefined
		? undefined
		: { attribute: "nodeset", text: nodeset };
}

/** A bind whose path ends in an attribute of a node, for the reader that owns that node. */
export interface AttributeBind {
	readonly element: Element;
	readonly node: DataNode;
	readonly attribute: string;
	/** The attribute of the bind that holds its path. */
	readonly pathAttribute: "nodeset";
}

export interface ReadBinds {
	readonly byNode: ReadonlyMap<DataNode, BindFacts>;
	/** Binds on an attribute of a node, which the repeat and case readers decide. */
	readonly onAttributes: readonly AttributeBind[];
}

const LOGIC_ATTRIBUTES = [
	"relevant",
	"required",
	"constraint",
	"calculate",
	"readonly",
] as const;

/**
 * The binds, as `parseBindList` reads them. `ownsAttribute` says whether a node's attributes
 * are another reader's: a model-iteration wrapper or row, or a node of the case region.
 */
export function readBinds(
	parsed: ParsedXForm,
	tree: DataTree,
	cursor: XmlCursor,
	formPlace: HqPlace,
	ownsAttribute: (node: DataNode) => boolean,
): ReadBinds {
	const byNode = new Map<DataNode, BindFacts>();
	const onAttributes: AttributeBind[] = [];
	for (const element of parsed.binds) {
		const path = bindPath(element);
		if (path === undefined) continue;
		const read = readNodePath(path.text, tree, null);
		if (read.kind === "not-a-path") {
			// A bind a plugin writes into a block the tree refused names its node with
			// predicates, and stands under that refusal.
			const refusal = refusalBesidePredicates(path.text, tree);
			if (refusal !== undefined)
				cursor.refuseSubtree(
					element,
					refusal.claim,
					refusal.place ?? formPlace,
					refusal.detail,
				);
			continue;
		}
		// A bind on a node the data tree refused, or past one, stands under that refusal.
		const refusal = refusalOf(read, tree);
		if (refusal !== undefined) {
			cursor.refuseSubtree(
				element,
				refusal.claim,
				refusal.place ?? formPlace,
				refusal.detail,
			);
			continue;
		}
		if (read.kind === "none") {
			cursor.dropSubtree(element, X.bindNoNode);
			continue;
		}
		// Core applies a bind on the root, which no question holds. A bind on `/`, the literal path
		// or a relative `..` from the root, names no node and was dropped above: Core ignores it
		// (`XFormParser.verifyBindings`). One on a root attribute is any other attribute's.
		if (read.kind === "root") {
			cursor.refuseSubtree(
				element,
				read.attribute === undefined ? X.bindOnDataRoot : X.bindAttributePath,
				formPlace,
				{ name: path.text },
			);
			continue;
		}
		if (read.attribute !== undefined) {
			if (ownsAttribute(read.node))
				onAttributes.push({
					element,
					node: read.node,
					attribute: read.attribute,
					pathAttribute: path.attribute,
				});
			else
				cursor.refuseSubtree(element, X.bindAttributePath, formPlace, {
					name: path.text,
				});
			continue;
		}
		if (byNode.has(read.node)) continue;
		cursor.derived({ element }, X.bindElement.element);
		cursor.take({ element, attribute: path.attribute }, X.bind.nodeset).value;
		const preload = attributeNameIn(element, parsed, JAVAROSA_NS, "preload");
		if (preload !== undefined)
			cursor.drop({ element, attribute: preload }, X.bindPreload.preload);
		const preloadParams = attributeNameIn(
			element,
			parsed,
			JAVAROSA_NS,
			"preloadParams",
		);
		if (preloadParams !== undefined)
			cursor.drop(
				{ element, attribute: preloadParams },
				X.bindPreload.preloadParams,
			);
		const lock = attributeNameIn(element, parsed, VELLUM_NS, "lock");
		if (lock !== undefined)
			cursor.refuse({ element, attribute: lock }, X.vellumLock.bind, formPlace);
		const logic: Partial<Record<BindFactsLogicKey, string>> = {};
		for (const name of LOGIC_ATTRIBUTES) {
			const value = plainAttribute(element, name);
			if (value !== undefined) logic[name] = value;
		}
		const message = attributeNameIn(
			element,
			parsed,
			JAVAROSA_NS,
			"constraintMsg",
		);
		if (message !== undefined) logic.constraintMsg = element.attribs[message];
		byNode.set(read.node, {
			element,
			type: plainAttribute(element, "type"),
			logic,
		});
	}
	return { byNode, onAttributes };
}

type BindFactsLogicKey = keyof BindFacts["logic"];

/**
 * The attribute Core reads as an action's `local`: the first of that local name in any namespace
 * (`XFormParser.parseSetValueAction` asks kxml2's `Element.getAttributeValue(null, local)`, which
 * matches a name whatever its namespace), the form builder's `vellum:` shadows left out, since
 * CommCare HQ's build and Nova's local archive strip them before a device reads the form
 * (`strip_vellum_ns_attributes`, `xform/deviceForm.ts`).
 */
function coreActionAttribute(
	element: Element,
	scope: NamespaceScope,
	local: string,
): { readonly name: string; readonly value: string } | undefined {
	for (const [name, value] of Object.entries(element.attribs)) {
		if (name === "xmlns" || name.startsWith("xmlns:")) continue;
		const split = splitName(name);
		if (split.local !== local) continue;
		if (split.prefix !== "" && scope.get(split.prefix) === VELLUM_NS) continue;
		return { name, value };
	}
	return undefined;
}

/**
 * The `ref` of a setvalue spelled as Nova writes one, read as Core reads it, or undefined where
 * it is spelled otherwise. Core sets the node a `bind` attribute's bind names in preference to
 * `ref`, resolves a relative `ref` from the document's root `/` (not from the data root, as the
 * form builder reads a bind's path), and, where there is no `value` attribute, sets the element's
 * text as a literal (`XFormParser.parseSetValueAction`, over `getAbsRef(…,
 * TreeReference.rootRef())`). Nova writes a setvalue with no `bind`, an absolute `ref`, a `value`
 * and no content (`xform/builder.ts`, `xform/caseOps.ts`), so only a setvalue whose attributes Core
 * reads are exactly those, with nothing inside it, names a node here: any other is no default and
 * no setvalue of Nova's own, and its reader refuses it (`logic.ts::readDefaults`).
 */
export function heldSetvalueRef(
	element: Element,
	scope: NamespaceScope,
): string | undefined {
	if (coreActionAttribute(element, scope, "bind") !== undefined)
		return undefined;
	const ref = coreActionAttribute(element, scope, "ref");
	const value = coreActionAttribute(element, scope, "value");
	const event = coreActionAttribute(element, scope, "event");
	if (ref?.name !== "ref" || value?.name !== "value") return undefined;
	if (event !== undefined && event.name !== "event") return undefined;
	for (const child of element.children)
		if (child.type !== "text" || !isXmlWhitespace(child.data)) return undefined;
	return pathSteps(ref.value)?.[0] === "/" ? ref.value : undefined;
}

/** XML's whitespace, which Core's parser drops between elements (`getXMLDocument`). */
function isXmlWhitespace(text: string): boolean {
	for (const character of text)
		if (
			character !== " " &&
			character !== "\t" &&
			character !== "\n" &&
			character !== "\r"
		)
			return false;
	return true;
}

/** The model's `setvalue` children in document order. A setvalue names a target only where
 *  `heldSetvalueRef` reads it in Nova's spelling, and its absolute `ref` is then read as a
 *  bind's path is. */
export function readSetvalues(
	parsed: ParsedXForm,
	tree: DataTree,
): readonly SetvalueFacts[] {
	return parsed.setvalues.map((element) => {
		const plainRef = plainAttribute(element, "ref");
		const held = heldSetvalueRef(element, parsed.scope(element));
		// The data tree's refusal reaches a setvalue whose own `ref` names a node it refused, read
		// from the root as Core reads an absolute one; a relative `ref` names no node of the tree.
		const ref =
			plainRef !== undefined && pathSteps(plainRef, "pass")?.[0] === "/"
				? plainRef
				: undefined;
		const read = ref === undefined ? undefined : readNodePath(ref, tree, null);
		const heldRead = held === undefined ? undefined : read;
		return {
			element,
			event: plainAttribute(element, "event") ?? "",
			target:
				heldRead?.kind === "node"
					? [
							...heldRead.node.path,
							...(heldRead.attribute === undefined
								? []
								: [`@${heldRead.attribute}`]),
						]
					: undefined,
			value: plainAttribute(element, "value"),
			refusal:
				read === undefined || ref === undefined
					? undefined
					: read.kind === "not-a-path"
						? refusalBesidePredicates(ref, tree)
						: refusalOf(read, tree),
		};
	});
}

/**
 * Each secondary instance with its `src`. One with no `src` and inline content is refused
 * here; every other declaration is claimed by the expression stage once it knows what the
 * form's expressions read.
 */
export function readInstances(
	parsed: ParsedXForm,
	cursor: XmlCursor,
	formPlace: HqPlace,
): ReadonlyMap<string, string> {
	const sources = new Map<string, string>();
	for (const instance of parsed.instances) {
		if (instance.src === undefined) {
			if (instance.element.children.some(isTag))
				cursor.refuseSubtree(instance.element, X.inlineInstance, formPlace, {
					name: instance.id,
				});
			continue;
		}
		if (sources.has(instance.id)) continue;
		sources.set(instance.id, instance.src);
		cursor.derived({ element: instance.element }, X.frame.instance);
	}
	return sources;
}

/** The case transaction namespace, which a case block's `case` element is in. */
const CASE_TRANSACTION_NS = "http://commcarehq.org/case/transaction/v2";

/** The ledger namespace of CommCare's stock transactions. */
const LEDGER_NS = "http://commcarehq.org/ledger/v1";

/**
 * The role of a ledger block of the form builder's CommTrack plugin: the role the node names, or
 * the one the plugin gives a `balance` or `transfer` element in the ledger namespace
 * (`commtrack.js::parseDataElement`: a transfer with no `src` receives, one with no `dest`
 * dispenses).
 */
function ledgerRole(
	node: DataNode,
	namespace: string | null,
): "Balance" | "Transfer" | "Dispense" | "Receive" | undefined {
	if (
		node.role === "Balance" ||
		node.role === "Transfer" ||
		node.role === "Dispense" ||
		node.role === "Receive"
	)
		return node.role;
	if (namespace !== LEDGER_NS || node.role !== undefined) return undefined;
	const local = splitName(node.element.name).local;
	if (local === "balance") return "Balance";
	if (local !== "transfer") return undefined;
	if (plainAttribute(node.element, "src") === undefined) return "Receive";
	if (plainAttribute(node.element, "dest") === undefined) return "Dispense";
	return "Transfer";
}

/** Whether a node or a node above it carries the form builder's Save to Case role. */
function inSaveToCaseRole(node: DataNode): boolean {
	for (let at: DataNode | null = node; at !== null; at = at.parent)
		if (at.role === "SaveToCase") return true;
	return false;
}

/** Whether an element is marked `vellum:ignore="retain"`, content the form builder keeps as it
 *  stands and shows as its Ignored question (`ignoreButRetain.js`). */
function ignoredButRetained(element: Element, parsed: ParsedXForm): boolean {
	const value = namespacedAttribute(
		element,
		parsed.scope(element),
		VELLUM_NS,
		"ignore",
	);
	return value?.split(/\s+/).includes("retain") === true;
}
