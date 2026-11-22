import type { FormSyntax } from "../../xpath/formSyntax";
import { instanceForRead } from "../../xpath/instanceSources";

/** Folds and dependency analysis recognize paths to Core's native databases.
 * Give them only the native roots a form's declarations actually supply,
 * and keep the local IDs for binding, refusals and declaration accounting. */
export function nativeInstancePaths(
	source: FormSyntax,
	sources: ReadonlyMap<string, string> | undefined,
): { syntax: FormSyntax; localIds: ReadonlyMap<number, string> } {
	const localIds = new Map<number, string>();
	function visit(node: FormSyntax): FormSyntax {
		switch (node.kind) {
			case "call": {
				const id = node.args[0];
				if (
					node.name === "instance" &&
					node.args.length === 1 &&
					id?.kind === "string"
				) {
					const bound = instanceForRead(id.value, sources);
					localIds.set(id.from, id.value);
					// Only the native source can match e.g. a fold for /casedb/case.
					let native: string;
					switch (bound?.kind) {
						case "native":
							native = bound.id;
							break;
						case "table":
							native = `item-list:${bound.tag}`;
							break;
						case "selected":
							native = `jr://instance/selected-entities/${bound.datum}`;
							break;
						default:
							native = `undeclared/${id.value}`;
					}
					return native === id.value
						? node
						: { ...node, args: [{ ...id, value: native }] };
				}
				return { ...node, args: node.args.map(visit) };
			}
			case "group":
			case "negative":
			case "axis":
				return { ...node, value: visit(node.value) };
			case "child":
				return {
					...node,
					...(node.left && { left: visit(node.left) }),
					step: visit(node.step),
				};
			case "filter":
				return { ...node, base: visit(node.base), where: visit(node.where) };
			case "binary":
				return { ...node, left: visit(node.left), right: visit(node.right) };
			default:
				return node;
		}
	}
	return { syntax: visit(source), localIds };
}
