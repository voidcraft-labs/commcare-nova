/**
 * A form's body as HQ's form builder reads it (Vellum `parser.js::parseControlTree`): the
 * controls, each finding its data node as `getPathFromControlElement` does, by its `ref`,
 * else its `nodeset`, else the bind its `bind` attribute names.
 */

import type { Element } from "domhandler";
import { isTag } from "domhandler";
import type { HqPlace } from "@/lib/publish/hqFindings";
import {
	elementNamespace,
	JAVAROSA_NS,
	splitName,
	XFORMS_NS,
} from "../../xmlNamespaces";
import type { Accounting } from "../accounting";
import type { XmlCursor } from "../xmlCursor";
import { X } from "./claims";
import type { BindFacts, DataNode, DataTree } from "./model";
import { readNodePath } from "./model";
import type { ParsedXForm } from "./parse";

export interface ControlNode {
	readonly element: Element;
	readonly tag:
		| "input"
		| "secret"
		| "select"
		| "select1"
		| "trigger"
		| "upload"
		| "group"
		| "repeat";
	/** The data node it names; undefined where its path names none. */
	readonly node: DataNode | undefined;
	readonly parent: ControlNode | null;
	readonly children: readonly ControlNode[];
	/** `appearance` and, on an upload, `mediatype`, each as written. */
	readonly appearance: string | undefined;
	readonly mediaType: string | undefined;
	/** The attribute that named its node: `ref`, `nodeset` or `bind`. */
	readonly path: "ref" | "nodeset" | "bind" | undefined;
}

export interface ReadControls {
	/** The body's top-level controls, in body order. */
	readonly roots: readonly ControlNode[];
	/** Every control in body order. */
	readonly all: readonly ControlNode[];
	/** The one control of each data node. */
	readonly byNode: ReadonlyMap<DataNode, ControlNode>;
}

const CONTROL_TAGS = new Set<ControlNode["tag"]>([
	"input",
	"secret",
	"select",
	"select1",
	"trigger",
	"upload",
	"group",
]);

const BIND_ID_SITES = {
	input: "input",
	secret: "secret",
	select: "select",
	select1: "select1",
	trigger: "trigger",
	upload: "upload",
	group: "group",
	repeat: "repeat",
} as const;

function plain(element: Element, name: string): string | undefined {
	return Object.hasOwn(element.attribs, name)
		? element.attribs[name]
		: undefined;
}

/** Whether a group's appearance is `field-list` in any letter case, which the runtimes read as a
 *  Question List. */
export function isFieldListAppearance(appearance: string | undefined): boolean {
	return appearance?.toLowerCase() === "field-list";
}

export interface ReadControlsInput {
	readonly parsed: ParsedXForm;
	readonly tree: DataTree;
	readonly binds: ReadonlyMap<DataNode, BindFacts>;
	readonly cursor: XmlCursor;
	readonly accounting: Accounting;
	readonly formPlace: HqPlace;
}

/** Walks `h:body`, claiming what no question reads: an element that is no control, a repeat
 *  with no group around it, an input marked read-only, a trigger that names no node, a control
 *  whose path names no node, and a control found through a bind's `id`. */
export function readControls(input: ReadControlsInput): ReadControls {
	const { parsed, tree, cursor, formPlace } = input;
	const all: ControlNode[] = [];
	const byNode = new Map<DataNode, ControlNode>();
	const bindNodes = new Map<string, { node: DataNode; bind: Element }>();
	for (const [node, facts] of input.binds) {
		const id = plain(facts.element, "id");
		if (id !== undefined && !bindNodes.has(id))
			bindNodes.set(id, { node, bind: facts.element });
	}

	const nodePath = (node: DataNode, base: DataNode | null): string[] => {
		if (base === null) return [...node.path];
		const rest = node.path.slice(base.path.length);
		return base.path.every((name, i) => node.path[i] === name) ? rest : [];
	};

	const resolve = (
		element: Element,
		tag: ControlNode["tag"],
		base: DataNode | null,
	): { node: DataNode | undefined; path: ControlNode["path"] } | "refused" => {
		const ref = plain(element, "ref") ?? plain(element, "nodeset");
		const attribute: ControlNode["path"] =
			plain(element, "ref") !== undefined
				? "ref"
				: plain(element, "nodeset") !== undefined
					? "nodeset"
					: undefined;
		if (ref !== undefined) {
			const read = readNodePath(ref, tree, base, input.accounting);
			if (read.kind !== "node" || read.attribute !== undefined) {
				cursor.refuseSubtree(element, X.controlNoNode, formPlace, {
					name: ref,
				});
				return "refused";
			}
			return { node: read.node, path: attribute };
		}
		const bindId = plain(element, "bind");
		if (bindId === undefined) return { node: undefined, path: undefined };
		const named = bindNodes.get(bindId);
		if (named === undefined) {
			cursor.refuseSubtree(element, X.controlNoNode, formPlace, {
				name: bindId,
			});
			return "refused";
		}
		const site = BIND_ID_SITES[tag];
		const isPath =
			bindId === [tree.root.name, ...named.node.path].join("/") ||
			bindId === `/${[tree.root.name, ...named.node.path].join("/")}` ||
			bindId === named.node.path.join("/") ||
			(base !== null && bindId === nodePath(named.node, base).join("/"));
		if (isPath) {
			cursor.take({ element: named.bind, attribute: "id" }, X.bindIdPath.id)
				.value;
			cursor.take({ element, attribute: "bind" }, X.bindIdPath[site]).value;
		} else {
			cursor.refuse(
				{ element: named.bind, attribute: "id" },
				X.bindIdOther.id,
				formPlace,
			);
			cursor.refuse(
				{ element, attribute: "bind" },
				X.bindIdOther[site],
				formPlace,
			);
		}
		return { node: named.node, path: "bind" };
	};

	const walk = (
		container: Element,
		parent: ControlNode | null,
		base: DataNode | null,
	): ControlNode[] => {
		const made: ControlNode[] = [];
		for (const element of container.children.filter(isTag)) {
			const scope = parsed.scope(element);
			const namespace = elementNamespace(element, scope);
			const local = splitName(element.name).local;
			if (parent !== null && namespace === XFORMS_NS && local === "label")
				continue;
			if (parent?.tag === "repeat" && namespace === JAVAROSA_NS) continue;
			const isRepeat = namespace === XFORMS_NS && local === "repeat";
			const tag =
				namespace === XFORMS_NS &&
				(CONTROL_TAGS.has(local as ControlNode["tag"]) || isRepeat)
					? (local as ControlNode["tag"])
					: undefined;
			if (tag === undefined) {
				cursor.refuseSubtree(element, X.unknownControl, formPlace, {
					name: local,
				});
				continue;
			}
			if (isRepeat) {
				const repeats =
					parent === null
						? []
						: parent.element.children
								.filter(isTag)
								.filter(
									(child) =>
										elementNamespace(child, parsed.scope(child)) ===
											XFORMS_NS && splitName(child.name).local === "repeat",
								);
				if (
					parent === null ||
					parent.tag !== "group" ||
					isFieldListAppearance(parent.appearance) ||
					repeats.length !== 1
				) {
					cursor.refuseSubtree(element, X.bareRepeat, formPlace);
					continue;
				}
			}
			if (tag === "input" && plain(element, "readonly")?.trim() === "true()") {
				cursor.refuseSubtree(element, X.readonlyInput, formPlace);
				continue;
			}
			if (
				tag === "trigger" &&
				plain(element, "ref") === undefined &&
				plain(element, "nodeset") === undefined &&
				plain(element, "bind") === undefined
			) {
				cursor.refuseSubtree(element, X.reflessTrigger, formPlace);
				continue;
			}
			const resolved = resolve(element, tag, base);
			if (resolved === "refused") continue;
			let node = resolved.node;
			const refused = node === undefined ? undefined : tree.refused.get(node);
			if (refused !== undefined) {
				cursor.refuseSubtree(element, refused, formPlace);
				continue;
			}
			if (node !== undefined && byNode.has(node)) node = undefined;
			const kids: ControlNode[] = [];
			const control: ControlNode = {
				element,
				tag,
				node,
				parent,
				children: kids,
				appearance: plain(element, "appearance"),
				mediaType: plain(element, "mediatype"),
				path: resolved.path,
			};
			all.push(control);
			if (node !== undefined) byNode.set(node, control);
			made.push(control);
			if (tag === "group" || tag === "repeat")
				kids.push(...walk(element, control, node ?? base));
		}
		return made;
	};
	const roots = walk(parsed.body, null, null);
	return { roots, all, byNode };
}
