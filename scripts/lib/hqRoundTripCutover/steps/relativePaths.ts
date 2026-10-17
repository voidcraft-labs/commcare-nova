/**
 * The relative-path rewrite the three id steps share (`question-ids`,
 * `case-operation-ids`, `connect-ids`), and the raw-row readers every step
 * that reads a stored expression uses.
 *
 * A reference leaf of a stored expression names its field by uuid and prints
 * its current name, so a rename reaches it by construction. A path written
 * as text does not: `../_notes` in a calculate spells the old id. Before a
 * step writes its new ids, it hands this module the nodes it renames, and
 * the module reads every XPath slot of the form from the raw rows (the
 * registry's `xpath-ast` entries of `FIELD_REFERENCE_SLOTS` and
 * `FORM_REFERENCE_SLOTS`, read as data), prints each with the names the rows
 * hold now through `projectXPath` and a print context built over the rows,
 * one part at a time so each part's place in the text is known, and parses
 * the text with Nova's XPath grammar. Each path is followed step by step
 * through the form's tree from where its slot is evaluated: a path relative
 * to the slot's own node, one `current()` starts, and one rooted at the
 * form's `/data`. A name step that lands on a renamed node has its
 * characters rewritten inside its text part; a path `instance()` starts is
 * another document and is left alone. Where a root field and a Connect
 * block's wrapper share a name, the step after decides which one a step
 * lands on (`siblingOf`). A name step that equals an old name and does not
 * land on one node this way is left as it is and returned, for the blocker
 * `unresolved-relative-path`: which node it meant is a person's call.
 *
 * Nothing here hands a function of the tree a document: the parser,
 * `projectXPath` (with this module's own print context) and
 * `hasExplicitPathContext` are each handed text, a syntax node or a stored
 * expression alone.
 */

import type { SyntaxNode } from "@lezer/common";
import { parser } from "@/lib/commcare/xpath";
import { hasExplicitPathContext } from "@/lib/commcare/xpath/expressionAst";
import {
	FIELD_REFERENCE_SLOTS,
	FORM_REFERENCE_SLOTS,
	readSlotValues,
} from "@/lib/domain/referenceSlots";
import type { XPathExpression } from "@/lib/domain/xpath/ast";
import { projectXPath, type XPathPrintContext } from "@/lib/domain/xpath/print";
import type { Json, JsonRecord, RawDocument } from "../oldShape";

export function isRecord(value: Json | undefined): value is JsonRecord {
	return (
		value !== null &&
		value !== undefined &&
		typeof value === "object" &&
		!Array.isArray(value)
	);
}

/** A stored string, or `""` where the slot holds none. */
export function rawText(value: Json | undefined): string {
	return typeof value === "string" ? value : "";
}

/**
 * The names a form's data root holds as stored: its root fields' ids and
 * its Connect blocks' ids, whose wrappers sit beside the root fields. Each id
 * step counts both as taken at the root, so a rename can't land a field and
 * a block on one name.
 */
export function rawRootNames(
	document: RawDocument,
	formUuid: string,
): { readonly fieldIds: Set<string>; readonly connectIds: Set<string> } {
	const fieldIds = new Set(
		(document.fieldOrder[formUuid] ?? []).flatMap((uuid) => {
			const field = document.fields[uuid];
			return field === undefined ? [] : [rawText(field.id)];
		}),
	);
	const connectIds = new Set<string>();
	const connect = document.forms[formUuid]?.connect;
	if (isRecord(connect)) {
		for (const kind of Object.keys(CONNECT_BLOCK_NODES)) {
			const block = connect[kind];
			if (isRecord(block) && typeof block.id === "string")
				connectIds.add(block.id);
		}
	}
	return { fieldIds, connectIds };
}

/** Every field under a parent, in document order, containers' children included. */
export function fieldUuidsUnder(
	document: RawDocument,
	parent: string,
): string[] {
	return (document.fieldOrder[parent] ?? []).flatMap((uuid) =>
		document.fields[uuid] === undefined
			? []
			: [uuid, ...fieldUuidsUnder(document, uuid)],
	);
}

/** The form a field sits in, by its rows' parent chain. */
export function formOfField(
	document: RawDocument,
	fieldUuid: string,
): string | undefined {
	const parents = new Map<string, string>();
	for (const [parent, children] of Object.entries(document.fieldOrder)) {
		for (const child of children) parents.set(child, parent);
	}
	let cursor = parents.get(fieldUuid);
	const seen = new Set<string>();
	while (cursor !== undefined && !seen.has(cursor)) {
		if (document.forms[cursor] !== undefined) return cursor;
		seen.add(cursor);
		cursor = parents.get(cursor);
	}
	return undefined;
}

/**
 * The print context over the raw rows: a field's path is its ids from its
 * form down, a worker property's name its stored slug, a search input's
 * name the one its menu stores.
 */
export function rawPrintContext(document: RawDocument): XPathPrintContext {
	const parents = new Map<string, string>();
	for (const [parent, children] of Object.entries(document.fieldOrder)) {
		for (const child of children) parents.set(child, parent);
	}
	return {
		fieldPathSegments(uuid) {
			const segments: string[] = [];
			let cursor: string | undefined = uuid;
			const seen = new Set<string>();
			while (cursor !== undefined && !seen.has(cursor)) {
				const field = document.fields[cursor];
				if (field === undefined) return undefined;
				seen.add(cursor);
				segments.unshift(rawText(field.id));
				const parent = parents.get(cursor);
				if (parent !== undefined && document.forms[parent] !== undefined) {
					return segments;
				}
				cursor = parent;
			}
			return undefined;
		},
		userPropertySlug(uuid) {
			const slug = document.userProperties[uuid]?.slug;
			return typeof slug === "string" ? slug : undefined;
		},
		searchInputName(uuid) {
			for (const module of Object.values(document.modules)) {
				const config = module.caseListConfig;
				if (!isRecord(config) || !Array.isArray(config.searchInputs)) continue;
				for (const input of config.searchInputs) {
					if (isRecord(input) && input.uuid === uuid) {
						return rawText(input.name);
					}
				}
			}
			return undefined;
		},
	};
}

/** One part of a printed expression: its place in the text, and its kind. */
export interface PrintedPart {
	readonly from: number;
	readonly to: number;
	/** The stored part, written in place when its text is rewritten. */
	readonly part: JsonRecord;
	readonly isText: boolean;
}

/** An expression printed part by part, so each part's place is known. */
export interface PrintedExpression {
	readonly text: string;
	readonly parts: readonly PrintedPart[];
}

/** Whether a stored value is an expression's parts list. */
function storedParts(value: unknown): readonly JsonRecord[] | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const parts = (value as JsonRecord).parts;
	return Array.isArray(parts) && parts.every((part) => isRecord(part))
		? (parts as JsonRecord[])
		: undefined;
}

/** Print a stored expression one part at a time. */
export function printExpression(
	value: unknown,
	context: XPathPrintContext,
): PrintedExpression | undefined {
	const stored = storedParts(value);
	if (stored === undefined) return undefined;
	let text = "";
	const parts: PrintedPart[] = [];
	for (const part of stored) {
		const printed = projectXPath(
			{ parts: [part] } as unknown as XPathExpression,
			context,
		).text;
		parts.push({
			from: text.length,
			to: text.length + printed.length,
			part,
			isText: part.kind === "text",
		});
		text += printed;
	}
	return { text, parts };
}

/** One replacement of a span of a printed expression's text. */
export interface TextEdit {
	readonly from: number;
	readonly to: number;
	readonly text: string;
}

/**
 * Apply edits to the text parts that hold them, every other character kept.
 * Each edit lies inside one text part; one that does not is refused, since a
 * reference leaf is never rewritten.
 */
export function applyTextEdits(
	printed: PrintedExpression,
	edits: readonly TextEdit[],
): void {
	const sorted = [...edits].sort((a, b) => b.from - a.from);
	for (const edit of sorted) {
		const holder = printed.parts.find(
			(part) => part.isText && part.from <= edit.from && edit.to <= part.to,
		);
		if (holder === undefined) {
			throw new Error(
				`An edit at ${edit.from} to ${edit.to} of "${printed.text}" does not lie inside one text part, so the cutover cannot make it without touching a reference.`,
			);
		}
		const current = rawText(holder.part.text);
		const start = edit.from - holder.from;
		const end = edit.to - holder.from;
		(holder.part as { text: string }).text =
			`${current.slice(0, start)}${edit.text}${current.slice(end)}`;
	}
}

/** Where a slot of a form sits, for a blocker's detail and a notice line. */
export type SlotCarrier =
	| { readonly kind: "field"; readonly fieldUuid: string }
	| { readonly kind: "form" };

/** One stored XPath expression of a form, by the registry's slots. */
export interface FormXPathSlot {
	readonly carrier: SlotCarrier;
	readonly slot: string;
	readonly value: unknown;
}

const FIELD_XPATH_SLOTS = FIELD_REFERENCE_SLOTS.filter(
	(slot) => slot.kind === "xpath-ast",
);
const FORM_XPATH_SLOTS = FORM_REFERENCE_SLOTS.filter(
	(slot) => slot.kind === "xpath-ast",
);

/** Every XPath slot a form stores: its fields', in document order, then its own. */
export function formXPathSlots(
	document: RawDocument,
	formUuid: string,
): FormXPathSlot[] {
	const slots: FormXPathSlot[] = [];
	for (const fieldUuid of fieldUuidsUnder(document, formUuid)) {
		const field = document.fields[fieldUuid];
		if (field === undefined) continue;
		const kind = rawText(field.kind);
		for (const slot of FIELD_XPATH_SLOTS) {
			if (!(slot.appliesTo as readonly string[]).includes(kind)) continue;
			for (const entry of readSlotValues(field, slot.path)) {
				slots.push({
					carrier: { kind: "field", fieldUuid },
					slot: slot.slot,
					value: entry.value,
				});
			}
		}
	}
	const form = document.forms[formUuid];
	for (const slot of FORM_XPATH_SLOTS) {
		for (const entry of readSlotValues(form, slot.path)) {
			slots.push({
				carrier: { kind: "form" },
				slot: slot.slot,
				value: entry.value,
			});
		}
	}
	return slots;
}

// ── The form's tree ─────────────────────────────────────────────────

interface TreeNode {
	readonly key: string;
	readonly name: string;
	readonly parent: TreeNode | null;
	/** By name; a stored document can hold two siblings of one name, a root
	 * field named like one of its form's Connect blocks. */
	readonly children: Map<string, TreeNode[]>;
	/** A node whose children the tree does not hold: a question, a Connect leaf. */
	readonly opaque: boolean;
}

function node(
	key: string,
	name: string,
	parent: TreeNode | null,
	opaque: boolean,
): TreeNode {
	const made: TreeNode = { key, name, parent, children: new Map(), opaque };
	parent?.children.set(name, [...(parent.children.get(name) ?? []), made]);
	return made;
}

export function fieldNodeKey(uuid: string): string {
	return `field:${uuid}`;
}

export function connectNodeKey(kind: string): string {
	return `connect:${kind}`;
}

export function operationNodeKey(uuid: string): string {
	return `operation:${uuid}`;
}

/** The child element each Connect block's wrapper holds, and that element's leaves. */
const CONNECT_BLOCK_NODES: Readonly<
	Record<string, { element: string; leaves: readonly string[] }>
> = {
	learn_module: {
		element: "module",
		leaves: ["name", "description", "time_estimate"],
	},
	assessment: { element: "assessment", leaves: ["user_score"] },
	deliver_unit: {
		element: "deliver",
		leaves: ["name", "entity_id", "entity_name", "work_area_id"],
	},
	task: { element: "task", leaves: ["name", "description"] },
};

/** Each form-level slot's node, under its Connect block. */
const CONNECT_SLOT_NODES: Readonly<
	Record<string, { block: string; leaf: string }>
> = {
	assessment_user_score: { block: "assessment", leaf: "user_score" },
	deliver_entity_id: { block: "deliver_unit", leaf: "entity_id" },
	deliver_entity_name: { block: "deliver_unit", leaf: "entity_name" },
};

interface FormTree {
	/** Above `/data`: an absolute path's first step names the form's root. */
	readonly document: TreeNode;
	readonly root: TreeNode;
	readonly byKey: ReadonlyMap<string, TreeNode>;
}

/**
 * The form's data tree with the names its rows hold now: its fields (a
 * query-bound repeat holds its children under `item`) and its Connect
 * blocks' wrappers at the root.
 */
function formTree(document: RawDocument, formUuid: string): FormTree {
	const byKey = new Map<string, TreeNode>();
	const top = node("document", "", null, false);
	const root = node(`form:${formUuid}`, "data", top, false);
	const walk = (parentUuid: string, parent: TreeNode): void => {
		for (const uuid of document.fieldOrder[parentUuid] ?? []) {
			const field = document.fields[uuid];
			if (field === undefined) continue;
			const kind = rawText(field.kind);
			const container =
				kind === "group" || kind === "repeat" || kind === "section";
			const made = node(
				fieldNodeKey(uuid),
				rawText(field.id),
				parent,
				!container,
			);
			byKey.set(made.key, made);
			if (!container) continue;
			const holder =
				kind === "repeat" && field.repeat_mode === "query_bound"
					? node(`item:${uuid}`, "item", made, false)
					: made;
			walk(uuid, holder);
		}
	};
	walk(formUuid, root);
	const connect = document.forms[formUuid]?.connect;
	if (isRecord(connect)) {
		for (const [kind, shape] of Object.entries(CONNECT_BLOCK_NODES)) {
			const block = connect[kind];
			if (!isRecord(block) || typeof block.id !== "string") continue;
			const wrapper = node(connectNodeKey(kind), block.id, root, false);
			byKey.set(wrapper.key, wrapper);
			const element = node(
				`${wrapper.key}:element`,
				shape.element,
				wrapper,
				false,
			);
			for (const leaf of shape.leaves) {
				byKey.set(
					`${wrapper.key}:${leaf}`,
					node(`${wrapper.key}:${leaf}`, leaf, element, true),
				);
			}
		}
	}
	return { document: top, root, byKey };
}

/**
 * The node a slot's relative paths start from: the field itself, a count or
 * an ids query beside its repeat, a Connect leaf, and none for a form link,
 * which is read after the form and not inside it.
 */
function slotContext(tree: FormTree, slot: FormXPathSlot): TreeNode | null {
	if (slot.carrier.kind === "field") {
		const own = tree.byKey.get(fieldNodeKey(slot.carrier.fieldUuid)) ?? null;
		if (slot.slot === "repeat_count" || slot.slot === "ids_query") {
			return own === null
				? null
				: {
						key: "beside",
						name: "",
						parent: own.parent,
						children: new Map(),
						opaque: true,
					};
		}
		return own;
	}
	const connect = CONNECT_SLOT_NODES[slot.slot];
	return connect === undefined
		? null
		: (tree.byKey.get(`${connectNodeKey(connect.block)}:${connect.leaf}`) ??
				null);
}

/**
 * The node a name step lands on among its same-named siblings, read from
 * the step after it: a step on to a child keeps the sibling holding that
 * child, and the path's last step reads a field, since a Connect block's
 * wrapper holds no value of its own. `undefined` when no single sibling
 * fits: which one the path meant is a person's call.
 */
function siblingOf(
	named: readonly TreeNode[],
	following: PathStep | undefined,
): TreeNode | undefined {
	if (named.length <= 1) return named[0];
	const fits =
		following === undefined
			? named.filter((candidate) => candidate.key.startsWith("field:"))
			: following.kind === "name"
				? named.filter((candidate) => candidate.children.has(following.name))
				: [];
	return fits.length === 1 ? fits[0] : undefined;
}

// ── Paths in the syntax tree ────────────────────────────────────────

type PathStart = "context" | "root" | "current" | "instance" | "other";

type PathStep =
	| { readonly kind: "name"; readonly node: SyntaxNode; readonly name: string }
	| { readonly kind: "parent" | "self" | "other"; readonly node: SyntaxNode };

interface PathChain {
	readonly start: PathStart;
	readonly steps: readonly PathStep[];
}

const STEP_NAMES: ReadonlySet<string> = new Set([
	"NameTest",
	"ParentStep",
	"SelfStep",
	"AttrSpecified",
	"AxisSpecified",
]);

function stepOf(step: SyntaxNode, text: string): PathStep {
	if (step.name === "NameTest" && step.firstChild === null) {
		return { kind: "name", node: step, name: text.slice(step.from, step.to) };
	}
	if (step.name === "ParentStep") return { kind: "parent", node: step };
	if (step.name === "SelfStep") return { kind: "self", node: step };
	return { kind: "other", node: step };
}

function functionName(invoke: SyntaxNode, text: string): string {
	const name = invoke.getChild("FunctionName");
	return name === null ? "" : text.slice(name.from, name.to);
}

/** A path's start and its steps, left to right. */
function chainOf(path: SyntaxNode, text: string): PathChain {
	if (path.name === "Child" || path.name === "Descendant") {
		const first = path.firstChild;
		const last = path.lastChild;
		if (first === null || last === null) return { start: "other", steps: [] };
		const below =
			first.name === "/" || first.name === "//"
				? { start: "root" as const, steps: [] }
				: chainOf(first, text);
		const descend: PathStep[] =
			path.name === "Descendant" ? [{ kind: "other", node: path }] : [];
		return {
			start: below.start,
			steps: [...below.steps, ...descend, stepOf(last, text)],
		};
	}
	if (path.name === "Filtered") {
		const first = path.firstChild;
		return first === null
			? { start: "other", steps: [] }
			: chainOf(first, text);
	}
	if (path.name === "RootPath") return { start: "root", steps: [] };
	if (path.name === "Invoke") {
		const name = functionName(path, text);
		return {
			start:
				name === "current"
					? "current"
					: name === "instance"
						? "instance"
						: "other",
			steps: [],
		};
	}
	if (STEP_NAMES.has(path.name)) {
		return { start: "context", steps: [stepOf(path, text)] };
	}
	return { start: "other", steps: [] };
}

const PATH_NAMES: ReadonlySet<string> = new Set([
	"Child",
	"Descendant",
	"Filtered",
	"RootPath",
	...STEP_NAMES,
]);

/** Whether a path node is the whole path, not a part of a longer one. */
function outermost(path: SyntaxNode): boolean {
	const parent = path.parent;
	if (parent === null) return true;
	if (parent.name === "Child" || parent.name === "Descendant") return false;
	if (parent.name === "AttrSpecified" || parent.name === "AxisSpecified") {
		return false;
	}
	return !(parent.name === "Filtered" && parent.firstChild?.from === path.from);
}

/**
 * The call that starts the path a name step sits in, where
 * `hasExplicitPathContext` answers that one does.
 */
function startingCall(step: SyntaxNode, text: string): string | undefined {
	for (let parent = step.parent; parent !== null; parent = parent.parent) {
		let leftmost: SyntaxNode | null = parent;
		while (
			leftmost !== null &&
			(leftmost.name === "Child" ||
				leftmost.name === "Descendant" ||
				leftmost.name === "Filtered")
		) {
			leftmost = leftmost.firstChild;
		}
		if (leftmost?.name === "Invoke") return functionName(leftmost, text);
	}
	return undefined;
}

// ── The rewrite ─────────────────────────────────────────────────────

/** One node a step renames, by the tree's key. */
export interface NodeRename {
	readonly key: string;
	readonly from: string;
	readonly to: string;
}

/** A name step that equals an old name and lands on no node. */
export interface UnresolvedName {
	readonly carrier: SlotCarrier;
	readonly slot: string;
	readonly name: string;
	readonly expression: string;
}

type Cursor =
	| { readonly kind: "node"; readonly node: TreeNode }
	/** Below a node whose children the tree does not hold. */
	| { readonly kind: "beyond" }
	/** Nowhere in the form's tree. */
	| { readonly kind: "lost" };

/**
 * Rewrite, in every XPath slot of one form, each path step written as text
 * that lands on a node `renames` names, and return each step equal to an old
 * name that lands on none. Call it before the renames are written: the paths
 * are printed and followed with the names the rows hold now.
 */
export function rewriteFormRelativePaths(
	document: RawDocument,
	formUuid: string,
	renames: readonly NodeRename[],
): UnresolvedName[] {
	if (renames.length === 0) return [];
	const renamed = new Map(renames.map((rename) => [rename.key, rename]));
	const oldNames = new Set(renames.map((rename) => rename.from));
	const tree = formTree(document, formUuid);
	const context = rawPrintContext(document);
	const unresolved: UnresolvedName[] = [];

	for (const slot of formXPathSlots(document, formUuid)) {
		const printed = printExpression(slot.value, context);
		if (printed === undefined || printed.text === "") continue;
		const { text } = printed;
		const inText = (step: SyntaxNode) =>
			printed.parts.some(
				(part) => part.isText && part.from <= step.from && step.to <= part.to,
			);
		const edits: TextEdit[] = [];
		const reported = new Set<number>();
		const report = (step: PathStep) => {
			if (step.kind !== "name" || !oldNames.has(step.name)) return;
			if (reported.has(step.node.from)) return;
			reported.add(step.node.from);
			unresolved.push({
				carrier: slot.carrier,
				slot: slot.slot,
				name: step.name,
				expression: text,
			});
		};
		const start = slotContext(tree, slot);

		parser.parse(text).iterate({
			enter(cursorNode) {
				const path = cursorNode.node;
				if (!PATH_NAMES.has(path.name) && path.name !== "Invoke") return;
				if (!outermost(path)) return;
				const chain = chainOf(path, text);
				if (chain.steps.length === 0) return;
				if (chain.start === "instance") return;
				// A name step in a path an `instance()` call starts (inside its
				// filter, say) reads another document.
				if (
					chain.steps.some(
						(step) =>
							step.kind === "name" &&
							hasExplicitPathContext(step.node, text) &&
							startingCall(step.node, text) === "instance",
					)
				) {
					return;
				}
				let at: Cursor =
					chain.start === "root"
						? { kind: "node", node: tree.document }
						: chain.start === "context" || chain.start === "current"
							? start === null
								? { kind: "lost" }
								: { kind: "node", node: start }
							: { kind: "lost" };
				for (const [index, step] of chain.steps.entries()) {
					if (step.kind === "name" && !inText(step.node)) {
						// A reference leaf's own spelling: never rewritten here.
						at = { kind: "beyond" };
						continue;
					}
					if (at.kind === "beyond") continue;
					if (at.kind === "lost") {
						report(step);
						continue;
					}
					const here: TreeNode = at.node;
					switch (step.kind) {
						case "self":
							break;
						case "parent":
							at =
								here.parent === null
									? { kind: "lost" }
									: { kind: "node", node: here.parent };
							break;
						case "other":
							at = { kind: "lost" };
							break;
						case "name": {
							const named = here.children.get(step.name) ?? [];
							const next = siblingOf(named, chain.steps[index + 1]);
							if (named.length > 1 && next === undefined) {
								report(step);
								at = { kind: "lost" };
								break;
							}
							if (next === undefined) {
								if (here.opaque) {
									at = { kind: "beyond" };
								} else {
									report(step);
									at = { kind: "lost" };
								}
								break;
							}
							const rename = renamed.get(next.key);
							if (rename !== undefined) {
								edits.push({
									from: step.node.from,
									to: step.node.to,
									text: rename.to,
								});
							}
							at = { kind: "node", node: next };
							break;
						}
					}
				}
			},
		});
		if (edits.length > 0) applyTextEdits(printed, edits);
	}
	return unresolved;
}
