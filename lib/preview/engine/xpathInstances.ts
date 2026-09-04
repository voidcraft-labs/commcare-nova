import type { CaseIndexRow } from "@/lib/case-store";
import { lookupFixtureCellText } from "@/lib/commcare/lookup/cellText";
import { COMMCARE_SESSION_CONTEXT_FIELDS } from "@/lib/commcare/sessionContext";
import {
	type CasePropertyDataType,
	type CaseType,
	USERCASE_CASE_TYPE,
} from "@/lib/domain";
import { openJdk17DoubleToString } from "@/lib/preview/xpath/openJdk17DoubleString";
import {
	type XPathInstance,
	type XPathNode,
	XPathNodeSet,
} from "@/lib/preview/xpath/runtimeValues";
import { XPathDate, type XPathValue } from "@/lib/preview/xpath/types";
import type { CaseRow, JsonValue } from "./caseDataBindingTypes";
import {
	type PreviewSearchSessionValues,
	previewSessionValues,
	type ResolvedPreviewIdentity,
} from "./identity";
import type { PreviewLookupData } from "./lookupEvaluation";

/** The complete set of case rows the selected worker's restore would place on
 * their device. Rows are already authorization- and restore-scoped server-side;
 * this client shape deliberately carries no Project or actor identifier. */
export interface CaseDatabaseSnapshot {
	readonly rows: readonly CaseRow[];
	readonly indices: readonly CaseIndexRow[];
	/** Stored-schema types survive case-type retirement and let Preview preserve
	 * the exact Java lexical form of typed JSONB values. */
	readonly propertyTypes?: Readonly<
		Record<string, Readonly<Record<string, CasePropertyDataType>>>
	>;
}

export type LoadCaseDatabaseSnapshotResult =
	| { readonly kind: "data"; readonly snapshot: CaseDatabaseSnapshot }
	| { readonly kind: "persona-unavailable"; readonly message: string }
	| { readonly kind: "unauthenticated" }
	| { readonly kind: "error"; readonly message: string };

interface ElementSpec {
	readonly name: string;
	readonly value?: XPathValue;
	readonly attributes?: Readonly<Record<string, XPathValue>>;
	readonly attributeTemplates?: readonly string[];
	readonly children?: readonly ElementSpec[];
	/** Schema-known children that may have zero material occurrences. */
	readonly childTemplates?: readonly string[];
	readonly templateChildren?: readonly ElementSpec[];
}

/** Immutable structural instance used for server-projected secondary data.
 * The root is virtual, matching JavaRosa's TreeElement instance wrapper: an
 * XPath beginning `/session` or `/casedb` selects its one document element. */
class StaticXPathInstance implements XPathInstance {
	readonly id: string;
	private readonly rootNode: StaticXPathNode;

	constructor(id: string, document: ElementSpec) {
		this.id = id;
		this.rootNode = new StaticXPathNode({
			instance: this,
			name: "",
			path: "/",
			multiplicity: 0,
			children: [document],
		});
	}

	root(): XPathNode {
		return this.rootNode;
	}
}

class StaticXPathNode implements XPathNode {
	readonly instanceId: string;
	readonly path: string;
	readonly name: string;
	readonly kind: "element" | "attribute";
	readonly multiplicity: number;
	private readonly scalar: XPathValue;
	private readonly childSpecs: readonly ElementSpec[];
	private readonly childTemplates: ReadonlySet<string>;
	private readonly templateChildSpecs: readonly ElementSpec[];
	private readonly attributeSpecs: Readonly<Record<string, XPathValue>>;
	private readonly attributeTemplates: ReadonlySet<string>;
	private readonly parentNode?: StaticXPathNode;
	private readonly instance: StaticXPathInstance;

	constructor(args: {
		readonly instance: StaticXPathInstance;
		readonly name: string;
		readonly path: string;
		readonly multiplicity: number;
		readonly kind?: "element" | "attribute";
		readonly value?: XPathValue;
		readonly children?: readonly ElementSpec[];
		readonly childTemplates?: readonly string[];
		readonly templateChildren?: readonly ElementSpec[];
		readonly attributes?: Readonly<Record<string, XPathValue>>;
		readonly attributeTemplates?: readonly string[];
		readonly parent?: StaticXPathNode;
	}) {
		this.instance = args.instance;
		this.instanceId = args.instance.id;
		this.name = args.name;
		this.path = args.path;
		this.multiplicity = args.multiplicity;
		this.kind = args.kind ?? "element";
		this.scalar = args.value ?? "";
		this.childSpecs = args.children ?? [];
		this.childTemplates = new Set(args.childTemplates ?? []);
		this.templateChildSpecs = args.templateChildren ?? [];
		this.attributeSpecs = args.attributes ?? {};
		this.attributeTemplates = new Set(args.attributeTemplates ?? []);
		this.parentNode = args.parent;
	}

	value(): XPathValue {
		return this.scalar;
	}

	parent(): XPathNode | undefined {
		return this.parentNode;
	}

	children(name?: string): readonly XPathNode[] {
		const multiplicities = new Map<string, number>();
		const nodes: XPathNode[] = [];
		for (const child of this.childSpecs) {
			const multiplicity = multiplicities.get(child.name) ?? 0;
			multiplicities.set(child.name, multiplicity + 1);
			if (name !== undefined && name !== "*" && child.name !== name) continue;
			const base =
				this.path === "/" ? `/${child.name}` : `${this.path}/${child.name}`;
			nodes.push(
				new StaticXPathNode({
					instance: this.instance,
					name: child.name,
					path: multiplicity === 0 ? base : `${base}[${multiplicity}]`,
					multiplicity,
					value: child.value,
					children: child.children,
					childTemplates: child.childTemplates,
					templateChildren: child.templateChildren,
					attributes: child.attributes,
					attributeTemplates: child.attributeTemplates,
					parent: this,
				}),
			);
		}
		return nodes;
	}

	templateChildren(name?: string): readonly XPathNode[] {
		/* A no-name read is the structured-clone schema inventory, not a runtime
		 * selection. Return declared templates independently of concrete children
		 * so a wildcard casedb index template survives beside an existing `parent`
		 * index. Named reads retain ordinary JavaRosa selection semantics. */
		if (name === undefined) return this.templateNodes();
		const actual = this.children(name);
		if (actual.length > 0) return actual;
		return this.templateNodes(name);
	}

	private templateNodes(name?: string): readonly XPathNode[] {
		return this.templateChildSpecs
			.filter(
				(spec) =>
					name === undefined ||
					name === "*" ||
					spec.name === name ||
					spec.name === "*",
			)
			.map((spec) => {
				const nodeName =
					spec.name === "*" && name !== undefined ? name : spec.name;
				const base =
					this.path === "/" ? `/${nodeName}` : `${this.path}/${nodeName}`;
				return new StaticXPathNode({
					instance: this.instance,
					name: nodeName,
					path: base,
					multiplicity: 0,
					value: spec.value,
					children: spec.children,
					childTemplates: spec.childTemplates,
					templateChildren: spec.templateChildren,
					attributes: spec.attributes,
					attributeTemplates: spec.attributeTemplates,
					parent: this,
				});
			});
	}

	attributes(name?: string): readonly XPathNode[] {
		return Object.entries(this.attributeSpecs)
			.filter(([attributeName]) =>
				name === undefined || name === "*" ? true : attributeName === name,
			)
			.map(
				([attributeName, value]) =>
					new StaticXPathNode({
						instance: this.instance,
						name: attributeName,
						path: `${this.path}/@${attributeName}`,
						multiplicity: 0,
						kind: "attribute",
						value,
						parent: this,
					}),
			);
	}

	templateAttributes(name?: string): readonly XPathNode[] {
		const actual = this.attributes(name);
		if (actual.length > 0) return actual;
		return [...this.attributeTemplates]
			.filter(
				(attributeName) =>
					name === undefined || name === "*" || attributeName === name,
			)
			.map(
				(attributeName) =>
					new StaticXPathNode({
						instance: this.instance,
						name: attributeName,
						path: `${this.path}/@${attributeName}`,
						multiplicity: 0,
						kind: "attribute",
						parent: this,
					}),
			);
	}

	childTemplateNames(): readonly string[] {
		return [...this.childTemplates];
	}

	attributeTemplateNames(): readonly string[] {
		return [...this.attributeTemplates];
	}

	hasChildTemplate(name?: string): boolean {
		return (
			(name === undefined || name === "*"
				? this.childTemplates.size > 0
				: this.childTemplates.has("*") || this.childTemplates.has(name)) ||
			this.childSpecs.some(
				(child) => name === undefined || name === "*" || child.name === name,
			) ||
			this.templateChildSpecs.some(
				(child) =>
					name === undefined ||
					name === "*" ||
					child.name === "*" ||
					child.name === name,
			)
		);
	}

	hasAttributeTemplate(name?: string): boolean {
		return (
			(name === undefined || name === "*"
				? this.attributeTemplates.size > 0
				: this.attributeTemplates.has(name)) ||
			Object.keys(this.attributeSpecs).some(
				(attributeName) =>
					name === undefined || name === "*" || attributeName === name,
			)
		);
	}

	isRelevant(): boolean {
		return true;
	}
}

function jsonXPathValue(
	value: JsonValue,
	dataType: CasePropertyDataType | undefined,
): XPathValue {
	if (value === null) return "";
	if (Array.isArray(value)) return value.map(String).join(" ");
	if (typeof value === "object") return JSON.stringify(value);
	/* Case XML stores custom properties as lexical element text. JSONB keeps
	 * Nova's authored scalar type, but casedb is the post-serialization device
	 * instance: numbers and booleans therefore arrive as strings just like
	 * values parsed from an XML restore. */
	return dataType === "decimal" && typeof value === "number"
		? openJdk17DoubleToString(value)
		: String(value);
}

function caseDateValue(value: Date | string | null): XPathValue {
	if (value === null) return "";
	const parsed = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(parsed.getTime())) return "";
	/* Core exposes both casedb values through DateData. DateData.getValue()
	 * rounds its backing Date before XPath sees it, so these are calendar dates,
	 * not DateTimeData values carrying the database timestamp. */
	return XPathDate.fromJSDateOnly(parsed);
}

const CASE_ATTRIBUTE_TEMPLATES = [
	"case_id",
	"case_type",
	"owner_id",
	"status",
	"external_id",
	"category",
	"state",
] as const;

function caseTemplate(): ElementSpec {
	return {
		name: "case",
		childTemplates: ["*"],
		attributeTemplates: CASE_ATTRIBUTE_TEMPLATES,
		children: [
			{ name: "case_name" },
			{ name: "date_opened" },
			{ name: "last_modified" },
			{ name: "index", childTemplates: ["*"] },
			{ name: "attachment", childTemplates: ["*"] },
		],
	};
}

function caseElement(
	row: CaseRow,
	indices: readonly CaseIndexRow[],
	propertyTypes: ReadonlyMap<string, CasePropertyDataType>,
): ElementSpec {
	const properties = Object.entries(row.properties).map(
		([name, value]): ElementSpec => ({
			name,
			value: jsonXPathValue(value, propertyTypes.get(name)),
		}),
	);
	return {
		name: "case",
		// casedb properties and case-index identifiers are dynamic XML names.
		// Authoring validates them against the Blueprint; runtime absence must
		// still be a valid empty nodeset rather than an invalid path.
		childTemplates: ["*"],
		attributes: {
			case_id: row.case_id,
			case_type: row.case_type,
			owner_id: row.owner_id ?? "",
			status: row.status ?? "open",
			...(row.external_id === null ? {} : { external_id: row.external_id }),
			// Core also carries category/state as separate case metadata. Nova's
			// case row has no corresponding persisted values, so their template
			// attributes remain valid while live rows honestly leave them absent.
		},
		attributeTemplates: CASE_ATTRIBUTE_TEMPLATES,
		children: [
			{ name: "case_name", value: row.case_name },
			{ name: "date_opened", value: caseDateValue(row.opened_on) },
			{
				name: "last_modified",
				value: caseDateValue(row.modified_on),
			},
			...properties,
			{
				name: "index",
				childTemplates: ["*"],
				templateChildren: [
					{
						name: "*",
						attributeTemplates: ["case_type", "relationship"],
					},
				],
				children: indices.map((index) => ({
					name: index.identifier,
					value: index.ancestor_id,
					attributes: {
						case_type: index.target_case_type,
						relationship: index.relationship,
					},
				})),
			},
			{ name: "attachment", childTemplates: ["*"] },
		],
	};
}

/** Project the selected worker's device-scoped case rows and direct index
 * edges to Core's casedb shape. Both parent and custom authored identifiers
 * come from the tenant-bound case-store snapshot; the client infers none. */
export function caseDatabaseXPathInstance(
	snapshot: CaseDatabaseSnapshot | null,
	caseTypes: readonly CaseType[] = [],
): XPathInstance {
	const rows = snapshot?.rows ?? [];
	const propertyTypesByCaseType = new Map(
		caseTypes.map((caseType) => [
			caseType.name,
			new Map(
				caseType.properties.map((property) => [
					property.name,
					property.data_type ?? "text",
				]),
			),
		]),
	);
	const storedPropertyTypesByCaseType = new Map(
		Object.entries(snapshot?.propertyTypes ?? {}).map(
			([caseType, properties]) => [
				caseType,
				new Map(Object.entries(properties)),
			],
		),
	);
	const propertyTypesFor = (caseType: string) =>
		new Map([
			...(propertyTypesByCaseType.get(caseType) ?? new Map()),
			...(storedPropertyTypesByCaseType.get(caseType) ?? new Map()),
		]);
	const indicesByCaseId = new Map<string, CaseIndexRow[]>();
	for (const index of snapshot?.indices ?? []) {
		const current = indicesByCaseId.get(index.case_id) ?? [];
		current.push(index);
		indicesByCaseId.set(index.case_id, current);
	}
	return new StaticXPathInstance("casedb", {
		name: "casedb",
		childTemplates: ["case"],
		templateChildren: [caseTemplate()],
		children: rows.map((row) =>
			caseElement(
				row,
				indicesByCaseId.get(row.case_id) ?? [],
				propertyTypesFor(row.case_type),
			),
		),
	});
}

/** Project the browser/server-shared identity into the session instance. */
export function commcareSessionXPathInstance(
	identity: ResolvedPreviewIdentity | PreviewSearchSessionValues | null,
	data: Readonly<Record<string, string>> = {},
): XPathInstance {
	const session =
		identity !== null && "context" in identity
			? identity
			: previewSessionValues(identity);
	const children = (record: Readonly<Record<string, string | undefined>>) =>
		Object.entries(record).flatMap(([name, value]) =>
			value === undefined ? [] : [{ name, value }],
		);
	return new StaticXPathInstance("commcaresession", {
		name: "session",
		children: [
			{
				name: "context",
				childTemplates: COMMCARE_SESSION_CONTEXT_FIELDS,
				children: children(session.context),
			},
			{
				name: "user",
				children: [
					{
						name: "data",
						childTemplates: ["*"],
						children: children(session.user),
					},
				],
			},
			{ name: "data", childTemplates: ["*"], children: children(data) },
		],
	});
}

/** Build every XForm-local lookup instance (`instance('<tag>')`) from the
 * exact lookup snapshot the engine captured at activation. */
export function lookupXPathInstances(
	data: PreviewLookupData | null,
	options: { readonly includeFixtureAliases?: boolean } = {},
): ReadonlyMap<string, XPathInstance> {
	if (data === null) return new Map();
	return new Map(
		data.naming.tables.flatMap((table) => {
			const rows = data.rowsByTable.get(table.tableId) ?? [];
			const create = (instanceId: string) =>
				new StaticXPathInstance(instanceId, {
					name: table.listElementName,
					childTemplates: [table.rowElementName],
					templateChildren: [
						{
							name: table.rowElementName,
							childTemplates: table.columns.map((column) => column.wireName),
						},
					],
					children: rows.map((row) => ({
						name: table.rowElementName,
						childTemplates: table.columns.map((column) => column.wireName),
						children: table.columns.map((column) => ({
							name: column.wireName,
							value: lookupFixtureCellText(
								column.dataType,
								row.values[column.id],
							),
						})),
					})),
				});
			return [
				[table.xformInstanceId, create(table.xformInstanceId)] as const,
				...(options.includeFixtureAliases
					? ([[table.fixtureId, create(table.fixtureId)] as const] as const)
					: []),
			];
		}),
	);
}

/** One resolver map for a form engine's immutable evaluation world. */
export function secondaryXPathInstances(args: {
	readonly identity: ResolvedPreviewIdentity | null;
	readonly lookupData: PreviewLookupData | null;
	readonly caseDatabase: CaseDatabaseSnapshot | null;
	readonly caseTypes?: readonly CaseType[];
	readonly sessionData?: Readonly<Record<string, string>>;
	/** Present only for an admitted no-matches registration form. */
	readonly searchAnswers?: ReadonlyMap<string, string>;
}): ReadonlyMap<string, XPathInstance> {
	return new Map<string, XPathInstance>([
		[
			"commcaresession",
			commcareSessionXPathInstance(args.identity, args.sessionData),
		],
		[
			"casedb",
			caseDatabaseXPathInstance(args.caseDatabase, args.caseTypes ?? []),
		],
		...lookupXPathInstances(args.lookupData),
		...(args.searchAnswers === undefined
			? []
			: [
					[
						INLINE_SEARCH_INPUT_INSTANCE_ID,
						searchInputXPathInstance(args.searchAnswers),
					] as const,
				]),
	]);
}

/** The inline search's answers instance, `search-input:results:inline`. */
export const INLINE_SEARCH_INPUT_INSTANCE_ID = "search-input:results:inline";

/**
 * The device's search-input instance for a completed inline search
 * (`RemoteQuerySessionManager.getEvaluationContextWithUserInputInstance`):
 * `<input><field name="<prompt>">value</field>…</input>`, one field per
 * answered prompt. A no-matches form's `#search/<name>` reads print as
 * `instance('search-input:results:inline')/input/field[@name='<name>']` on
 * the wire, so the same path resolves here.
 */
export function searchInputXPathInstance(
	answers: ReadonlyMap<string, string>,
): XPathInstance {
	return new StaticXPathInstance(INLINE_SEARCH_INPUT_INSTANCE_ID, {
		name: "input",
		childTemplates: ["field"],
		children: [...answers].map(([name, value]) => ({
			name: "field",
			value,
			attributes: { name },
		})),
	});
}

/**
 * Resolve Nova's identity-bearing hashtags against the same casedb nodes the
 * emitted XPath selects. Returning a nodeset matters even when one scalar is
 * expected: JavaRosa functions such as count() and boolean() observe node
 * identity and cardinality before scalar coercion.
 *
 * Undefined means that the structural projection is unavailable and the
 * caller should retain its scalar fallback. That fallback is intentional for
 * the best-effort usercase path and for narrow unit fixtures that do not carry
 * a device database snapshot.
 */
export function previewHashtagNodeSet(
	reference: string,
	args: {
		readonly casedb: XPathInstance | undefined;
		readonly caseData: ReadonlyMap<string, ReadonlyMap<string, string>>;
		readonly userId: string | undefined;
		/** The `search-input:results:inline` instance of an admitted
		 *  no-matches form; absent when the form runs without one. */
		readonly searchInputs?: XPathInstance | undefined;
	},
): XPathNodeSet | undefined {
	if (reference.startsWith("#search/")) {
		/* A search answer is a field of the search-input instance, the node the
		 * wire's `instance('search-input:results:inline')/input/field[@name]`
		 * selects, so `count()` and predicates see a prompt the search left
		 * blank as no node. Without the instance the engine's scalar resolver
		 * answers blank. */
		if (args.searchInputs === undefined) return undefined;
		const name = reference.slice("#search/".length);
		const fields =
			args.searchInputs.root().children("input")[0]?.children("field") ?? [];
		return new XPathNodeSet(
			fields.filter((node) => nodeAttributeValue(node, "name") === name),
			true,
		);
	}
	const casedb = args.casedb;
	if (casedb === undefined) return undefined;
	const cases = casedb.root().children("casedb")[0]?.children("case") ?? [];

	if (reference.startsWith("#user/")) {
		if (args.userId === undefined) return new XPathNodeSet([], true);
		const property = reference.slice("#user/".length);
		const usercases = cases.filter(
			(node) =>
				nodeAttributeValue(node, "case_type") === USERCASE_CASE_TYPE &&
				nodeChildValue(node, "hq_user_id") === args.userId,
		);
		if (usercases.length === 0) return undefined;
		return new XPathNodeSet(
			usercases.flatMap((node) => [...node.children(property)]),
			true,
		);
	}

	const match = /^#([^/]+)\/(.+)$/.exec(reference);
	if (match === null || match[1] === "form" || match[1] === "case") {
		return undefined;
	}
	const namespace = match[1] ?? "";
	const property = match[2] ?? "";
	const namespaceData = args.caseData.get(namespace);
	if (namespaceData === undefined) return new XPathNodeSet([], true);
	const caseId = namespaceData.get("case_id");
	if (caseId === undefined) return undefined;
	const selected = cases.filter(
		(node) => nodeAttributeValue(node, "case_id") === caseId,
	);
	return new XPathNodeSet(
		selected.flatMap((node) =>
			property === "case_id"
				? [...node.attributes("case_id")]
				: [...node.children(property)],
		),
		true,
	);
}

function nodeAttributeValue(node: XPathNode, name: string): string | undefined {
	const value = node.attributes(name)[0]?.value();
	return value === undefined ? undefined : String(value);
}

function nodeChildValue(node: XPathNode, name: string): string | undefined {
	const value = node.children(name)[0]?.value();
	return value === undefined ? undefined : String(value);
}

/** Locate one concrete main-instance node for `.` / `current()` context. */
export function xpathNodeAtPath(
	instance: XPathInstance,
	path: string,
): XPathNode | undefined {
	const visit = (node: XPathNode): XPathNode | undefined => {
		if (node.path === path) return node;
		for (const child of node.children()) {
			const found = visit(child);
			if (found !== undefined) return found;
		}
		return undefined;
	};
	return visit(instance.root());
}
