/**
 * Rose-tree helper for the preview engine.
 *
 * The normalized doc stores fields as a flat `fields` map plus a `fieldOrder`
 * adjacency list. The preview engine walks recursively from a form root down
 * through groups and repeats to collect paths, register expressions, and
 * initialise data instance entries — a rose-tree shape fits that access
 * pattern better than ad-hoc map lookups at every step.
 *
 * `FieldTreeNode` wraps a domain `Field` with optional `children`. `buildFieldTree`
 * turns a (parentUuid, fields, fieldOrder) triple into this tree shape in one
 * walk. The engine builds the tree once at construction / schema refresh and
 * then uses it for all internal traversal — no second indirection through
 * the flat maps during evaluation.
 */
import type { Field, Uuid } from "@/lib/domain";

/** A single node in the rose-tree representation of a field subtree. */
export interface FieldTreeNode {
	/** The domain field entity. */
	field: Field;
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
	fieldOrder: Record<string, Uuid[]>,
): FieldTreeNode[] {
	const order = fieldOrder[parentUuid] ?? [];
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
				children: buildFieldTree(uuid as Uuid, fields, fieldOrder),
			});
		} else {
			nodes.push({ field });
		}
	}
	return nodes;
}

/**
 * Adapter: convert a legacy nested-wire-format question tree into the engine's
 * `FieldTreeNode` rose tree. Used by the server-side CommCare validator
 * (`lib/services/commcare/validate/*`), which operates on AppBlueprint and
 * therefore has `Question[]` already. Every consumer OUTSIDE the wire-format
 * boundary builds the tree from the normalized doc via `buildFieldTree`.
 *
 * The mapping is structural only: question properties flow through unchanged
 * (the engine only reads `id`, `kind`, `label`, `hint`, xpath fields) — we
 * just rename `type` to `kind`. No semantic translation.
 */
export function questionTreeToFieldTree(
	questions: ReadonlyArray<{
		uuid: string;
		id: string;
		type: string;
		label?: string;
		hint?: string;
		required?: string;
		validation?: string;
		validation_msg?: string;
		relevant?: string;
		calculate?: string;
		default_value?: string;
		case_property_on?: string;
		options?: Array<{ value: string; label: string }>;
		children?: Array<unknown>;
	}>,
): FieldTreeNode[] {
	return questions.map((q) => {
		// Rebuild a Field-shaped object by renaming fields as needed. We cast
		// via `unknown` because the server-side wire type has more breadth
		// (e.g. `type` instead of `kind`) than any single Field variant.
		const field = {
			uuid: q.uuid,
			id: q.id,
			kind: q.type,
			label: q.label,
			hint: q.hint,
			required: q.required,
			relevant: q.relevant,
			calculate: q.calculate,
			default_value: q.default_value,
			validate: q.validation,
			validate_msg: q.validation_msg,
			case_property: q.case_property_on,
			options: q.options,
		} as unknown as Field;
		const children = q.children as
			| Array<Parameters<typeof questionTreeToFieldTree>[0][number]>
			| undefined;
		return children
			? { field, children: questionTreeToFieldTree(children) }
			: { field };
	});
}
