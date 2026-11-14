/**
 * A form's model as HQ's form builder reads it (Vellum `parser.js`): the data
 * tree, the binds, the model's setvalues and the secondary instances. Paths
 * are read with the XPath grammar (`xpath/formSyntax.ts`), never by pattern.
 */

import type { Element } from "domhandler";
import { isTag } from "domhandler";
import type { HqPlace } from "@/lib/publish/hqFindings";
import { FormPath } from "../../xform/formPath";
import {
	JAVAROSA_NS,
	namespacedAttribute,
	splitName,
	VELLUM_NS,
} from "../../xmlNamespaces";
import type { FormSyntax } from "../../xpath/formSyntax";
import type { Claim } from "../claims";
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
	} catch {
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
	/** The path `ref` names, an attribute as a last step `@name`; undefined where it names none. */
	readonly target: readonly string[] | undefined;
	readonly value: string | undefined;
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
	 *  `meta` block), with everything under it, to the refusal's claim. */
	readonly refused: ReadonlyMap<DataNode, Claim<"refuse">>;
}

/** What a path names in the data tree. */
export type NodePathRead =
	| {
			readonly kind: "node";
			readonly node: DataNode;
			/** An attribute's name where the path's last step is one. */
			readonly attribute?: string;
	  }
	/** A chain of steps that names no node of the tree. */
	| { readonly kind: "none" }
	/** Not a chain of child steps with at most one final attribute step. */
	| { readonly kind: "not-a-path" };

/** The text's steps, `/` first for an absolute path; undefined where the text is no chain of
 *  name steps, `.` and `..`, with at most one final attribute step. */
export function pathSteps(text: string): readonly string[] | undefined {
	const read = readFormSyntax(text);
	if (!read.ok || read.node === undefined) return undefined;
	const steps: string[] = [];
	const walk = (node: FormSyntax): boolean => {
		switch (node.kind) {
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

/**
 * What a path names, read as Vellum's `processPath` reads a bind's: an absolute path from the
 * form's root, whose first step must be the data root's name, or a relative path from `base`
 * (the data root where `base` is null).
 */
export function readNodePath(
	text: string,
	tree: DataTree,
	base: DataNode | null,
): NodePathRead {
	const steps = pathSteps(text);
	if (steps === undefined) return { kind: "not-a-path" };
	let at: DataNode | null = base;
	let rest = steps;
	if (steps[0] === "/") {
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
			if (at === null) return { kind: "none" };
			at = at.parent;
			continue;
		}
		const children: readonly DataNode[] = at === null ? tree.top : at.children;
		const next = children.find((child) => child.name === step);
		if (next === undefined) return { kind: "none" };
		at = next;
	}
	if (at === null) return { kind: "none" };
	return attribute === undefined
		? { kind: "node", node: at }
		: { kind: "node", node: at, attribute };
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
 * `vellum:comment`, a `vellum:lock`.
 */
export function readDataTree(
	parsed: ParsedXForm,
	cursor: XmlCursor,
	formPlace: HqPlace,
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
	const refused = new Map<DataNode, Claim<"refuse">>();
	const tree: DataTree = { root: parsed.dataRoot, nodes, order, top, refused };
	const refuseUnder = (node: DataNode, claim: Claim<"refuse">) => {
		refused.set(node, claim);
		for (const child of node.children) refuseUnder(child, claim);
	};

	for (const node of order) {
		const siblings: readonly DataNode[] =
			node.parent === null ? top : node.parent.children;
		if (
			!refused.has(node) &&
			siblings.filter((sibling) => sibling.name === node.name).length > 1
		) {
			cursor.refuseSubtree(node.element, X.siblingsOfOneName, formPlace, {
				name: node.name,
			});
			refuseUnder(node, X.siblingsOfOneName);
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
			refuseUnder(node, X.authoredMeta);
		}
	return tree;
}

/** A bind's path: its `nodeset`, else its `ref`, with the attribute's name as written. */
function bindPath(
	element: Element,
):
	| { readonly attribute: "nodeset" | "ref"; readonly text: string }
	| undefined {
	const nodeset = plainAttribute(element, "nodeset");
	if (nodeset !== undefined) return { attribute: "nodeset", text: nodeset };
	const ref = plainAttribute(element, "ref");
	return ref === undefined ? undefined : { attribute: "ref", text: ref };
}

/** A bind whose path ends in an attribute of a node, for the reader that owns that node. */
export interface AttributeBind {
	readonly element: Element;
	readonly node: DataNode;
	readonly attribute: string;
	/** The attribute of the bind that holds its path. */
	readonly pathAttribute: "nodeset" | "ref";
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
		if (read.kind === "not-a-path") continue;
		if (read.kind === "none") {
			cursor.dropSubtree(element, X.bindNoNode);
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

/** The model's `setvalue` children in document order, each `ref` read as a bind's path is. */
export function readSetvalues(
	parsed: ParsedXForm,
	tree: DataTree,
): readonly SetvalueFacts[] {
	return parsed.setvalues.map((element) => {
		const ref = plainAttribute(element, "ref");
		const read = ref === undefined ? undefined : readNodePath(ref, tree, null);
		return {
			element,
			event: plainAttribute(element, "event") ?? "",
			target:
				read?.kind === "node"
					? [
							...read.node.path,
							...(read.attribute === undefined ? [] : [`@${read.attribute}`]),
						]
					: undefined,
			value: plainAttribute(element, "value"),
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
		if (!sources.has(instance.id)) sources.set(instance.id, instance.src);
	}
	return sources;
}
