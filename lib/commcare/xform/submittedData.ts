import type { Element } from "domhandler";
import { isTag } from "domhandler";
import { submittedAction } from "@/lib/domain/submittedAnswerName";
import {
	elementNamespace,
	type NamespaceScope,
	scopeOf,
	splitName,
} from "../xmlNamespaces";

/** Walk the *emitted* primary instance the way the submission receiver does.
 * The envelope itself is outside dispatch. Case blocks built from the form's
 * case operations own all descendants, including properties called fixture.
 * An ordinary node has no authority to represent such a transaction.
 */
export function assertAnswerDataReachesReceiver(
	root: Element,
	webApps: boolean,
): void {
	const visit = (
		node: Element,
		inherited: NamespaceScope,
		parentPath: string,
	): void => {
		const scope = scopeOf(node, inherited);
		const name = splitName(node.name).local;
		const namespace = elementNamespace(node, scope);
		const action = submittedAction(name, namespace);
		const path = parentPath + "/" + node.name;
		if (
			action === "case" &&
			name === "case" &&
			namespace === "http://commcarehq.org/case/transaction/v2" &&
			Object.hasOwn(node.attribs, "case_id") &&
			Object.hasOwn(node.attribs, "date_modified")
		)
			return;
		if (
			action !== undefined &&
			(webApps || action === "case" || action === "stock")
		) {
			throw new Error(
				`The submitted answer at ${path} would be read as a ${action} instruction. Give it a different ID or receiving namespace.`,
			);
		}
		for (const child of node.children)
			if (isTag(child)) visit(child, scope, path);
	};
	const scope = scopeOf(root, new Map());
	for (const child of root.children)
		if (isTag(child)) visit(child, scope, "/" + root.name);
}
