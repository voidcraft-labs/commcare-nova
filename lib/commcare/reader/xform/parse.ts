/**
 * The frame of a form's source: its root, head, body and model, the model's
 * primary instance and data root, its other instances, binds, setvalues and
 * itext, each found by namespace and never by prefix. The frame every source
 * has is claimed here, and so is what the head and the model hold beside it.
 */

import type { Document, Element } from "domhandler";
import { isTag } from "domhandler";
import type { HqPlace } from "@/lib/publish/hqFindings";
import surface from "../../surface/surface.json";
import {
	elementNamespace,
	isElement,
	JAVAROSA_NS,
	type NamespaceScope,
	namespaceScopes,
	OPENROSA_NS,
	splitName,
	VELLUM_NS,
	XFORMS_NS,
	XHTML_NS,
} from "../../xmlNamespaces";
import type { Accounting } from "../accounting";
import { readerDefect } from "../defects";
import type { XmlCursor } from "../xmlCursor";
import { X } from "./claims";
import { type DataTree, readNodePath } from "./model";
import { CASE_MAPPINGS, readHashtagMetadata } from "./shadow";

const ODK_NS = "http://opendatakit.org/xforms";

export interface HashtagMetadata {
	readonly hashtags: Readonly<Record<string, string | null>>;
	readonly transforms: Readonly<Record<string, string>>;
}

export interface ParsedXForm {
	readonly html: Element;
	readonly head: Element;
	readonly body: Element;
	readonly model: Element;
	readonly dataRoot: Element;
	readonly instances: readonly {
		readonly element: Element;
		readonly id: string;
		readonly src: string | undefined;
	}[];
	readonly binds: readonly Element[];
	readonly setvalues: readonly Element[];
	readonly itext: Element | undefined;
	/** `vellum:ignore`'s tokens. */
	readonly ignore: readonly string[];
	readonly hashtags: HashtagMetadata;
	/** An element's namespace scope, for `xmlNamespaces.ts`'s helpers. */
	scope(element: Element): NamespaceScope;
}

/** The local names Core dispatches on, in a head as anywhere: its control and action handlers
 *  (`XFormParser.topLevelHandlers`, `actionHandlers`), as the surface records them. */
const DISPATCHED_NAMES: ReadonlySet<string> = new Set(
	Object.keys((surface as { readonly items: Record<string, unknown> }).items)
		.filter(
			(key) => key.startsWith("jr-control:") || key.startsWith("jr-action:"),
		)
		.map((key) => key.slice(key.indexOf(":") + 1)),
);

function children(element: Element): Element[] {
	return element.children.filter(isTag);
}

function find(
	element: Element,
	scope: (element: Element) => NamespaceScope,
	uri: string,
	local: string,
): Element | undefined {
	return children(element).find((child) =>
		isElement(child, scope(child), uri, local),
	);
}

/** Whether an element's local name, or a descendant's, is one Core dispatches on. */
function dispatched(element: Element): boolean {
	if (DISPATCHED_NAMES.has(splitName(element.name).local)) return true;
	return children(element).some(dispatched);
}

/** The value of an attribute written with no prefix. */
function plain(element: Element, name: string): string | undefined {
	return Object.hasOwn(element.attribs, name)
		? element.attribs[name]
		: undefined;
}

/** The name, as written, of an attribute in `uri` named `local`. */
function prefixedName(
	element: Element,
	scope: NamespaceScope,
	uri: string,
	local: string,
): string | undefined {
	for (const name of Object.keys(element.attribs)) {
		const split = splitName(name);
		if (
			split.prefix !== "" &&
			split.prefix !== "xmlns" &&
			split.local === local &&
			scope.get(split.prefix) === uri
		)
			return name;
	}
	return undefined;
}

export interface ParseInput {
	readonly document: Document;
	readonly cursor: XmlCursor;
	readonly accounting: Accounting;
	readonly formPlace: HqPlace;
	/** The form's `xmlns` as HQ stores it, which the data root's namespace must equal. */
	readonly xmlns: string;
	/** The ids an input's `intent:<id>` appearance names, whose `odkx:intent` the appearance
	 *  reader decides. */
	readonly intentIds: ReadonlySet<string>;
}

/**
 * Finds the frame and claims it, or refuses the source as blank where a part of the frame is
 * missing or the data root is in no namespace, covering the whole source with that one
 * finding.
 */
export function parseXFormSource(input: ParseInput): ParsedXForm | undefined {
	const { document, cursor, accounting, formPlace } = input;
	const scope = namespaceScopes(document);
	const html = document.children.filter(isTag)[0];
	const blank = () => {
		if (html !== undefined)
			cursor.refuseSubtree(html, X.blankSource, formPlace);
		else accounting.finding(X.blankSource, formPlace);
		return undefined;
	};
	if (html === undefined || !isElement(html, scope(html), XHTML_NS, "html"))
		return blank();
	const head = find(html, scope, XHTML_NS, "head");
	const body = find(html, scope, XHTML_NS, "body");
	const model =
		head === undefined ? undefined : find(head, scope, XFORMS_NS, "model");
	if (head === undefined || body === undefined || model === undefined)
		return blank();
	const instanceElements = children(model).filter((child) =>
		isElement(child, scope(child), XFORMS_NS, "instance"),
	);
	const primaries = instanceElements.filter(
		(element) => plain(element, "id") === undefined,
	);
	const primary = primaries[0];
	const dataRoot = primary === undefined ? undefined : children(primary)[0];
	if (
		primary === undefined ||
		dataRoot === undefined ||
		elementNamespace(dataRoot, scope(dataRoot)) === null
	)
		return blank();

	for (const element of [html, head, body, model, primary])
		cursor.derived({ element }, X.frame.model);
	const itext = find(model, scope, XFORMS_NS, "itext");
	if (itext !== undefined) cursor.derived({ element: itext }, X.frame.model);
	for (const second of primaries.slice(1))
		cursor.refuseSubtree(second, X.secondPrimaryInstance, formPlace);

	const ignore = readIgnore(html, scope(html), cursor, formPlace);
	const title = find(head, scope, XHTML_NS, "title");
	if (title !== undefined) cursor.take({ element: title }, X.title.title).value;
	claimDataRoot(dataRoot, scope(dataRoot), input);
	claimHead(head, model, title, scope, input);

	const instances = instanceElements
		.filter((element) => plain(element, "id") !== undefined)
		.map((element) => ({
			element,
			id: plain(element, "id") as string,
			src: plain(element, "src"),
		}));
	return {
		html,
		head,
		body,
		model,
		dataRoot,
		instances,
		binds: children(model).filter((child) =>
			isElement(child, scope(child), XFORMS_NS, "bind"),
		),
		setvalues: children(model).filter((child) =>
			isElement(child, scope(child), XFORMS_NS, "setvalue"),
		),
		itext,
		ignore,
		hashtags: readHashtagMetadata(head, scope(head)),
		scope,
	};
}

/** `vellum:ignore`, one claim for its tokens: any token but `markdown` and `richText` refuses
 *  it; else `markdown`, which the form reads as text shown as typed, takes it; else
 *  `richText` alone, which HQ's form builder reads past, drops it. */
function readIgnore(
	html: Element,
	scope: NamespaceScope,
	cursor: XmlCursor,
	formPlace: HqPlace,
): readonly string[] {
	const name = prefixedName(html, scope, VELLUM_NS, "ignore");
	if (name === undefined) return [];
	const node = { element: html, attribute: name };
	const tokens = (html.attribs[name] ?? "").split(/\s+/).filter(Boolean);
	if (tokens.some((token) => token !== "markdown" && token !== "richText")) {
		cursor.refuse(node, X.ignoreRetain, formPlace);
		return tokens;
	}
	if (tokens.includes("markdown"))
		return cursor
			.take(node, X.ignoreMarkdown)
			.value.split(/\s+/)
			.filter(Boolean);
	cursor.drop(node, X.ignoreRichText);
	return tokens;
}

/** The data root's own attributes and its namespace (8.2). */
function claimDataRoot(
	dataRoot: Element,
	scope: NamespaceScope,
	input: ParseInput,
): void {
	const { cursor, accounting, formPlace } = input;
	const uiVersion = plain(dataRoot, "uiVersion");
	if (uiVersion === undefined)
		cursor.refuse({ element: dataRoot }, X.uiVersionOther, formPlace);
	else {
		cursor.derived({ element: dataRoot }, X.frame.dataRoot);
		if (uiVersion === "1")
			cursor.derived(
				{ element: dataRoot, attribute: "uiVersion" },
				X.uiVersionOne,
			);
		else
			cursor.refuse(
				{ element: dataRoot, attribute: "uiVersion" },
				X.uiVersionOther,
				formPlace,
			);
	}
	if (elementNamespace(dataRoot, scope) !== input.xmlns)
		accounting.defect(
			formPlace,
			"schema:Form.xmlns",
			readerDefect.xmlnsDiffers(formPlace),
		);
	if (splitName(dataRoot.name).local !== "data")
		accounting.finding(X.rootNotData, formPlace, { name: dataRoot.name });
	for (const name of Object.keys(dataRoot.attribs)) {
		if (name === "uiVersion" || name.startsWith("xmlns:")) continue;
		const node = { element: dataRoot, attribute: name };
		if (name === "name") cursor.derived(node, X.dataName);
		else if (name === "version") cursor.drop(node, X.dataVersion);
		else if (name === "xmlns") cursor.take(node, X.dataXmlns).value;
		else {
			const split = splitName(name);
			const qualified =
				split.prefix !== "" && scope.get(split.prefix) === JAVAROSA_NS
					? `jr:${split.local}`
					: split.local;
			const claim =
				(
					X.dataRootAttribute as Readonly<
						Record<string, (typeof X.dataRootAttribute)["src"]>
					>
				)[qualified] ?? X.dataRootAttribute.src;
			cursor.refuse(node, claim, formPlace, { name });
		}
	}
}

/** The head's children beside its title and model, and the model's beside its instances,
 *  binds, setvalues and itext (8.2). */
function claimHead(
	head: Element,
	model: Element,
	title: Element | undefined,
	scope: (element: Element) => NamespaceScope,
	input: ParseInput,
): void {
	const { cursor, formPlace } = input;
	for (const child of children(head)) {
		if (child === model || child === title) continue;
		const own = scope(child);
		if (isElement(child, own, VELLUM_NS, "hashtags"))
			cursor.dropSubtree(child, X.hashtags.hashtags);
		else if (isElement(child, own, VELLUM_NS, "hashtagTransforms"))
			cursor.dropSubtree(child, X.hashtags.transforms);
		else if (isElement(child, own, VELLUM_NS, "case_mappings"))
			cursor.dropSubtree(child, CASE_MAPPINGS);
		else if (isElement(child, own, ODK_NS, "intent")) {
			const id = plain(child, "id");
			if (id === undefined || !input.intentIds.has(id))
				cursor.dropSubtree(child, X.odkxIntentUnreferenced);
		} else if (dispatched(child))
			cursor.refuseSubtree(child, X.headDispatched, formPlace, {
				name: splitName(child.name).local,
			});
		else cursor.dropSubtree(child, X.headOther);
	}
}

const MODEL_OWN = new Set(["instance", "bind", "setvalue", "itext"]);
const NAMED_LIKE_XFORMS = new Set([
	"itext",
	"instance",
	"bind",
	"submission",
	"setvalue",
	"send",
	"pollsensor",
]);

/**
 * The model's children other than its instances, binds, setvalues and itext: submissions and
 * the `send` that names one, an authored `orx:pollsensor`, and any other child by its
 * namespace. A submission is held to Core's own rule (`XFormParser.parseSubmission`), its
 * `targetref` and `ref` read against the data tree.
 */
export function claimModelChildren(
	parsed: ParsedXForm,
	tree: DataTree,
	cursor: XmlCursor,
	accounting: Accounting,
	formPlace: HqPlace,
): void {
	const own = (element: Element) => parsed.scope(element);
	const all = children(parsed.model);
	const sends = all.filter((child) =>
		isElement(child, own(child), XFORMS_NS, "send"),
	);
	const sent = new Set(
		sends
			.map((send) => plain(send, "submission"))
			.filter((id) => id !== undefined),
	);
	for (const child of all) {
		const scope = own(child);
		const namespace = elementNamespace(child, scope);
		const local = splitName(child.name).local;
		if (namespace === XFORMS_NS && MODEL_OWN.has(local)) continue;
		if (namespace === XFORMS_NS && local === "send") {
			cursor.refuseSubtree(child, X.sendSubmission, formPlace);
			continue;
		}
		if (namespace === XFORMS_NS && local === "submission") {
			const id = plain(child, "id");
			if (id !== undefined && sent.has(id))
				cursor.refuseSubtree(child, X.sendSubmission, formPlace);
			else if (submissionCoreAccepts(child, tree, accounting))
				cursor.dropSubtree(child, X.submissionAccepted);
			else cursor.refuseSubtree(child, X.submissionRefused, formPlace);
			continue;
		}
		if (
			(namespace === OPENROSA_NS || namespace === XFORMS_NS) &&
			local === "pollsensor"
		) {
			cursor.refuseSubtree(child, X.pollsensor, formPlace);
			continue;
		}
		if (namespace === XFORMS_NS)
			cursor.refuseSubtree(child, X.modelXformsChild, formPlace, {
				name: local,
			});
		else if (NAMED_LIKE_XFORMS.has(local))
			cursor.refuseSubtree(child, X.modelForeignNamed, formPlace, {
				name: local,
			});
		else cursor.dropSubtree(child, X.modelForeignOther);
	}
}

/** Core's rule for a submission, as the entry's item states it. */
function submissionCoreAccepts(
	element: Element,
	tree: DataTree,
	accounting: Accounting,
): boolean {
	const id = plain(element, "id");
	const resource = plain(element, "resource");
	const targetref = plain(element, "targetref");
	if (id === undefined || resource === undefined || targetref === undefined)
		return false;
	const method = plain(element, "method");
	const replace = plain(element, "replace");
	const mode = plain(element, "mode");
	if (method !== undefined && method !== "get") return false;
	if (replace !== undefined && replace !== "text") return false;
	if (mode !== undefined && mode !== "synchronous") return false;
	const ref = plain(element, "ref");
	return [targetref, ...(ref === undefined ? [] : [ref])].every(
		(path) => readNodePath(path, tree, null, accounting).kind === "node",
	);
}
