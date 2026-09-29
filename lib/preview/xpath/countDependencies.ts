import type { SyntaxNode } from "@lezer/common";
import { parser } from "@/lib/commcare/xpath";

/** Structural dependencies for live-count admission. Resolve paths against the
 * authored tree, retaining every possible predicate match. Navigation steps are
 * not reads: current()/../n depends on n, not on the calculation carrier. */
export function countDependencies(
	source: string,
	origin: string,
	fieldPaths: Iterable<string>,
): string[] {
	const paths = new Set(["", "/data", origin, ...fieldPaths]);
	const refs = new Set<string>();
	const parent = (path: string) => path.slice(0, path.lastIndexOf("/"));
	const text = (node: SyntaxNode) => source.slice(node.from, node.to);
	const children = (node: SyntaxNode): SyntaxNode[] => {
		const result: SyntaxNode[] = [];
		for (let child = node.firstChild; child; child = child.nextSibling)
			result.push(child);
		return result;
	};
	const record = (selected: readonly string[]) => {
		for (let path of selected) {
			while (path.startsWith("/data/")) {
				refs.add(path);
				path = parent(path);
			}
		}
	};
	const named = (candidates: string[], name: string) =>
		candidates.filter(
			(path) => name === "*" || path.slice(path.lastIndexOf("/") + 1) === name,
		);
	const step = (node: SyntaxNode, context: string[]): string[] => {
		if (node.name === "SelfStep") return context;
		if (node.name === "ParentStep") return [...new Set(context.map(parent))];
		if (node.name === "NameTest")
			return named(
				[...paths].filter(
					(path) => path !== "" && context.includes(parent(path)),
				),
				text(node),
			);
		if (node.name === "AttrSpecified")
			return context.map((path) => `${path}/${text(node)}`);
		if (node.name === "AxisSpecified") {
			const axis = node.getChild("AxisName");
			const target = node.lastChild;
			if (!axis || !target) return [];
			const direction = text(axis);
			const candidates = [...paths].filter((path) =>
				context.some((base) => {
					if (direction === "self") return path === base;
					if (direction === "parent") return path === parent(base);
					if (direction === "ancestor") return base.startsWith(`${path}/`);
					if (direction === "ancestor-or-self")
						return path === base || base.startsWith(`${path}/`);
					if (direction === "descendant") return path.startsWith(`${base}/`);
					if (direction === "descendant-or-self")
						return path === base || path.startsWith(`${base}/`);
					return parent(path) === base;
				}),
			);
			return named(candidates, text(target));
		}
		return visit(node, context, false);
	};
	const visit = (
		node: SyntaxNode,
		context: string[],
		read = true,
	): string[] => {
		let selected: string[];
		if (node.name === "RootPath") selected = [""];
		else if (node.name === "HashtagRef")
			selected = text(node).startsWith("#form/")
				? [`/data/${text(node).slice(6)}`]
				: [];
		else if (
			[
				"NameTest",
				"SelfStep",
				"ParentStep",
				"AttrSpecified",
				"AxisSpecified",
			].includes(node.name)
		)
			selected = step(node, context);
		else if (node.name === "Child" || node.name === "Descendant") {
			const parts = children(node);
			const left = parts[0];
			const right = parts.at(-1);
			if (!left || !right) return [];
			let base =
				left.name === "/" || left.name === "//"
					? [""]
					: visit(left, context, false);
			if (node.name === "Descendant")
				base = [...paths].filter((path) =>
					base.some((root) => path === root || path.startsWith(`${root}/`)),
				);
			selected = step(right, base);
		} else if (node.name === "Filtered") {
			const parts = children(node);
			const base = parts[0];
			selected = base ? visit(base, context, false) : [];
			for (const predicate of parts.slice(1)) visit(predicate, selected);
		} else if (node.name === "Invoke") {
			const name = node.getChild("FunctionName");
			if (name && text(name) === "current") selected = [origin];
			else {
				selected = [];
				const args = node.getChild("ArgumentList");
				if (args)
					for (const arg of children(args))
						selected.push(...visit(arg, context));
				if (name && text(name) === "instance") selected = [];
			}
		} else {
			selected = children(node).flatMap((child) => visit(child, context));
		}
		if (read) record(selected);
		return selected;
	};
	visit(parser.parse(source).topNode, [origin]);
	return [...refs];
}
