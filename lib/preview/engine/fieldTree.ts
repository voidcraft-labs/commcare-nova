/**
 * Rose-tree helper for the preview engine.
 *
 * The normalized doc stores fields as a flat `fields` map plus a `fieldOrder`
 * adjacency list. The preview engine walks recursively from a form root down
 * through groups and repeats to collect paths, register expressions, and
 * initialise data instance entries — a rose-tree shape fits that access
 * pattern better than ad-hoc map lookups at every step.
 *
 * `FieldTreeNode` wraps a domain `Field` with optional `children`.
 * `buildFieldTree` turns a (parentUuid, fields, fieldOrder) triple into
 * this tree in one walk. The engine builds the tree once at construction
 * / schema refresh and uses it for every internal traversal.
 */
import type { Field, Uuid } from "@/lib/domain";
import { submissionLayout } from "@/lib/domain/submissionLayout";
import { rebaseOntoContext, stripIndices } from "./instancePaths";

/** A single node in the rose-tree representation of a field subtree. */
export interface FieldTreeNode {
	/** The domain field entity. */
	field: Field;
	/** A separately laid out control reads this submitted value. */
	submittedPath?: string;
	/** Recursive child nodes for container kinds (group, repeat). Leaf fields omit. */
	children?: FieldTreeNode[];
}

/**
 * Build the rose-tree of fields rooted at `parentUuid`.
 *
 * Used by the form engine at construction and whenever the form's structure
 * changes. Missing entries in `fields` are skipped silently — defensive
 * against transient states during agent writes where the order array has
 * been updated but the field entity isn't yet in `fields`. A production
 * build never hits this case because mutations touch both atomically.
 */
export function buildFieldTree(
	parentUuid: Uuid,
	fields: Record<string, Field>,
	fieldOrder: Record<string, readonly Uuid[]>,
): FieldTreeNode[] {
	// The membership array is the one authored sibling sequence.
	const order = [...(fieldOrder[parentUuid] ?? [])];
	const nodes: FieldTreeNode[] = [];
	for (const uuid of order) {
		const field = fields[uuid];
		if (!field) continue;
		// Containers carry a fieldOrder entry even when empty — leaf fields
		// do not, so presence of an entry is the signal for recursion.
		const nestedOrder = fieldOrder[uuid];
		if (nestedOrder !== undefined) {
			nodes.push({
				field,
				children: buildFieldTree(uuid, fields, fieldOrder),
			});
		} else {
			nodes.push({ field });
		}
	}
	return nodes;
}

/** The runtime evaluates binds and submits values in data order. A question
 * can draw that same value on a different screen in the same repeat row. */
export function formFieldTrees(
	form: Uuid,
	fields: Record<string, Field>,
	order: Record<string, Uuid[]>,
) {
	const controls = buildFieldTree(form, fields, order);
	const layout = submissionLayout(form, fields, order);
	if (!layout.independent)
		return { submitted: controls, controls, contains: ordinaryScreenContains };
	const submitted = buildFieldTree(
		form,
		fields,
		Object.fromEntries(layout.children),
	);
	const paths = new Map<Uuid, string>();
	const collect = (nodes: FieldTreeNode[], parent: string): void => {
		for (const node of nodes) {
			const path = `${parent}/${node.field.id}`;
			paths.set(node.field.uuid, path);
			if (node.children !== undefined) collect(node.children, path);
		}
	};
	collect(submitted, "/data");
	const place = (nodes: FieldTreeNode[]): void => {
		for (const node of nodes) {
			node.submittedPath = paths.get(node.field.uuid);
			if (node.children !== undefined) place(node.children);
		}
	};
	place(controls);
	const byPath = new Map([...paths].map(([uuid, path]) => [path, uuid]));
	const contains = (outer: string, inner: string): boolean => {
		if (outer === "/data" || outer === inner) return true;
		const template = stripIndices(outer);
		const parent = byPath.get(template);
		const atRow = rebaseOntoContext(template, inner);
		if (
			parent === undefined ||
			(atRow !== outer &&
				!(fields[parent].kind === "repeat" && atRow.startsWith(`${outer}[`)))
		)
			return false;
		let uuid = byPath.get(stripIndices(inner));
		while (uuid !== undefined) {
			if (uuid === parent) return true;
			uuid = layout.controlParents.get(uuid);
		}
		return false;
	};
	return { submitted, controls, contains };
}

/** Resolve a worker control against its containing live repeat entry. */
export function controlValuePath(node: FieldTreeNode, context: string): string {
	return node.submittedPath === undefined
		? `${context}/${node.field.id}`
		: rebaseOntoContext(node.submittedPath, context);
}

function ordinaryScreenContains(outer: string, inner: string): boolean {
	return (
		outer === "/data" ||
		inner === outer ||
		inner.startsWith(`${outer}/`) ||
		inner.startsWith(`${outer}[`)
	);
}
