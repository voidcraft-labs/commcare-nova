import type { BlueprintDoc } from "@/lib/domain/blueprint";
import {
	type FormNodeGraph,
	type FormNodeStep,
	formNodeGraph,
} from "@/lib/domain/expression/formNodes";
import type { FormStructure } from "@/lib/domain/expression/formStructure";
import type { FormNodeRef } from "@/lib/domain/expression/types";
import { FormPath } from "../xform/formPath";
import { planRepeatCountNames } from "../xform/repeatCountNames";

export interface FormNodeProjection {
	readonly graph: FormNodeGraph;
	step(node: FormNodeRef): FormNodeStep | undefined;
	path(node: FormNodeRef): FormPath | undefined;
}

/** The only projection of the finite form graph to physical XForm names.
 * The migration may supply an old physical projection to parsing, but ordinary
 * editing and emission always use this canonical one. */
export function formNodeProjection(
	_doc: BlueprintDoc,
	form: FormStructure,
): FormNodeProjection {
	const graph = formNodeGraph(form);
	let countNames: ReturnType<typeof planRepeatCountNames> | undefined;
	const blockStep = (
		block: { readonly id: string } | undefined,
	): FormNodeStep | undefined =>
		block === undefined ? undefined : { name: block.id };
	function step(node: FormNodeRef): FormNodeStep | undefined {
		if (!graph.has(node)) return undefined;
		switch (node.kind) {
			case "form-root":
				return { name: "data" };
			case "field": {
				const field = form.fields.get(node.uuid);
				if (field === undefined) return undefined;
				return {
					name:
						field.kind === "repeat" &&
						field.repeatMode === "query_bound" &&
						node.role === undefined
							? "item"
							: field.id,
				};
			}
			case "repeat-row":
				return { name: node.attribute, attribute: true };
			case "repeat":
				if (node.role === "count-result") {
					countNames ??= planRepeatCountNames(form);
					const name = countNames.get(node.repeat);
					return name === undefined ? undefined : { name };
				}
				return {
					name:
						node.role === "query-ids"
							? "ids"
							: node.role === "query-count"
								? "count"
								: "current_index",
					attribute: true,
				};
			case "connect-learn":
				return node.role === "block"
					? blockStep(form.connect.learn_module)
					: node.role === "content"
						? { name: "module" }
						: node.role === "id"
							? { name: "id", attribute: true }
							: {
									name:
										node.role === "time-estimate" ? "time_estimate" : node.role,
								};
			case "connect-assessment":
				return node.role === "block"
					? blockStep(form.connect.assessment)
					: node.role === "content"
						? { name: "assessment" }
						: node.role === "id"
							? { name: "id", attribute: true }
							: { name: "user_score" };
			case "connect-delivery":
				return node.role === "block"
					? blockStep(form.connect.deliver_unit)
					: node.role === "content"
						? { name: "deliver" }
						: node.role === "id"
							? { name: "id", attribute: true }
							: { name: node.role.replaceAll("-", "_") };
			case "connect-task":
				return node.role === "block"
					? blockStep(form.connect.task)
					: { name: node.role === "content" ? "task" : node.role };
		}
	}
	return {
		graph,
		step,
		path(node) {
			const coordinates = graph.path(node);
			if (coordinates === undefined) return undefined;
			let path = FormPath.root();
			for (const coordinate of coordinates.slice(1)) {
				const projected = step(coordinate);
				if (projected === undefined) return undefined;
				path = projected.attribute
					? path.attr(projected.name)
					: path.child(projected.name);
			}
			return path;
		},
	};
}
