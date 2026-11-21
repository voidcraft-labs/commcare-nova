/**
 * A form's body, read as HQ's form builder reads its controls (Vellum
 * `parser.js::parseControlTree`), each control finding its data node as Core finds it
 * (`coreControlPath`): by the bind its `bind` attribute names, else a repeat by its `nodeset` and
 * any other control by its `ref`.
 */

import type { Element } from "domhandler";
import { isTag } from "domhandler";
import type { FindingDetail, HqPlace } from "@/lib/publish/hqFindings";
import {
	elementNamespace,
	JAVAROSA_NS,
	splitName,
	XFORMS_NS,
} from "../../xmlNamespaces";
import type { Accounting } from "../accounting";
import type { Claim } from "../claims";
import type { XmlCursor } from "../xmlCursor";
import { X } from "./claims";
import type { BindFacts, DataNode, DataTree } from "./model";
import { readNodePath, refusalOf } from "./model";
import type { ParsedXForm } from "./parse";
import type { StandingRefusal } from "./refusals";

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
	/** The data node each control refused whole names (an unknown control, a repeat with no
	 *  group around it, a read-only input), with that refusal: the node, what it holds, its bind
	 *  and its setvalues belong to the refused control and stand under the same finding. */
	readonly refusedNodes: ReadonlyMap<DataNode, StandingRefusal>;
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

/**
 * The attribute Core binds a control to its node by, and its text: `bind` wherever the control
 * holds one, else a repeat's `nodeset` and any other control's `ref`
 * (`XFormParser.parseControl` and `parseGroup`, which read `bind` first, a repeat's `nodeset`
 * alone and a group's or a question's `ref` alone). A group that holds only `nodeset` is a group
 * with no node of its own, bound to its parent's; a repeat that holds only `ref`, and a question
 * that holds only `nodeset`, have none, and Core refuses to load either. Undefined where the
 * control names no node, which the attribute it holds instead, if any, is left for the close to
 * report.
 */
export function coreControlPath(
	element: Element,
	local: string,
):
	| { readonly attribute: "bind" | "ref" | "nodeset"; readonly text: string }
	| undefined {
	const bind = plain(element, "bind");
	if (bind !== undefined) return { attribute: "bind", text: bind };
	const attribute = local === "repeat" ? "nodeset" : "ref";
	const text = plain(element, attribute);
	return text === undefined ? undefined : { attribute, text };
}

/** Whether a group's appearance is `field-list` in any letter case, which the runtimes read as a
 *  Question List. */
export function isFieldListAppearance(appearance: string | undefined): boolean {
	return appearance?.toLowerCase() === "field-list";
}

/** The element names Core's parser makes a child of a group from (`XFormParser`'s
 *  `groupLevelHandlers` less `label`), matched by local name whatever the namespace, as
 *  `parseElement` matches them. */
const GROUP_CHILD_NAMES = new Set([...CONTROL_TAGS, "repeat"]);

/** Whether a group element's one child control is a `repeat`: the group Core collapses into the
 *  repeat it wraps (`XFormParser.collapseRepeatGroups`, `group.getChildren().size() == 1`). A
 *  group holding a repeat and anything else Core keeps as a group, with the repeat inside it. */
function holdsOnlyARepeat(group: Element): boolean {
	const children = group.children
		.filter(isTag)
		.filter((child) => GROUP_CHILD_NAMES.has(splitName(child.name).local));
	return (
		children.length === 1 &&
		splitName((children[0] as Element).name).local === "repeat"
	);
}

/**
 * Whether a group control is a repeat's wrapper: no Question List, and its one child control the
 * repeat. Every repeat the body admits has such a parent (`readControls`). The repeat's field is
 * made from its own node, or from a query repeat's wrapper node; this group gives it only its
 * label and appearance, and makes no field of its own.
 */
export function wrapsRepeat(control: ControlNode): boolean {
	return (
		control.tag === "group" &&
		!isFieldListAppearance(control.appearance) &&
		control.children.length === 1 &&
		control.children[0]?.tag === "repeat"
	);
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
	const refusedNodes = new Map<DataNode, StandingRefusal>();
	/** Refuses a control whole, and the data node its `ref` or `nodeset` names, where it names
	 *  one no other refusal of the data tree covers. */
	const refuseControl = (
		element: Element,
		base: DataNode | null,
		claim: Claim<"refuse">,
		detail?: FindingDetail,
	) => {
		cursor.refuseSubtree(element, claim, formPlace, detail);
		const path = coreControlPath(element, splitName(element.name).local);
		if (path === undefined || path.attribute === "bind") return;
		const ref = path.text;
		const read = readNodePath(ref, tree, base);
		if (
			read.kind !== "node" ||
			read.attribute !== undefined ||
			refusalOf(read, tree) !== undefined ||
			refusedNodes.has(read.node)
		)
			return;
		refusedNodes.set(
			read.node,
			detail === undefined
				? { claim, place: formPlace }
				: { claim, place: formPlace, detail },
		);
	};
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
		const path = coreControlPath(element, tag);
		if (path === undefined) return { node: undefined, path: undefined };
		if (path.attribute !== "bind") {
			const ref = path.text;
			const read = readNodePath(ref, tree, base);
			// A control on a node the data tree refused, or past one, stands under that refusal.
			const refusal = refusalOf(read, tree);
			if (refusal !== undefined) {
				cursor.refuseSubtree(
					element,
					refusal.claim,
					refusal.place ?? formPlace,
					refusal.detail,
				);
				return "refused";
			}
			if (read.kind !== "node" || read.attribute !== undefined) {
				cursor.refuseSubtree(element, X.controlNoNode, formPlace, {
					name: ref,
				});
				return "refused";
			}
			return { node: read.node, path: path.attribute };
		}
		const bindId = path.text;
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
			// An action nested in a group or a repeat, as in any other control.
			const action =
				parent === null
					? undefined
					: local === "pollsensor"
						? "pollsensor"
						: namespace === XFORMS_NS &&
								(local === "setvalue" || local === "send")
							? local
							: undefined;
			if (action !== undefined) {
				cursor.refuseSubtree(element, X.actionInControl[action], formPlace);
				continue;
			}
			if (tag === undefined) {
				refuseControl(element, base, X.unknownControl, { name: local });
				continue;
			}
			if (isRepeat) {
				// A repeat is held only inside the group Core collapses into it: one that holds no
				// other control. Beside another control the group stays a group in Core, so its label
				// is no repeat's, and the repeat has no wrapper.
				if (
					parent === null ||
					parent.tag !== "group" ||
					isFieldListAppearance(parent.appearance) ||
					!holdsOnlyARepeat(parent.element)
				) {
					refuseControl(element, base, X.bareRepeat);
					continue;
				}
			}
			if (tag === "input" && plain(element, "readonly")?.trim() === "true()") {
				refuseControl(element, base, X.readonlyInput);
				continue;
			}
			if (tag === "trigger" && coreControlPath(element, tag) === undefined) {
				cursor.refuseSubtree(element, X.reflessTrigger, formPlace);
				continue;
			}
			const resolved = resolve(element, tag, base);
			if (resolved === "refused") continue;
			let node = resolved.node;
			const refused = node === undefined ? undefined : tree.refused.get(node);
			if (refused !== undefined) {
				cursor.refuseSubtree(
					element,
					refused.claim,
					refused.place ?? formPlace,
					refused.detail,
				);
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
	return { roots, all, byNode, refusedNodes };
}
