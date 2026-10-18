import type { Uuid } from "../uuid";
import type { FormStructure } from "./formStructure";
import { type FormNodeRef, formNodeKey } from "./types";

/** A supplied projection spells nodes; the graph itself stores only identity. */
export interface FormNodeStep {
	readonly name: string;
	readonly attribute?: true;
}

export interface FormNodeGraph {
	readonly root: Extract<FormNodeRef, { kind: "form-root" }>;
	has(node: FormNodeRef): boolean;
	parent(node: FormNodeRef): FormNodeRef | undefined;
	children(node: FormNodeRef): readonly FormNodeRef[];
	/** Root-inclusive coordinates. Count results are declared coordinates even
	 * when a direct count has no incoming read and needs no physical carrier. */
	path(node: FormNodeRef): readonly FormNodeRef[] | undefined;
}

const graphs = new WeakMap<FormStructure, FormNodeGraph>();

/** The finite instance shape an expression can name. A generated node's
 * owner and role are its identity; names and query-row spelling are projections. */
export function formNodeGraph(form: FormStructure): FormNodeGraph {
	const cached = graphs.get(form);
	if (cached !== undefined) return cached;
	const root = { kind: "form-root", form: form.formUuid } as const;
	const fieldNode = (uuid: Uuid): FormNodeRef => ({ kind: "field", uuid });
	const parentField = (uuid: Uuid): FormNodeRef | undefined => {
		const field = form.fields.get(uuid);
		return field === undefined
			? undefined
			: field.parent === form.formUuid
				? root
				: fieldNode(field.parent);
	};
	function declared(node: FormNodeRef): boolean {
		switch (node.kind) {
			case "form-root":
				return node.form === form.formUuid;
			case "field": {
				const field = form.fields.get(node.uuid);
				return (
					field !== undefined &&
					(node.role === undefined ||
						(field.kind === "repeat" && field.repeatMode === "query_bound"))
				);
			}
			case "repeat-row": {
				const field = form.fields.get(node.repeat);
				return field?.kind === "repeat" && field.repeatMode === "query_bound";
			}
			case "repeat": {
				const field = form.fields.get(node.repeat);
				return (
					field?.kind === "repeat" &&
					field.repeatMode ===
						(node.role === "count-result" ? "count_bound" : "query_bound")
				);
			}
			case "connect-learn":
				return (
					node.form === form.formUuid && form.connect.learn_module !== undefined
				);
			case "connect-assessment":
				return (
					node.form === form.formUuid && form.connect.assessment !== undefined
				);
			case "connect-delivery":
				return (
					node.form === form.formUuid && form.connect.deliver_unit !== undefined
				);
			case "connect-task":
				return node.form === form.formUuid && form.connect.task !== undefined;
		}
	}
	function parent(node: FormNodeRef): FormNodeRef | undefined {
		switch (node.kind) {
			case "form-root":
				return undefined;
			case "field": {
				const field = form.fields.get(node.uuid);
				if (
					node.role === undefined &&
					field?.kind === "repeat" &&
					field.repeatMode === "query_bound"
				)
					return { kind: "field", uuid: node.uuid, role: "query-wrapper" };
				return parentField(node.uuid);
			}
			case "repeat-row":
				return fieldNode(node.repeat);
			case "repeat":
				return node.role === "count-result"
					? parentField(node.repeat)
					: { kind: "field", uuid: node.repeat, role: "query-wrapper" };
			case "connect-learn":
			case "connect-assessment":
			case "connect-delivery":
			case "connect-task":
				return node.role === "block"
					? root
					: node.role === "content"
						? { ...node, role: "block" }
						: { ...node, role: "content" };
		}
	}
	const paths = new Map<string, readonly FormNodeRef[] | undefined>();
	function path(node: FormNodeRef): readonly FormNodeRef[] | undefined {
		const key = formNodeKey(node);
		if (paths.has(key)) return paths.get(key);
		const result: FormNodeRef[] = [];
		const seen = new Set<string>();
		let current: FormNodeRef | undefined = node;
		while (current !== undefined && declared(current)) {
			const currentKey = formNodeKey(current);
			if (seen.has(currentKey)) break;
			seen.add(currentKey);
			result.unshift(current);
			if (current.kind === "form-root") {
				paths.set(key, result);
				return result;
			}
			current = parent(current);
		}
		paths.set(key, undefined);
		return undefined;
	}
	function authoredChildren(parentUuid: Uuid): FormNodeRef[] {
		const children: FormNodeRef[] = [];
		for (const uuid of form.fieldOrder.get(parentUuid) ?? []) {
			const field = form.fields.get(uuid);
			if (field === undefined || field.parent !== parentUuid) continue;
			children.push(
				field.kind === "repeat" && field.repeatMode === "query_bound"
					? { kind: "field", uuid, role: "query-wrapper" }
					: fieldNode(uuid),
			);
			if (field.kind === "repeat" && field.repeatMode === "count_bound")
				children.push({ kind: "repeat", repeat: uuid, role: "count-result" });
		}
		return children;
	}
	function children(node: FormNodeRef): readonly FormNodeRef[] {
		if (path(node) === undefined) return [];
		switch (node.kind) {
			case "form-root":
				return [
					...authoredChildren(form.formUuid),
					...(form.connect.learn_module === undefined
						? []
						: [
								{
									kind: "connect-learn",
									form: form.formUuid,
									role: "block",
								} as const,
							]),
					...(form.connect.assessment === undefined
						? []
						: [
								{
									kind: "connect-assessment",
									form: form.formUuid,
									role: "block",
								} as const,
							]),
					...(form.connect.deliver_unit === undefined
						? []
						: [
								{
									kind: "connect-delivery",
									form: form.formUuid,
									role: "block",
								} as const,
							]),
					...(form.connect.task === undefined
						? []
						: [
								{
									kind: "connect-task",
									form: form.formUuid,
									role: "block",
								} as const,
							]),
				];
			case "field": {
				const field = form.fields.get(node.uuid);
				if (node.role === "query-wrapper")
					return [
						fieldNode(node.uuid),
						{ kind: "repeat", repeat: node.uuid, role: "query-ids" },
						{ kind: "repeat", repeat: node.uuid, role: "query-count" },
						{ kind: "repeat", repeat: node.uuid, role: "query-position" },
					];
				if (field?.kind === "repeat" && field.repeatMode === "query_bound")
					return [
						...authoredChildren(node.uuid),
						{ kind: "repeat-row", repeat: node.uuid, attribute: "id" },
						{ kind: "repeat-row", repeat: node.uuid, attribute: "index" },
					];
				return field !== undefined &&
					["group", "section", "repeat"].includes(field.kind)
					? authoredChildren(node.uuid)
					: [];
			}
			case "connect-learn":
				return node.role === "block"
					? [{ ...node, role: "content" }]
					: node.role === "content"
						? (["id", "name", "description", "time-estimate"] as const).map(
								(role) => ({ ...node, role }),
							)
						: [];
			case "connect-assessment":
				return node.role === "block"
					? [{ ...node, role: "content" }]
					: node.role === "content"
						? (["id", "score"] as const).map((role) => ({ ...node, role }))
						: [];
			case "connect-delivery":
				return node.role === "block"
					? [{ ...node, role: "content" }]
					: node.role === "content"
						? (
								[
									"id",
									"name",
									"entity-id",
									"entity-name",
									"work-area-id",
								] as const
							).map((role) => ({ ...node, role }))
						: [];
			case "connect-task":
				return node.role === "block"
					? [{ ...node, role: "content" }]
					: node.role === "content"
						? (["name", "description"] as const).map((role) => ({
								...node,
								role,
							}))
						: [];
			case "repeat":
			case "repeat-row":
				return [];
		}
	}
	const graph: FormNodeGraph = {
		root,
		has: (node) => path(node) !== undefined,
		parent: (node) => (path(node) === undefined ? undefined : parent(node)),
		children,
		path,
	};
	graphs.set(form, graph);
	return graph;
}
