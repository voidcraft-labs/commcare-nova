import { type Element, isTag } from "domhandler";
import {
	ANDROID_APP_INPUT_KINDS,
	androidAppInputMember,
} from "@/lib/domain/fields/androidApp";
import { uneditableAndroidAppName } from "../../xform/androidApp";
import {
	attributeNamespace,
	isElement,
	splitName,
	VELLUM_NS,
	XFORMS_NS,
} from "../../xmlNamespaces";
import { pendingPlaceholder } from "../pendingExpressions";
import type { XmlCursor } from "../xmlCursor";
import { X } from "./claims";
import type { DraftField } from "./index";
import { type DataNode, type DataTree, readNodePath } from "./model";
import type { ParsedXForm } from "./parse";

export interface ReadAndroidApp {
	readonly head: Element;
	readonly action: string;
	readonly send: readonly {
		readonly name: string;
		readonly ref: string;
		readonly element: Element;
	}[];
	readonly receive: readonly {
		readonly name: string;
		readonly node: DataNode;
		readonly ref: string;
		readonly element: Element;
	}[];
}

export function readAndroidApp(
	head: Element | undefined,
	invoking: DataNode,
	parsed: ParsedXForm,
	tree: DataTree,
): ReadAndroidApp | undefined {
	const action = head?.attribs.class;
	if (!head || !action || head.attribs.id !== invoking.name) return undefined;
	const namespace = (key: string) =>
		key === "xmlns" || key.startsWith("xmlns:");
	if (
		head.children.some(
			(node) => node.type === "text" && node.data.trim() !== "",
		)
	)
		return undefined;
	if (
		Object.keys(head.attribs).some(
			(key) => !namespace(key) && key !== "id" && key !== "class",
		)
	)
		return undefined;
	const send: ReadAndroidApp["send"][number][] = [];
	const receive: ReadAndroidApp["receive"][number][] = [];
	for (const child of head.children.filter(isTag)) {
		if (
			child.children.some(
				(node) =>
					isTag(node) || (node.type === "text" && node.data.trim() !== ""),
			)
		)
			return undefined;
		if (
			Object.keys(child.attribs).some(
				(key) =>
					!namespace(key) &&
					key !== "key" &&
					key !== "ref" &&
					!(
						attributeNamespace(key, parsed.scope(child)) === VELLUM_NS &&
						splitName(key).local === "ref"
					),
			)
		)
			return undefined;
		const name = child.attribs.key;
		const ref = child.attribs.ref;
		if (!name || !ref) return undefined;
		if (isElement(child, parsed.scope(child), XFORMS_NS, "extra")) {
			send.push({ name, ref, element: child });
		} else if (isElement(child, parsed.scope(child), XFORMS_NS, "response")) {
			const target = readNodePath(ref, tree, invoking);
			if (target.kind !== "node" || target.attribute !== undefined)
				return undefined;
			receive.push({ name, node: target.node, ref, element: child });
		} else return undefined;
	}
	if (uneditableAndroidAppName(send) || uneditableAndroidAppName(receive))
		return undefined;
	return { head, action, send, receive };
}

/** Claim only values represented in the draft. Unknown head/child attributes
 * stay available to the cursor's refusal and the normal shadow agreement check. */
export function claimAndroidApp(
	cursor: XmlCursor,
	app: ReadAndroidApp,
	field: DraftField,
	held: boolean,
): void {
	if (held) {
		const claims = X.androidAppHead;
		cursor.take({ element: app.head }, claims.head).value;
		cursor.take({ element: app.head, attribute: "id" }, claims.id).value;
		cursor.take({ element: app.head, attribute: "class" }, claims.action).value;
		for (const { element } of app.send) {
			cursor.take({ element }, claims.extra).value;
			cursor.take({ element, attribute: "key" }, claims.extraKey).value;
			cursor.take({ element, attribute: "ref" }, claims.extraRef).value;
		}
		for (const { element } of app.receive) {
			cursor.take({ element }, claims.response).value;
			cursor.take({ element, attribute: "key" }, claims.responseKey).value;
			cursor.take({ element, attribute: "ref" }, claims.responseRef).value;
		}
	} else cursor.refuseSubtree(app.head, X.androidAppRefused.head, field.place);
}

/** Generated-node proposals need the input reads before field identities are minted. */
export function registerAndroidAppInputs(
	app: ReadAndroidApp,
	field: DraftField,
) {
	for (const [index, value] of app.send.entries()) {
		field.expressions.push({
			slot: "android_app_input",
			androidAppInput: androidAppInputMember(app.send, index),
			text: value.ref,
			at: { element: value.element, attribute: "ref" },
			key: "jr-extension:IntentExtensionParser",
			mode: { target: "xform", constraint: false },
		});
	}
}

export function mintAndroidApp(
	field: DraftField,
	byNode: ReadonlyMap<DataNode, DraftField>,
): boolean {
	const draft = field.androidApp;
	if (!draft) return true;
	const targetReachable = (target: DraftField, invoking: DraftField) => {
		const repeats = (question: DraftField) => {
			const ids = new Set<DraftField>();
			for (
				let ancestor = question.parent;
				ancestor;
				ancestor = ancestor.parent
			) {
				if (ancestor.kind === "repeat") ids.add(ancestor);
			}
			return ids;
		};
		const rows = repeats(invoking);
		return [...repeats(target)].every((row) => rows.has(row));
	};
	if (draft.kind === "use-question") {
		if (
			!ANDROID_APP_INPUT_KINDS.has(field.kind) ||
			!draft.source.uuid ||
			draft.source.androidApp?.kind !== "open-app"
		)
			return false;
		if (
			!draft.source.androidApp.app.receive.every((result) => {
				const target = byNode.get(result.node);
				return target && targetReachable(target, field);
			})
		)
			return false;
		field.field.androidApp = { kind: draft.kind, question: draft.source.uuid };
		return true;
	}
	const { action, send, receive } = draft.app;
	const destinations = [];
	for (const result of receive) {
		const target = byNode.get(result.node);
		if (
			!target?.uuid ||
			target.standIn ||
			!targetReachable(target, field) ||
			["group", "section", "repeat"].includes(target.kind)
		)
			return false;
		destinations.push({ name: result.name, question: target.uuid });
	}
	field.field.androidApp = {
		kind: "open-app",
		action,
		send: send.map((arg) => ({
			name: arg.name,
			value: pendingPlaceholder("value"),
		})),
		receive: destinations,
	};
	return true;
}
