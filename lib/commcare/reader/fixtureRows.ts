import type { FormSyntax } from "../xpath/formSyntax";
import { caseTypeTest, core, flat, instanceId } from "./expressions/folds";
import { readFormSyntax, sharedFormSyntax } from "./syntaxRead";
/** An itemset's nodeset as `instance('item-list:<tag>')/<tag>_list/<tag>[filter]`: the tag and the
 *  filter's text, where it is that shape. */
export function itemsetSource(
	text: unknown,
): { tag: string; filter?: string } | undefined {
	if (typeof text !== "string") return undefined;
	const read = readFormSyntax(text);
	if (!read.ok) return;
	let node = read.node;
	let filter: string | undefined;
	if (node?.kind === "filter") {
		filter = text.slice(node.where.from, node.where.to);
		node = node.base;
	}
	if (node?.kind !== "child" || node.step.kind !== "name") return undefined;
	const item = node.step.name;
	const list = node.left;
	if (
		list?.kind !== "child" ||
		list.step.kind !== "name" ||
		list.step.name !== `${item}_list`
	)
		return undefined;
	const root = list.left;
	if (
		root?.kind !== "call" ||
		root.name !== "instance" ||
		root.args.length !== 1
	)
		return undefined;
	const id = root.args[0];
	if (id?.kind !== "string" || id.value !== `item-list:${item}`)
		return undefined;
	return filter === undefined ? { tag: item } : { tag: item, filter };
}

/** Whether columns in a tab are evaluated at a fixture row. The expression
 * binder still resolves the whole collection, including every filter. */
function detailSourceShape(text: unknown): {
	fixture?: true;
	caseType?: string;
} {
	if (typeof text !== "string") return {};
	const result = sharedFormSyntax(text);
	if (!result.ok || !result.node) return {};
	const path = flat(result.node);
	const id = instanceId(path);
	if (id?.startsWith("item-list:") || id === "locations")
		return { fixture: true };
	if (id !== "casedb" && id !== "results" && id !== "results:inline") return {};
	const row = path?.steps.at(-1);
	if (row?.name !== "case") return {};
	const types = new Set<string>();
	function visit(predicate: FormSyntax) {
		const expression = core(predicate);
		if (expression.kind === "binary" && expression.op === "and") {
			visit(expression.left);
			visit(expression.right);
		} else {
			const type =
				caseTypeTest(expression) ??
				(expression.kind === "binary" && expression.op === "="
					? caseTypeTest({
							...expression,
							left: expression.right,
							right: expression.left,
						})
					: undefined);
			if (type) types.add(type);
		}
	}
	for (const guard of row.where) visit(guard);
	return types.size === 1 ? { caseType: [...types][0] } : {};
}

/** The physical long-detail span supplies the row type for the source field
 * reader as well as the catalog it consults when it recognizes choice labels. */
export function detailSourceSpans<T extends Readonly<Record<string, unknown>>>(
	tabs: readonly T[],
	length: number,
) {
	const starts = new Map<
		number,
		{ tab: T; caseType?: string; fixture?: true }
	>();
	for (const tab of tabs) {
		if (typeof tab.starting_index !== "number") continue;
		const source =
			tab.has_nodeset === true ? detailSourceShape(tab.nodeset) : undefined;
		const child =
			tab.has_nodeset === true &&
			!tab.nodeset &&
			typeof tab.nodeset_case_type === "string"
				? tab.nodeset_case_type
				: undefined;
		starts.set(tab.starting_index, {
			tab,
			...source,
			...(child && { caseType: child }),
		});
	}
	let current: { tab: T; caseType?: string; fixture?: true } | undefined;
	return Array.from({ length }, (_, i) => (current = starts.get(i) ?? current));
}
