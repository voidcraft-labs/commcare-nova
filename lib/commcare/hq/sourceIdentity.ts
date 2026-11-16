/**
 * What an application's source gives every runtime, CommCare HQ's servers and
 * the data a project already holds to read by: its languages, its menus' ids
 * and case types, each form's `xmlns`, and in each form every answer leaf with
 * the repeats around it, the control a worker answers it with, the type Core
 * stores it as and its inline choices, every group and repeat, and the order
 * of the controls.
 *
 * It is read the same way from any application JSON with its `_attachments`:
 * an app as CommCare HQ stores it, or an app Nova writes. JSON is read by key,
 * and each form's XML through `xmlParse.ts` and the namespace helpers of
 * `xmlNamespaces.ts`. No XPath is parsed: a path attribute is used as text,
 * and a relative one is resolved against its enclosing group or repeat as
 * `corehq/apps/app_manager/xform.py::XForm.resolve_path` resolves it (a leading
 * `/` is absolute; anything else is the context, a `/`, and the text). It
 * shares nothing with the reader of CommCare HQ's apps, so a comparison of two
 * of its records holds that reader to an extraction of its own.
 */

import { type Element, isText } from "domhandler";
import { FORM_TEXTS_HELD_CHARACTERS, HeldByText } from "../heldByText";
import {
	elementChildren,
	elementNamespace,
	isElement,
	JAVAROSA_NS,
	type NamespaceScope,
	namespacedAttribute,
	splitName,
	XFORMS_NS,
	XHTML_NS,
} from "../xmlNamespaces";
import { heldXmlParse } from "../xmlParse";

/** Core's data type for a bind's `type`, by `XFormParser.java::typeMappings`. */
export type CoreTypeClass =
	| "text"
	| "integer"
	| "long"
	| "decimal"
	| "date"
	| "time"
	| "date-time"
	| "boolean"
	| "choice"
	| "choice-list"
	| "geopoint"
	| "barcode"
	| "binary"
	| "unsupported"
	| `other:${string}`;

/** `XFormParser.java::typeMappings`, one class per Core data type, by the type's local name. */
const TYPE_CLASSES: Readonly<Record<string, CoreTypeClass>> = {
	string: "text",
	int: "integer",
	integer: "integer",
	long: "long",
	decimal: "decimal",
	double: "decimal",
	float: "decimal",
	dateTime: "date-time",
	date: "date",
	time: "time",
	boolean: "boolean",
	listItem: "choice",
	select1: "choice",
	listItems: "choice-list",
	select: "choice-list",
	geopoint: "geopoint",
	barcode: "barcode",
	binary: "binary",
	gYear: "unsupported",
	gMonth: "unsupported",
	gDay: "unsupported",
	gYearMonth: "unsupported",
	gMonthDay: "unsupported",
	base64Binary: "unsupported",
	hexBinary: "unsupported",
	anyURI: "unsupported",
};

/**
 * `XFormParser.java::typeMappings` as data, each key with and without the
 * `xsd:` prefix. `xsd:int` and `xsd:integer` are one class, as are
 * `xsd:double` and `xsd:decimal`, because Core gives each pair one data type.
 */
export const CORE_BIND_TYPE_CLASSES: Readonly<Record<string, CoreTypeClass>> =
	Object.freeze(
		Object.fromEntries(
			Object.entries(TYPE_CLASSES).flatMap(([type, typeClass]) => [
				[type, typeClass],
				[`xsd:${type}`, typeClass],
			]),
		),
	);

/**
 * `type` with its prefix removed, looked up, as
 * `XFormParser.java::getDataType` removes everything to the first `:`. An
 * absent type is `text`: Core gives it `DATATYPE_NULL`, which
 * `Recalculate.java::wrapData` wraps as it wraps text. A type outside the
 * table keeps its own name, `other:<type>`, where Core gives every such type
 * `DATATYPE_UNSUPPORTED`, so two unknown types never compare equal.
 */
export function coreTypeClass(bindType: string | null): CoreTypeClass {
	if (bindType === null) return "text";
	const colon = bindType.indexOf(":");
	const local = colon < 0 ? bindType : bindType.slice(colon + 1);
	return Object.hasOwn(TYPE_CLASSES, local)
		? (TYPE_CLASSES[local] as CoreTypeClass)
		: `other:${local}`;
}

export interface AnswerLeaf {
	/** The leaf's absolute data path: `/data/household/head_name`. */
	readonly path: string;
	/** The nodeset of every `<repeat>` whose template holds the leaf, outermost first. */
	readonly repeats: readonly string[];
	/** The body control bound to it, by local name; `none` for a node with no control. */
	readonly control:
		| "input"
		| "select1"
		| "select"
		| "upload"
		| "trigger"
		| "secret"
		| "none";
	readonly typeClass: CoreTypeClass;
	/** `mediatype` of an `upload`; null otherwise. */
	readonly mediatype: string | null;
	/** The control's `appearance`, as written; null where it has none or there is no control. */
	readonly appearance: string | null;
	/** Inline `<item>` values in body order, each trimmed; null where the control has no item. */
	readonly choices: readonly string[] | null;
	/** Whether the control holds an `<itemset>`. */
	readonly itemset: boolean;
}

export interface ContainerIdentity {
	/** A `<group ref>`'s `ref`, or a `<repeat>`'s `nodeset`. */
	readonly path: string;
	readonly kind: "group" | "repeat";
	readonly appearance: string | null;
	/** A repeat's `jr:count`, present or not. */
	readonly counted: boolean;
}

/**
 * Which labels the source writes through an itext reference. The identity
 * comparison never reads it; the comparison with CommCare HQ's question
 * summary reads it to know which labels HQ summarized.
 */
export interface ControlAsWritten {
	/** Whether the control's `<label>` holds a `ref`. A `repeat` answers for the `<label>` of the
	 *  element that wraps it, as `xform.py::XForm._get_label_translations` reads it. */
	readonly labelRef: boolean;
	/** For each inline `<item>` in body order, whether its `<label>` holds a `ref`. */
	readonly itemLabelRefs: readonly boolean[];
}

export interface FormIdentity {
	readonly xmlns: string;
	/** The data root's own namespace, which must equal `xmlns`. */
	readonly dataNamespace: string;
	readonly uniqueId: string;
	readonly docType: string;
	readonly leaves: ReadonlyMap<string, AnswerLeaf>;
	readonly containers: ReadonlyMap<string, ContainerIdentity>;
	/** The paths of the leaf controls in body order. */
	readonly order: readonly string[];
	/** Every control of the body by its path, leaf and container alike. */
	readonly written: ReadonlyMap<string, ControlAsWritten>;
}

/** Why a form is left out. Each is one of the reasons a form's case blocks are
 *  left out under (`publishedCaseBlocks.ts::UnreadFormReason`), by the same name. */
export type UnreadSourceFormReason =
	| "no-xmlns"
	| "shared-xmlns"
	| "no-xform"
	| "xform-unparsed";

export interface SourceIdentity {
	readonly languages: readonly string[];
	/** Menus in order: id, document type, case type, and each form's `xmlns` in order. */
	readonly menus: readonly {
		readonly uniqueId: string;
		readonly docType: string;
		readonly caseType: string | null;
		readonly forms: readonly string[];
	}[];
	readonly forms: ReadonlyMap<string, FormIdentity>;
	/** Each form left out, with why. A source both readers read whole has none. */
	readonly unread: readonly {
		readonly menu: number;
		readonly form: number;
		readonly reason: UnreadSourceFormReason;
	}[];
}

/** The namespace of a case transaction, whose elements are no answer. */
const CASE_TRANSACTION_NS = "http://commcarehq.org/case/transaction/v2";

/** The controls a worker answers, by local name (`XFormParser.java`'s `groupLevelHandlers`). */
const LEAF_CONTROLS = new Set<AnswerLeaf["control"]>([
	"input",
	"select1",
	"select",
	"upload",
	"trigger",
	"secret",
]);

/**
 * Elements of the XForms namespace that are no control: a control's and a
 * group's texts and choices, and the actions Core runs rather than shows
 * (`XFormParser.java`'s `actionHandlers`).
 */
const NOT_CONTROLS = new Set([
	"label",
	"hint",
	"help",
	"alert",
	"item",
	"itemset",
	"value",
	"output",
	"setvalue",
	"send",
]);

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOr<T>(value: unknown, fallback: T): string | T {
	return typeof value === "string" ? value : fallback;
}

/** A form's `xmlns` where it stores one that is not blank. */
function storedXmlns(form: unknown): string | null {
	if (!isObject(form) || typeof form.xmlns !== "string") return null;
	return form.xmlns.trim() === "" ? null : form.xmlns;
}

/** A form whose XML breaks the extraction. */
class Unparsed extends Error {
	constructor(readonly why: string) {
		super(why);
	}
}

function unparsed(why: string): never {
	throw new Unparsed(why);
}

/** The identity record of `application`, an app's JSON with its `_attachments`. */
export function sourceIdentity(application: unknown): SourceIdentity {
	const forms = new Map<string, FormIdentity>();
	const unread: {
		menu: number;
		form: number;
		reason: UnreadSourceFormReason;
	}[] = [];
	if (!isObject(application))
		return { languages: [], menus: [], forms, unread };
	const languages = Array.isArray(application.langs)
		? application.langs.filter(
				(code): code is string => typeof code === "string",
			)
		: [];
	const modules = Array.isArray(application.modules) ? application.modules : [];
	const attachments = isObject(application._attachments)
		? application._attachments
		: {};

	const holders = new Map<string, number>();
	for (const module of modules) {
		if (!isObject(module) || !Array.isArray(module.forms)) continue;
		for (const form of module.forms) {
			const xmlns = storedXmlns(form);
			if (xmlns !== null) holders.set(xmlns, (holders.get(xmlns) ?? 0) + 1);
		}
	}

	const menus = modules.map((module, menu) => {
		const moduleForms =
			isObject(module) && Array.isArray(module.forms) ? module.forms : [];
		moduleForms.forEach((form: unknown, position: number) => {
			const reason = readForm(form, holders, attachments, forms);
			if (reason !== undefined) unread.push({ menu, form: position, reason });
		});
		return {
			uniqueId: isObject(module) ? stringOr(module.unique_id, "") : "",
			docType: isObject(module) ? stringOr(module.doc_type, "") : "",
			caseType: isObject(module) ? stringOr(module.case_type, null) : null,
			forms: moduleForms.map((form: unknown) => storedXmlns(form) ?? ""),
		};
	});
	return { languages, menus, forms, unread };
}

/**
 * Reads one form into `forms`, keyed by its `xmlns`, or answers why it is
 * left out.
 */
function readForm(
	form: unknown,
	holders: ReadonlyMap<string, number>,
	attachments: JsonObject,
	forms: Map<string, FormIdentity>,
): UnreadSourceFormReason | undefined {
	const xmlns = storedXmlns(form);
	if (xmlns === null) return "no-xmlns";
	if ((holders.get(xmlns) ?? 0) > 1) return "shared-xmlns";
	const uniqueId = isObject(form) ? stringOr(form.unique_id, "") : "";
	const xml = uniqueId === "" ? undefined : attachments[`${uniqueId}.xml`];
	if (typeof xml !== "string") return "no-xform";
	try {
		forms.set(xmlns, {
			xmlns,
			uniqueId,
			docType: isObject(form) ? stringOr(form.doc_type, "") : "",
			...heldFormIdentity(xml),
		});
		return undefined;
	} catch (error) {
		if (error instanceof Unparsed) return "xform-unparsed";
		throw error;
	}
}

interface Scoped {
	readonly element: Element;
	readonly scope: NamespaceScope;
}

function childrenOf(parent: Scoped): Scoped[] {
	return elementChildren(parent.element.children, parent.scope);
}

function childNamed(parent: Scoped, uri: string, local: string): Scoped[] {
	return childrenOf(parent).filter(({ element, scope }) =>
		isElement(element, scope, uri, local),
	);
}

/** The text an element's own text nodes hold (`xmlParse.ts` reads CDATA as text). */
function ownText(element: Element): string {
	return element.children
		.map((child) => (isText(child) ? child.data : ""))
		.join("");
}

/** An attribute in no namespace, or null. */
function plainAttribute(element: Element, name: string): string | null {
	return Object.hasOwn(element.attribs, name)
		? (element.attribs[name] as string)
		: null;
}

/** `path` resolved against `context`, as `xform.py::XForm.resolve_path` resolves it. */
function resolvePath(path: string, context: string): string {
	return path.startsWith("/") ? path : `${context}/${path}`;
}

type FormRecord = Omit<FormIdentity, "xmlns" | "uniqueId" | "docType">;

/** Each form text's record, or why it does not parse (`heldByText.ts`). */
const heldRecords = new HeldByText<FormRecord | Unparsed>(
	FORM_TEXTS_HELD_CHARACTERS,
);

function heldFormIdentity(xml: string): FormRecord {
	const held = heldRecords.of(xml, (text) => {
		try {
			return Object.freeze(formIdentity(text));
		} catch (error) {
			if (error instanceof Unparsed) return error;
			throw error;
		}
	});
	if (held instanceof Unparsed) throw held;
	return held;
}

/** One form's record from its XML; throws `Unparsed` where the XML breaks a step. */
function formIdentity(xml: string): FormRecord {
	const parsed = heldXmlParse(xml);
	if ("issue" in parsed) unparsed("the XML does not parse");
	const [html, ...others] = elementChildren(parsed.doc.children, new Map());
	if (
		html === undefined ||
		others.length > 0 ||
		!isElement(html.element, html.scope, XHTML_NS, "html")
	)
		unparsed("the root is no h:html");
	const head = childNamed(html, XHTML_NS, "head")[0];
	const model = head && childNamed(head, XFORMS_NS, "model")[0];
	if (model === undefined) unparsed("there is no model");
	const instance = childNamed(model, XFORMS_NS, "instance").find(
		({ element }) => plainAttribute(element, "id") === null,
	);
	const roots = instance === undefined ? [] : childrenOf(instance);
	const root = roots[0];
	if (root === undefined || roots.length !== 1)
		unparsed("the primary instance holds no single data root");
	const rootName = splitName(root.element.name).local;

	// The data root reads as `data` whatever it is named.
	const normalize = (path: string): string => {
		const prefix = `/${rootName}`;
		if (path === prefix) return "/data";
		return path.startsWith(`${prefix}/`)
			? `/data${path.slice(prefix.length)}`
			: path;
	};

	// Step 1: the model's leaves.
	const leafPaths: string[] = [];
	const walkData = (parent: Scoped, path: string): void => {
		for (const child of childrenOf(parent)) {
			if (elementNamespace(child.element, child.scope) === CASE_TRANSACTION_NS)
				continue;
			const childPath = `${path}/${splitName(child.element.name).local}`;
			if (childrenOf(child).length === 0) leafPaths.push(childPath);
			else walkData(child, childPath);
		}
	};
	walkData(root, "/data");

	// Step 2: each bind's type, by its resolved nodeset; a later bind of one
	// node replaces an earlier one, as Core attaches binds in order.
	const binds = childNamed(model, XFORMS_NS, "bind");
	const typeOf = new Map<string, string | null>();
	const bindPaths = new Map<string, string>();
	for (const { element } of binds) {
		const nodeset = plainAttribute(element, "nodeset");
		if (nodeset === null) continue;
		const path = normalize(resolvePath(nodeset, ""));
		typeOf.set(path, plainAttribute(element, "type"));
		const id = plainAttribute(element, "id");
		if (id !== null && !bindPaths.has(id)) bindPaths.set(id, path);
	}

	interface LeafDraft {
		repeats: string[];
		control: AnswerLeaf["control"];
		mediatype: string | null;
		appearance: string | null;
		choices: string[] | null;
		itemset: boolean;
	}
	const drafts = new Map<string, LeafDraft>();
	for (const path of leafPaths)
		drafts.set(path, {
			repeats: [],
			control: "none",
			mediatype: null,
			appearance: null,
			choices: null,
			itemset: false,
		});

	const containers = new Map<string, ContainerIdentity>();
	const order: string[] = [];
	const written = new Map<string, ControlAsWritten>();
	const labelRef = (owner: Scoped | undefined): boolean => {
		if (owner === undefined) return false;
		const label = childNamed(owner, XFORMS_NS, "label")[0];
		return label !== undefined && plainAttribute(label.element, "ref") !== null;
	};

	// Step 3: the body, in document order.
	const walkBody = (
		parent: Scoped,
		context: string,
		wrapper: Scoped | undefined,
	): void => {
		for (const child of childrenOf(parent)) {
			if (elementNamespace(child.element, child.scope) !== XFORMS_NS) continue;
			const local = splitName(child.element.name).local;
			if (NOT_CONTROLS.has(local)) continue;
			const appearance = plainAttribute(child.element, "appearance");
			if (local === "group") {
				const ref =
					plainAttribute(child.element, "ref") ??
					plainAttribute(child.element, "nodeset");
				if (ref === null) {
					walkBody(child, context, child);
					continue;
				}
				const path = normalize(resolvePath(ref, context));
				addContainer({ path, kind: "group", appearance, counted: false });
				written.set(path, { labelRef: labelRef(child), itemLabelRefs: [] });
				walkBody(child, path, child);
				continue;
			}
			if (local === "repeat") {
				const nodeset = plainAttribute(child.element, "nodeset");
				if (nodeset === null) unparsed("a repeat has no nodeset");
				const path = normalize(resolvePath(nodeset, context));
				addContainer({
					path,
					kind: "repeat",
					appearance,
					counted:
						namespacedAttribute(
							child.element,
							child.scope,
							JAVAROSA_NS,
							"count",
						) !== undefined,
				});
				written.set(path, { labelRef: labelRef(wrapper), itemLabelRefs: [] });
				walkBody(child, path, child);
				continue;
			}
			if (!LEAF_CONTROLS.has(local as AnswerLeaf["control"]))
				unparsed("the body holds an element that is no control Core reads");
			const ref = plainAttribute(child.element, "ref");
			const bind = plainAttribute(child.element, "bind");
			const path =
				ref !== null
					? normalize(resolvePath(ref, context))
					: bind !== null
						? bindPaths.get(bind)
						: undefined;
			if (path === undefined) unparsed("a control names no node");
			const draft = drafts.get(path);
			if (draft === undefined) unparsed("a control's path names no leaf");
			if (draft.control !== "none") unparsed("two controls name one leaf");
			const items = childNamed(child, XFORMS_NS, "item");
			draft.control = local as AnswerLeaf["control"];
			draft.mediatype =
				local === "upload" ? plainAttribute(child.element, "mediatype") : null;
			draft.appearance = appearance;
			draft.choices =
				items.length === 0
					? null
					: items.map((item) => {
							const value = childNamed(item, XFORMS_NS, "value")[0];
							return value === undefined ? "" : ownText(value.element).trim();
						});
			draft.itemset = childNamed(child, XFORMS_NS, "itemset").length > 0;
			order.push(path);
			written.set(path, {
				labelRef: labelRef(child),
				itemLabelRefs: items.map((item) => labelRef(item)),
			});
		}
	};
	const addContainer = (container: ContainerIdentity): void => {
		if (containers.has(container.path))
			unparsed("two groups or repeats name one path");
		containers.set(container.path, container);
	};
	const body = childNamed(html, XHTML_NS, "body")[0];
	if (body !== undefined) walkBody(body, "/data", body);

	const repeatPaths = [...containers.values()]
		.filter((container) => container.kind === "repeat")
		.map((container) => container.path)
		.sort((a, b) => a.length - b.length);
	const leaves = new Map<string, AnswerLeaf>();
	for (const [path, draft] of drafts)
		leaves.set(path, {
			path,
			repeats: repeatPaths.filter((repeat) => path.startsWith(`${repeat}/`)),
			control: draft.control,
			typeClass: coreTypeClass(typeOf.get(path) ?? null),
			mediatype: draft.mediatype,
			appearance: draft.appearance,
			choices: draft.choices,
			itemset: draft.itemset,
		});

	return {
		dataNamespace: elementNamespace(root.element, root.scope) ?? "",
		leaves,
		containers,
		order,
		written,
	};
}
