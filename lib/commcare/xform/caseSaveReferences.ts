/**
 * The `case_references_data.save` map of one form, derived from the form's
 * constructed tree before serialization.
 *
 * HQ's form builder recomputes this map from a form's Save to Case blocks on
 * every save (`Vellum/src/logic.js::LogicManager.caseReferences`, reading each
 * block through `src/saveToCase.js::parseDataNode`, `parseBindElement`,
 * `handleMugParseFinish` and `getCaseSaveData`), and HQ reads it as the
 * properties those blocks write: `models/form_actions.py::CaseReferences.save`
 * feeds `FormBase.get_save_to_case_updates`, HQ's case-property inventory and
 * its data dictionary. Deriving it from the tree, rather than beside each
 * emission site, means every block the emitter constructs is listed, and
 * computing it the way the editor does makes the stored map one its next
 * save leaves as it is.
 *
 * The rules, in the editor's terms:
 *
 * 1. One entry per data element carrying `vellum:role="SaveToCase"`, in
 *    document order, keyed by its absolute data path; repeat and
 *    model-iteration steps are plain steps.
 * 2. `case_type` comes from the `create/case_type` bind: the text inside its
 *    `calculate` where that is one quoted literal, `""` where it holds any
 *    other expression, and otherwise the block's `vellum:case_type`, or `""`.
 * 3. `create` and `close` say whether a `create` or a `close` element lies
 *    anywhere below one of the block's children, as the editor's jQuery
 *    `find` over the block's children reads them, so an update leaf named
 *    `close` makes a block that closes.
 * 4. Only bound leaves count, read in bind order: `case/create/<name>` and
 *    `case/update/<name>`. Every element name `FormPath` reads matches
 *    `[a-zA-Z_][a-zA-Z0-9_]*`, which the editor's `[\w-]+` admits whole, so
 *    every such leaf counts. The create binds of `case_type`, `case_name` and
 *    `owner_id` are read apart; `index` leaves and attachments are never
 *    listed.
 * 5. A block that creates lists its create names, then its update names, each
 *    once, then `case_type` where its type is set or an expression, then
 *    `case_name` and `owner_id` where their binds hold a `calculate`. Any
 *    other block lists its update names, each once. So a guard lists
 *    `case_type` and a rename lists `case_name`.
 *
 * HQ's build refuses a `create` entry that lacks `case_type` or `case_name`
 * (`helpers/validators.py::IndexedFormBaseValidator.check_save_to_case_references`).
 * The proof lane's `proof/checks/manifest_value_classes.py::vellum_case_references`
 * computes the same rules over a parsed form, and its two editor saves hold
 * this derivation to the editor's.
 */

import { type Element, isTag } from "domhandler";
import type { HqCaseSaveReference } from "@/lib/commcare/types";
import { FormPath } from "./formPath";

const SAVE_TO_CASE_ROLE = "SaveToCase";

/** The element child of `parent` named `name`, if any. */
function childNamed(parent: Element, name: string): Element | undefined {
	return parent.children.find(
		(child): child is Element => isTag(child) && child.name === name,
	);
}

/** Every element child of `parent` named `name`, in document order. */
function childrenNamed(parent: Element, name: string): Element[] {
	return parent.children.filter(
		(child): child is Element => isTag(child) && child.name === name,
	);
}

/**
 * Whether an element named `name` lies anywhere below one of `block`'s
 * element children, as jQuery's `$node.children().find(name)` reads it.
 */
function holdsBelowChildren(block: Element, name: string): boolean {
	const below = (element: Element): boolean =>
		element.children.some(
			(child) => isTag(child) && (child.name === name || below(child)),
		);
	return block.children.some((child) => isTag(child) && below(child));
}

/**
 * The bind's nodeset as a typed path. The emitter writes every nodeset from
 * a `FormPath`, so one that does not parse back is a fault in the emitter,
 * and the derivation throws rather than leave that bind's leaf unlisted.
 */
function bindPath(bind: Element): FormPath {
	const nodeset = bind.attribs.nodeset;
	if (nodeset === undefined) {
		throw new Error(
			"caseSaveReferences found a <bind> with no nodeset. Every bind the XForm emitter constructs addresses its node through a FormPath; look at the emission site that built this bind.",
		);
	}
	return FormPath.parse(nodeset);
}

/** The line terminators a JavaScript `.` does not match. */
const LINE_TERMINATORS = new Set(["\n", "\r", "\u2028", "\u2029"]);

/**
 * The text inside `text` when it is one quoted literal, the same quote at
 * both ends and no line terminator anywhere, as the editor's
 * `/^(['"])(.*)\1$/` reads one; `text` itself otherwise.
 */
function unquoted(text: string): string {
	const quote = text[0];
	return text.length >= 2 &&
		(quote === "'" || quote === '"') &&
		text[text.length - 1] === quote &&
		![...text].some((character) => LINE_TERMINATORS.has(character))
		? text.slice(1, -1)
		: text;
}

/** A block's bound leaf under `case/create` or `case/update`. */
interface BlockLeaf {
	readonly action: "create" | "update";
	readonly name: string;
	readonly calculate: string | undefined;
}

/**
 * Each Save to Case block's bound create and update leaves, by the block's
 * data path, in bind order.
 */
function leavesByBlock(binds: readonly Element[]): Map<string, BlockLeaf[]> {
	const leaves = new Map<string, BlockLeaf[]>();
	for (const bind of binds) {
		const path = bindPath(bind);
		const segments = path.segments();
		if (segments.length < 5) continue;
		const [caseStep, actionStep, leafStep] = segments.slice(-3);
		if (
			caseStep.kind !== "element" ||
			caseStep.name !== "case" ||
			actionStep.kind !== "element" ||
			(actionStep.name !== "create" && actionStep.name !== "update") ||
			leafStep.kind !== "element"
		)
			continue;
		const block = path.parent().parent().parent().toXPath();
		const list = leaves.get(block) ?? [];
		list.push({
			action: actionStep.name,
			name: leafStep.name,
			calculate: bind.attribs.calculate,
		});
		leaves.set(block, list);
	}
	return leaves;
}

/** One block's reference, from its element and its bound leaves. */
function blockReference(
	block: Element,
	leaves: readonly BlockLeaf[],
): HqCaseSaveReference {
	const create = holdsBelowChildren(block, "create");
	const close = holdsBelowChildren(block, "close");
	let caseType = block.attribs["vellum:case_type"] ?? "";
	let caseTypeExpression = false;
	let caseName: string | undefined;
	let ownerId: string | undefined;
	const createNames: string[] = [];
	const updateNames: string[] = [];
	for (const leaf of leaves) {
		if (leaf.action === "create" && leaf.name === "case_type") {
			const value = leaf.calculate ?? "";
			const literal = unquoted(value);
			if (literal !== "" && literal === value) {
				caseTypeExpression = true;
				caseType = "";
			} else if (literal !== "") {
				caseType = literal;
			}
		} else if (leaf.action === "create" && leaf.name === "case_name") {
			caseName = leaf.calculate;
		} else if (leaf.action === "create" && leaf.name === "owner_id") {
			ownerId = leaf.calculate;
		} else if (leaf.action === "create") {
			createNames.push(leaf.name);
		} else {
			updateNames.push(leaf.name);
		}
	}
	const properties = create
		? [...new Set([...createNames, ...updateNames])]
		: [...new Set(updateNames)];
	if (create) {
		if (caseType !== "" || caseTypeExpression) properties.push("case_type");
		if (caseName) properties.push("case_name");
		if (ownerId) properties.push("owner_id");
	}
	return {
		doc_type: "CaseSaveReference",
		case_type: caseType,
		properties,
		create,
		close,
	};
}

/**
 * The form's `case_references_data.save` map, from its constructed
 * `<h:html>` tree: one reference per Save to Case block, keyed by the
 * block's data path.
 */
export function caseSaveReferences(
	root: Element,
): Record<string, HqCaseSaveReference> {
	const head = childNamed(root, "h:head");
	const model = head === undefined ? undefined : childNamed(head, "model");
	if (model === undefined) {
		throw new Error(
			"caseSaveReferences was given a form tree with no <h:head><model>. Pass the <h:html> root the XForm emitter constructs.",
		);
	}
	const instance = childrenNamed(model, "instance").find(
		(candidate) => candidate.attribs.src === undefined,
	);
	const data = instance?.children.find(isTag);
	if (data === undefined) {
		throw new Error(
			"caseSaveReferences was given a form tree whose model holds no primary instance. Pass the <h:html> root the XForm emitter constructs.",
		);
	}
	const leaves = leavesByBlock(childrenNamed(model, "bind"));
	const references: Record<string, HqCaseSaveReference> = {};
	const visit = (element: Element, path: FormPath): void => {
		for (const child of element.children) {
			if (!isTag(child)) continue;
			const childPath = path.child(child.name);
			if (child.attribs["vellum:role"] === SAVE_TO_CASE_ROLE) {
				const key = childPath.toXPath();
				references[key] = blockReference(child, leaves.get(key) ?? []);
			} else {
				visit(child, childPath);
			}
		}
	};
	visit(data, FormPath.root());
	return references;
}
