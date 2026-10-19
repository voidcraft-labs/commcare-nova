import type { CaseIndexRow } from "@/lib/case-store";
import { lookupFixtureCellText } from "@/lib/commcare/lookup/cellText";
import { INLINE_SEARCH_RESULTS_INSTANCE } from "@/lib/commcare/session";
import { COMMCARE_SESSION_CONTEXT_FIELDS } from "@/lib/commcare/sessionContext";
import {
	type BlueprintDoc,
	type CasePropertyDataType,
	type CaseType,
	expressionSlotValues,
	type OrganizationCollections,
	orderedLocationProperties,
	orderedOrganizationLevels,
	type Uuid,
} from "@/lib/domain";
import { openJdk17DoubleToString } from "@/lib/domain/expression/openJdk17DoubleString";
import type { Expression } from "@/lib/domain/expression/types";
import { walkExpressionNodes } from "@/lib/domain/expression/walk";
import type {
	XPathInstance,
	XPathNode,
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
	/** The worker's `locations` fixture: every place their device can name
	 * (`lib/organization/footprint.ts::personaFootprint`). It travels with the
	 * device's cases because a restore delivers both. Absent where nothing
	 * read the organization; empty for a worker assigned nowhere. */
	readonly locations?: readonly PreviewLocationRow[];
}

/** One place in the worker's flat location fixture, as plain JSON. */
export interface PreviewLocationRow {
	readonly id: string;
	readonly levelUuid: string;
	readonly siteCode: string;
	readonly name: string;
	readonly externalId: string | null;
	/** Exact decimal text; a coordinate is never a float here. */
	readonly latitude: string | null;
	readonly longitude: string | null;
	/** Place information keyed by location-property UUID. */
	readonly values: Readonly<Record<string, string>>;
	/** Level UUID → the id of this place's ancestor at that level, read
	 * from the whole place tree, as HQ walks a place's parents. */
	readonly lineage: Readonly<Record<string, string>>;
}

/** One case a completed search found, as plain JSON. */
export interface SearchResultRow {
	readonly case_id: string;
	readonly case_type: string;
	readonly owner_id: string | null;
	readonly case_name: string | null;
	/** ISO instants. */
	readonly opened_on: string | null;
	readonly modified_on: string | null;
	readonly external_id: string | null;
	readonly properties: Readonly<Record<string, JsonValue>>;
	readonly indices: readonly {
		readonly identifier: string;
		readonly ancestor_id: string;
		readonly target_case_type: string;
		readonly relationship: string;
	}[];
}

/** What a completed search returned to the forms of its module: the first
 * `SEARCH_RESULTS_CAP` open matches in Results' order, and how many
 * matched in all. */
export interface SearchResultsSnapshot {
	readonly rows: readonly SearchResultRow[];
	readonly totalMatches: number;
}

export type LoadSearchResultsSnapshotResult =
	| { readonly kind: "data"; readonly snapshot: SearchResultsSnapshot }
	| { readonly kind: "invalid-search"; readonly message: string }
	| { readonly kind: "persona-unavailable"; readonly message: string }
	| { readonly kind: "unauthenticated" }
	| { readonly kind: "error"; readonly message: string };

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
	return XPathDate.localDateOf(parsed.getTime());
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
			// Core also copies external_id from Case.data into a child element.
			...(row.external_id === null
				? []
				: [{ name: "external_id", value: row.external_id }]),
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

/**
 * The selected-entities instance a several-case datum fills
 * (`org/commcare/data/xml/VirtualInstances.java::buildSelectedValuesInstance`):
 * `<results><value>id</value>…</results>` in selection order, under the
 * datum's own id, which the form declares as the instance id.
 */
export function selectedCasesXPathInstance(
	datumId: string,
	caseIds: readonly string[],
): XPathInstance {
	return new StaticXPathInstance(datumId, {
		name: "results",
		childTemplates: ["value"],
		children: caseIds.map((caseId) => ({ name: "value", value: caseId })),
	});
}

const LOCATION_FIXTURE_FIELDS = [
	"name",
	"site_code",
	"external_id",
	"latitude",
	"longitude",
	"location_type",
	"supply_point_id",
] as const;

/** `numeric(20,10)` text, as HQ's `DecimalField(decimal_places=10)` reads
 * back and `str()` prints it. */
function hqCoordinateText(value: string | null): string {
	if (value === null) return "";
	const negative = value.startsWith("-");
	const unsigned = negative ? value.slice(1) : value;
	const [whole = "0", fraction = ""] = unsigned.split(".");
	return `${negative ? "-" : ""}${whole}.${fraction.padEnd(10, "0").slice(0, 10)}`;
}

/** Code-point order, the order a `site_code` sort gives ASCII codes. */
function bySiteCode(a: PreviewLocationRow, b: PreviewLocationRow): number {
	return a.siteCode < b.siteCode ? -1 : a.siteCode > b.siteCode ? 1 : 0;
}

/**
 * HQ's flat location fixture for one worker
 * (`corehq/apps/locations/fixtures.py::FlatLocationSerializer._get_fixture_node`):
 * `<locations>` with one `<location type id <code>_id…>` per place, ordered
 * by site code, an `@<code>_id` for every level of the organization (the
 * place's own and its ancestors' filled, the rest empty), then `name`,
 * `site_code`, `external_id`, `latitude`, `longitude`, `location_type` (the
 * level's NAME, as `str(LocationType)` prints it), `supply_point_id` and
 * `location_data` with one child per place-information field, empty where
 * the place holds none (`::_fill_in_location_element`, `::_get_metadata_node`).
 * A worker assigned nowhere gets an empty `<locations>`.
 */
export function locationsXPathInstance(
	rows: readonly PreviewLocationRow[],
	organization: OrganizationCollections,
): XPathInstance {
	const levels = orderedOrganizationLevels(organization);
	const levelByUuid = new Map<string, (typeof levels)[number]>(
		levels.map((level) => [level.uuid, level]),
	);
	const properties = orderedLocationProperties(organization);
	const levelAttributes = levels.map((level) => `${level.code}_id`);
	const locationTemplate = {
		name: "location",
		attributeTemplates: ["type", "id", ...levelAttributes],
		childTemplates: [...LOCATION_FIXTURE_FIELDS, "location_data"],
	};
	return new StaticXPathInstance("locations", {
		name: "locations",
		childTemplates: ["location"],
		templateChildren: [locationTemplate],
		children: [...rows].sort(bySiteCode).flatMap((row): ElementSpec[] => {
			const level = levelByUuid.get(row.levelUuid);
			if (level === undefined) return [];
			const text: Record<(typeof LOCATION_FIXTURE_FIELDS)[number], string> = {
				name: row.name,
				site_code: row.siteCode,
				external_id: row.externalId ?? "",
				latitude: hqCoordinateText(row.latitude),
				longitude: hqCoordinateText(row.longitude),
				location_type: level.name,
				supply_point_id: "",
			};
			return [
				{
					...locationTemplate,
					attributes: {
						type: level.code,
						id: row.id,
						...Object.fromEntries(
							levels.map((candidate) => [
								`${candidate.code}_id`,
								/* HQ writes the place's own id, then walks up its parents,
								 * so an ancestor at the same level wins. */
								row.lineage[candidate.uuid] ??
									(candidate.uuid === level.uuid ? row.id : ""),
							]),
						),
					},
					children: [
						...LOCATION_FIXTURE_FIELDS.map((name) => ({
							name,
							value: text[name],
						})),
						{
							name: "location_data",
							childTemplates: properties.map((property) => property.slug),
							children: properties.map((property) => ({
								name: property.slug,
								value: row.values[property.uuid] ?? "",
							})),
						},
					],
				},
			];
		}),
	});
}

/** `json_format_datetime`: UTC, six fraction digits, `Z`. */
function hqDatetimeText(value: string | null): string {
	if (value === null) return "";
	const instant = new Date(value);
	if (Number.isNaN(instant.getTime())) return "";
	return `${instant.toISOString().slice(0, 23)}000Z`;
}

/** `json_format_date` of the UTC instant: its UTC calendar day. */
function hqDateText(value: string | null): string {
	if (value === null) return "";
	const instant = new Date(value);
	if (Number.isNaN(instant.getTime())) return "";
	return instant.toISOString().slice(0, 10);
}

/** A stored custom property as the text HQ's case holds: a `datetime` as
 * `json_format_datetime` of its instant, everything else as the restore
 * prints it. */
function searchResultPropertyText(
	value: JsonValue,
	dataType: CasePropertyDataType | undefined,
): XPathValue {
	if (dataType === "datetime" && typeof value === "string") {
		const text = hqDatetimeText(value);
		if (text !== "") return text;
	}
	return jsonXPathValue(value, dataType);
}

/**
 * The inline search's results instance as HQ builds it
 * (`casexml/apps/case/xml/generator.py::CaseDBXMLGenerator`): `<results>`
 * with one `<case case_id case_type owner_id status>` per case, then
 * `case_name`, `last_modified` (`json_format_datetime`, only when the case
 * has one), `external_id` only when set, `date_opened` (the UTC day of
 * `opened_on`, as text, not a device date), each stored property, and
 * `index` (present only when the case has indices, its children sorted by
 * identifier, `@relationship` written only for an extension). Every row is
 * open: HQ's search finds open cases only. Related cases, their
 * `commcare_is_related_case` mark and `commcare_search_score` are not
 * built, because the read always excludes the first and no catalog
 * property names the others.
 */
export function searchResultsXPathInstance(
	rows: readonly SearchResultRow[],
	catalog: readonly CaseType[],
): XPathInstance {
	const propertyTypes = new Map(
		catalog.map((caseType) => [
			caseType.name,
			new Map(
				caseType.properties.map((property) => [
					property.name,
					property.data_type ?? "text",
				]),
			),
		]),
	);
	const template: ElementSpec = {
		name: "case",
		childTemplates: ["*"],
		attributeTemplates: ["case_id", "case_type", "owner_id", "status"],
		children: [
			{ name: "case_name" },
			{ name: "last_modified" },
			{ name: "date_opened" },
			{ name: "index", childTemplates: ["*"] },
		],
	};
	return new StaticXPathInstance(INLINE_SEARCH_RESULTS_INSTANCE, {
		name: "results",
		attributes: { id: "case" },
		childTemplates: ["case"],
		templateChildren: [template],
		children: rows.map((row): ElementSpec => {
			const types = propertyTypes.get(row.case_type);
			const indices = [...row.indices].sort((a, b) =>
				a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0,
			);
			return {
				name: "case",
				childTemplates: ["*"],
				attributes: {
					case_id: row.case_id,
					case_type: row.case_type,
					owner_id: row.owner_id ?? "",
					status: "open",
				},
				attributeTemplates: template.attributeTemplates,
				children: [
					{ name: "case_name", value: row.case_name ?? "" },
					...(row.modified_on === null
						? []
						: [
								{
									name: "last_modified",
									value: hqDatetimeText(row.modified_on),
								},
							]),
					...(row.external_id === null || row.external_id === ""
						? []
						: [{ name: "external_id", value: row.external_id }]),
					...(row.opened_on === null
						? []
						: [{ name: "date_opened", value: hqDateText(row.opened_on) }]),
					...Object.entries(row.properties).map(
						([name, value]): ElementSpec => ({
							name,
							value: searchResultPropertyText(value, types?.get(name)),
						}),
					),
					...(indices.length === 0
						? []
						: [
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
											...(index.relationship === "extension"
												? { relationship: "extension" }
												: {}),
										},
									})),
								},
							]),
				],
			};
		}),
	});
}

function readsSearchResults(expression: Expression): boolean {
	let found = false;
	walkExpressionNodes(expression, (node) => {
		if (node.kind === "cases" && node.source === "search-results") found = true;
	});
	return found;
}

/** Whether a form's questions, its own slots or its after-submit links read
 * what its search found, so its entry needs the search's snapshot. */
export function formReadsSearchResults(
	doc: BlueprintDoc,
	formUuid: Uuid,
): boolean {
	const owners: { readonly entity: "form" | "field"; readonly uuid: Uuid }[] = [
		{ entity: "form", uuid: formUuid },
	];
	const visit = (parent: Uuid) => {
		for (const uuid of doc.fieldOrder[parent] ?? []) {
			owners.push({ entity: "field", uuid });
			visit(uuid);
		}
	};
	visit(formUuid);
	return owners.some((owner) =>
		expressionSlotValues(doc, owner).some(({ expression }) =>
			readsSearchResults(expression),
		),
	);
}

/** One resolver map for a form engine's immutable evaluation world. */
export function secondaryXPathInstances(args: {
	readonly identity:
		| ResolvedPreviewIdentity
		| PreviewSearchSessionValues
		| null;
	readonly lookupData: PreviewLookupData | null;
	readonly caseDatabase: CaseDatabaseSnapshot | null;
	readonly caseTypes?: readonly CaseType[];
	readonly sessionData?: Readonly<Record<string, string>>;
	/** Present only for an admitted no-matches registration form. */
	readonly searchAnswers?: ReadonlyMap<string, string>;
	/** The entry's several-case selections: datum id → case ids in
	 * selection order. */
	readonly selectedCases?: Readonly<Record<string, readonly string[]>>;
	/** What the entry's search returned, in a search-first module's form. */
	readonly searchResults?: SearchResultsSnapshot;
	/** The organization the `locations` fixture's levels and fields come
	 * from; with the device snapshot's places it builds `locations`. */
	readonly organization?: OrganizationCollections;
	/** Also serve each table under its suite fixture id (`item-list:<tag>`),
	 * as a form link's source entry declares it. */
	readonly includeFixtureAliases?: boolean;
}): ReadonlyMap<string, XPathInstance> {
	const locations = args.caseDatabase?.locations;
	return new Map<string, XPathInstance>([
		[
			"commcaresession",
			commcareSessionXPathInstance(args.identity, args.sessionData),
		],
		[
			"casedb",
			caseDatabaseXPathInstance(args.caseDatabase, args.caseTypes ?? []),
		],
		...lookupXPathInstances(args.lookupData, {
			includeFixtureAliases: args.includeFixtureAliases,
		}),
		...(args.searchAnswers === undefined
			? []
			: [
					[
						INLINE_SEARCH_INPUT_INSTANCE_ID,
						searchInputXPathInstance(args.searchAnswers),
					] as const,
				]),
		...Object.entries(args.selectedCases ?? {}).map(
			([datumId, caseIds]) =>
				[datumId, selectedCasesXPathInstance(datumId, caseIds)] as const,
		),
		...(args.searchResults === undefined
			? []
			: [
					[
						INLINE_SEARCH_RESULTS_INSTANCE,
						searchResultsXPathInstance(
							args.searchResults.rows,
							args.caseTypes ?? [],
						),
					] as const,
				]),
		...(locations === undefined || args.organization === undefined
			? []
			: [
					[
						"locations",
						locationsXPathInstance(locations, args.organization),
					] as const,
				]),
	]);
}

/** The inline search's answers instance, `search-input:results:inline`. */
export const INLINE_SEARCH_INPUT_INSTANCE_ID = "search-input:results:inline";

/** The Search screen's answers instance, `search-input:<datum id>` over the
 * query datum the suite names `results`. */
export const SEARCH_INPUT_INSTANCE_ID = "search-input:results";

/**
 * The device's search-input instance
 * (`org/commcare/data/xml/VirtualInstances.java::buildSearchInputInstance`):
 * `<input><field name="<prompt>">value</field>…</input>`, one field per
 * answered prompt. A no-matches form's search reads print as
 * `instance('search-input:results:inline')/input/field[@name='<name>']`, and
 * the Search screen's as `instance('search-input:results')/…`, so the same
 * path resolves here.
 */
export function searchInputXPathInstance(
	answers: ReadonlyMap<string, string>,
	instanceId: string = INLINE_SEARCH_INPUT_INSTANCE_ID,
): XPathInstance {
	return new StaticXPathInstance(instanceId, {
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
 * The instances the Search screen evaluates over, as the device's query
 * screen holds them
 * (`org/commcare/session/RemoteQuerySessionManager.java::getEvaluationContextWithUserInputInstance`):
 * the session with the datums chosen so far, the answers as
 * `search-input:results` and under the legacy id `search-input` too, and every
 * lookup table under its suite fixture id.
 */
export function searchScreenXPathInstances(args: {
	readonly session: PreviewSearchSessionValues;
	readonly answers: ReadonlyMap<string, string>;
	readonly lookupData?: PreviewLookupData;
	readonly sessionData?: Readonly<Record<string, string>>;
}): ReadonlyMap<string, XPathInstance> {
	return new Map<string, XPathInstance>([
		[
			"commcaresession",
			commcareSessionXPathInstance(args.session, args.sessionData),
		],
		[
			SEARCH_INPUT_INSTANCE_ID,
			searchInputXPathInstance(args.answers, SEARCH_INPUT_INSTANCE_ID),
		],
		["search-input", searchInputXPathInstance(args.answers, "search-input")],
		...lookupXPathInstances(args.lookupData ?? null, {
			includeFixtureAliases: true,
		}),
	]);
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
