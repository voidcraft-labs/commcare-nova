import { type Element, isTag } from "domhandler";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { derivedFormXmlns } from "../wireIdentity";
import { collectFieldLocations } from "../xform/caseOps";
import {
	isElement,
	namespaceScopes,
	splitName,
	XFORMS_NS,
	XHTML_NS,
} from "../xmlNamespaces";
import { parseXml } from "../xmlParse";
import type { HqAppSource } from "./appSource";

/** Match the actual submission columns a retained HQ source contains when
 * its original Nova revision is older than the app's replay horizon. An
 * adoption keeps the original xmlns in the deployment's identity ledger. */
export function publishedQuestionPaths(
	doc: BlueprintDoc,
	source: HqAppSource,
	originals: ReadonlyMap<string, string>,
): Uuid[] {
	const forms = new Map(
		Object.values(doc.forms).map((form) => [
			originals.get(form.uuid) ?? derivedFormXmlns(form.uuid),
			form.uuid,
		]),
	);
	const held = new Set<Uuid>();
	for (const menu of source.modules)
		for (const form of menu.forms) {
			const uuid = form.xmlns === null ? undefined : forms.get(form.xmlns);
			if (uuid === undefined || form.attachment === null) continue;
			const tree = parseXml(form.attachment).doc;
			const scope = namespaceScopes(tree);
			const child = (parent: Element | undefined, ns: string, local: string) =>
				parent?.children
					.filter(isTag)
					.find((node) => isElement(node, scope(node), ns, local));
			const head = child(tree.children.find(isTag), XHTML_NS, "head");
			const model = child(head, XFORMS_NS, "model");
			const primary = model?.children
				.filter(isTag)
				.find(
					(node) =>
						isElement(node, scope(node), XFORMS_NS, "instance") &&
						node.attribs.id === undefined,
				);
			const root = primary?.children.find(isTag);
			if (root === undefined) continue;
			const paths = new Set<string>();
			const collect = (node: Element, prefix: string) => {
				for (const member of node.children.filter(isTag)) {
					const path = `${prefix}/${splitName(member.name).local}`;
					paths.add(path);
					collect(member, path);
				}
			};
			collect(root, "");
			for (const [field, location] of collectFieldLocations(doc, uuid)) {
				const path = location.path
					.segments()
					.slice(1)
					.map((step) => step.name)
					.join("/");
				if (paths.has(`/${path}`)) held.add(field);
			}
		}
	return [...held];
}
