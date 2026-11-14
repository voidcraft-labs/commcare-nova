/**
 * The case catalog a reading writes. A document's catalog is a seed: a
 * property's type is "declared, else the one type its writers agree on"
 * (`lib/domain/effectiveCaseTypes.ts`), so the reader declares little and
 * lets the writers speak: case types in menu order, each child type's
 * parent where every link out of it agrees, one property per name the app
 * writes, loads or reads, choices where select questions write a property,
 * and a type only where a reader needs it to write the same wire.
 */
import { type Draft, produce } from "immer";
import type { CasePropertyDataType, Uuid } from "@/lib/domain";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import {
	caseListOrderPlan,
	casePropertyShowsOptionLabels,
} from "@/lib/domain/caseListOrder";
import {
	fieldCaseWriteViews,
	formCaseWriteViews,
} from "@/lib/domain/caseWriteViews";
import {
	concreteCasePropertyWriterTypes,
	effectiveCaseTypes,
} from "@/lib/domain/effectiveCaseTypes";
import { slotContext } from "@/lib/domain/expression/context";
import { resolveRelationDestination } from "@/lib/domain/expression/relationDestination";
import { agreedStorageType } from "@/lib/domain/expression/ruleSets";
import {
	CASE_TYPE_PATTERN,
	type Expression,
	isRelationPath,
	type RelationPath,
} from "@/lib/domain/expression/types";
import { walkExpressionNodes } from "@/lib/domain/expression/walk";
import { type ProseTemplate, proseText } from "@/lib/domain/prose";
import {
	type ExpressionCarrierRef,
	type ExpressionSlotValue,
	expressionSlotValues,
} from "@/lib/domain/referenceSlots";
import { isStandardCaseListProperty } from "@/lib/domain/standardCaseProperties";
import { caseListOrderOptions } from "../../suite/case-list/orderPlanOptions";
import { fieldBindType } from "../../xform/bindType";
import { withCandidate } from "../candidate";
import { DATE_SORT_DECLARED_TYPE } from "../caseList/order";
import { defineClaims, refuse } from "../claims";
import type { DraftApp, DraftForm, ReadContext } from "../context";
import {
	agreedComparedTypes,
	type ComparedType,
	comparedTypes,
} from "../expressions/comparedTypes";
import { appPlace } from "../place";
import type { ReaderKnownCaseTypes } from "../types";
import type { DraftField } from "../xform";
import { advancedCaseReading } from "./advancedActions";
import { basicCaseReading } from "./basicActions";
import { knownCaseTypesOf } from "./knownCaseTypes";
import { saveToCaseReading } from "./saveToCase";

type Catalog = NonNullable<BlueprintDoc["caseTypes"]>;
type CatalogType = Catalog[number];

/** The types a sort element names one `date` comparison for
 *  (`hqJson/caseList.ts::sortElementType`). */
const DATE_SORT_CLASS: ReadonlySet<CasePropertyDataType> =
	new Set<CasePropertyDataType>(["date", "datetime", "time"]);

/** The two case types no menu of a reading may hold: the worker's record
 *  and HQ's owner mapping. */
const NOT_CATALOGUED: ReadonlySet<string> = new Set([
	"commcare-user",
	"user-owner-mapping-case",
]);

/** Adds `(caseType, name)` to `caseTypes` where the type holds no such
 *  property and the name is no standard property: label the name, no
 *  `data_type`, placed in name order by code unit. A no-op otherwise, and
 *  where the catalog holds no case type of that name: a property is declared
 *  on a type the app has, never on one an expression names alone. It reads
 *  and writes the catalog it is given and nothing else. */
export function noteProperty(
	caseTypes: Draft<NonNullable<BlueprintDoc["caseTypes"]>>,
	caseType: string,
	name: string,
): void {
	if (isStandardCaseListProperty(name)) return;
	const type = caseTypes.find((candidate) => candidate.name === caseType);
	if (type === undefined) return;
	if (type.properties.some((property) => property.name === name)) return;
	const at = type.properties.findIndex((property) => property.name > name);
	// No `data_type`: unknown is honest until a writer types the property.
	const declared = { name, label: proseText(name) };
	if (at === -1) type.properties.push(declared);
	else type.properties.splice(at, 0, declared);
}

/** Adds a case type where the catalog holds none of that name and the name
 *  is one a menu may hold. */
function noteType(caseTypes: Catalog, name: string | undefined): void {
	if (name === undefined || name === "" || NOT_CATALOGUED.has(name)) return;
	if (!CASE_TYPE_PATTERN.test(name)) return;
	if (caseTypes.some((type) => type.name === name)) return;
	caseTypes.push({ name, properties: [] });
}

/** One link out of a case type, by its identifier. */
interface ReadLink {
	readonly child: string;
	readonly identifier: string;
	readonly parent: string;
	readonly relationship: "child" | "extension";
}

/** `parent_type` and `relationship` of each child type where every link
 *  out of it under `parent` agrees, else neither key. A parent selection
 *  gives its menu's case type a parent where no link says otherwise. A type
 *  no link and no selection gives a parent takes the one `known` names, and
 *  that parent is a type of the catalog. */
function noteParents(
	caseTypes: Catalog,
	links: readonly ReadLink[],
	selections: readonly { readonly child: string; readonly parent: string }[],
	known: ReaderKnownCaseTypes | undefined,
): void {
	// The catalog grows by the parents `known` names, which are walked in turn.
	for (let at = 0; at < caseTypes.length; at++) {
		const type = caseTypes[at] as CatalogType;
		const out = links.filter(
			(link) => link.child === type.name && link.identifier === "parent",
		);
		const parents = new Set(out.map((link) => link.parent));
		const relationships = new Set(out.map((link) => link.relationship));
		if (out.length > 0) {
			if (parents.size === 1 && relationships.size === 1) {
				type.parent_type = [...parents][0] as string;
				type.relationship = [...relationships][0] as "child" | "extension";
			}
			continue;
		}
		const selected = new Set(
			selections
				.filter((one) => one.child === type.name)
				.map((one) => one.parent),
		);
		if (selected.size === 1) {
			type.parent_type = [...selected][0] as string;
			type.relationship = "child";
		}
		if (selected.size > 0) continue;
		const parent = known?.targetOf(type.name, "parent");
		if (parent === undefined) continue;
		noteType(caseTypes, parent.caseType);
		if (!caseTypes.some((one) => one.name === parent.caseType)) continue;
		type.parent_type = parent.caseType;
		if (parent.relationship !== undefined)
			type.relationship = parent.relationship;
	}
}

/** The inline choices a select question offers, by value, first label kept. */
function noteChoices<
	O extends { readonly value: string; readonly label: ProseTemplate },
>(
	property: Draft<CatalogType["properties"][number]>,
	options: readonly O[],
): void {
	const known = property.options ?? [];
	for (const option of options)
		if (!known.some((one) => one.value === option.value))
			known.push({
				value: option.value,
				label: structuredClone(option.label) as never,
			});
	if (known.length > 0) property.options = known;
}

function inlineOptions(field: Readonly<Record<string, unknown>> | undefined) {
	const source = field?.optionsSource as
		| {
				kind: string;
				options?: { uuid?: Uuid; value: string; label: ProseTemplate }[];
		  }
		| undefined;
	return source?.kind === "inline" ? (source.options ?? []) : [];
}

function isSelect(kind: unknown): boolean {
	return kind === "single_select" || kind === "multi_select";
}

/** Each property's select type, where every writer of it a reading reads is
 *  a select question of one kind: the type its writers agree on, which the
 *  translations of its choices and a case list's labels of them are keyed
 *  by. A property any other writer writes is left untyped. */
function selectTypes(
	writers: readonly {
		readonly caseType: string;
		readonly property: string;
		readonly kind: string;
	}[],
): Map<string, "single_select" | "multi_select"> {
	const kinds = new Map<string, Set<string>>();
	for (const one of writers) {
		const key = `${one.caseType}\u0000${one.property}`;
		const set = kinds.get(key) ?? new Set<string>();
		set.add(one.kind);
		kinds.set(key, set);
	}
	const out = new Map<string, "single_select" | "multi_select">();
	for (const [key, set] of kinds) {
		const [only, ...more] = [...set];
		if (
			more.length === 0 &&
			(only === "single_select" || only === "multi_select")
		)
			out.set(key, only);
	}
	return out;
}

/** Declares each property's select type `selectTypes` gives. */
function declareSelectTypes(
	draft: Draft<Catalog>,
	selects: ReadonlyMap<string, "single_select" | "multi_select">,
): void {
	for (const type of draft)
		for (const property of type.properties) {
			const select = selects.get(`${type.name}\u0000${property.name}`);
			if (select !== undefined) property.data_type = select;
		}
}

/** Whether `field` is a Hidden Value whose bind in `form`'s source is typed `xsd:dateTime`. */
function boundDateTime(
	form: DraftForm,
	field: DraftField | undefined,
): boolean {
	if (field === undefined || field.kind !== "hidden") return false;
	const type = form.xform?.binds.get(field.node)?.type;
	if (type === undefined) return false;
	return (type.startsWith("xsd:") ? type.slice(4) : type) === "dateTime";
}

/** The `datetime` declarations each reading made before its expressions bound, by type and
 *  property. */
const DATETIME_DECLARATIONS = new WeakMap<
	ReadContext,
	readonly { readonly caseType: string; readonly property: string }[]
>();

/**
 * Declares `datetime` on each property a Hidden Value bound `xsd:dateTime` writes where no
 * question types it: every writer is a Hidden Value or an expression, whose type is known only
 * once the expressions bind. Nova binds a Hidden Value that saves to a case `xsd:dateTime` only
 * where the property is a date and time (`xform/bindType.ts::fieldBindType`), so the bind is the
 * evidence the export carries of a type the catalog declared and no writer gives. Declared before
 * the expression stage, so every slot that reads the property binds against it; the settle takes
 * back each one a writer of the bound document types (`takeBackWriterTypedDateTimes`). Answers
 * what it declared.
 */
function declareHiddenDateTimes(
	draft: Draft<Catalog>,
	writes: readonly {
		readonly caseType: string;
		readonly property: string;
		readonly field?: DraftField;
		readonly dateTime?: true;
		readonly read?: true;
	}[],
): { caseType: string; property: string }[] {
	const declared: { caseType: string; property: string }[] = [];
	for (const one of writes) {
		if (one.dateTime !== true) continue;
		const writers = writes.filter(
			(other) =>
				other.read !== true &&
				other.caseType === one.caseType &&
				other.property === one.property,
		);
		if (
			writers.some(
				(other) => other.field !== undefined && other.field.kind !== "hidden",
			)
		)
			continue;
		const property = draft
			.find((type) => type.name === one.caseType)
			?.properties.find((candidate) => candidate.name === one.property);
		if (property === undefined || property.data_type !== undefined) continue;
		property.data_type = "datetime";
		declared.push({ caseType: one.caseType, property: one.property });
	}
	return declared;
}

/** `doc` without each `datetime` the reading declared before binding that a writer of the bound
 *  document types without it: the writer's type is the property's, as it is in the document
 *  the source was emitted from. */
export function takeBackWriterTypedDateTimes(
	ctx: ReadContext,
	doc: BlueprintDoc,
): BlueprintDoc {
	const early = DATETIME_DECLARATIONS.get(ctx) ?? [];
	if (early.length === 0) return doc;
	const declarationOf = (draft: BlueprintDoc, one: (typeof early)[number]) =>
		draft.caseTypes
			?.find((type) => type.name === one.caseType)
			?.properties.find((property) => property.name === one.property);
	const without = withCandidate(doc, (draft) => {
		for (const one of early) {
			const declared = declarationOf(draft as BlueprintDoc, one);
			if (declared?.data_type === "datetime") delete declared.data_type;
		}
	});
	const writerTyped = effectiveCaseTypes(without);
	const typed = early.filter(
		(one) =>
			writerTyped
				.find((type) => type.name === one.caseType)
				?.properties.find((property) => property.name === one.property)
				?.data_type !== undefined,
	);
	if (typed.length === 0) return doc;
	return withCandidate(doc, (draft) => {
		for (const one of typed) {
			const declared = declarationOf(draft as BlueprintDoc, one);
			if (declared?.data_type === "datetime") delete declared.data_type;
		}
	});
}

/**
 * Step 3: the catalog of the reading, written into the draft from what the
 * structure and case readers read: every menu's case type, every child
 * case's, open action's and Save to Case block's, in menu order; each child
 * type's parent; one property per property written or preloaded; and each
 * select-written property's choices. A property a case list column, a sort
 * element or a simple Search field reads is noted by the list and search
 * readers, and one an expression reads by the expression stage, each through
 * `noteProperty`.
 */
export function readCaseCatalog(ctx: ReadContext, app: DraftApp): void {
	const caseTypes: Catalog = [];
	for (const module of app.modules) {
		const stored = module.module.caseType ?? module.json.peek("case_type");
		noteType(caseTypes, typeof stored === "string" ? stored : undefined);
	}
	const links: ReadLink[] = [];
	const writes: {
		caseType: string;
		property: string;
		field?: DraftField;
		/** The writing question is a Hidden Value its bind types `xsd:dateTime`. */
		dateTime?: true;
		/** A preload, which reads the property and writes nothing. */
		read?: true;
	}[] = [];
	for (const module of app.modules) {
		const menuType = module.module.caseType;
		for (const form of module.forms) {
			for (const op of basicCaseReading(form)?.operations ?? []) {
				const caseType = op.action === "own" ? menuType : op.caseType;
				if (caseType === undefined) continue;
				noteType(caseTypes, caseType);
				for (const write of op.writes)
					if (write.via === undefined)
						writes.push({
							caseType,
							property: write.property,
							field: write.value.field,
							...(boundDateTime(form, write.value.field) && { dateTime: true }),
						});
				if (
					op.linksOwn === true &&
					menuType !== undefined &&
					op.action === "create"
				)
					links.push({
						child: caseType,
						identifier: "parent",
						parent: menuType,
						relationship: "child",
					});
			}
			const advanced = advancedCaseReading(form);
			for (const op of advanced?.operations ?? []) {
				const caseType = op.action === "own" ? menuType : op.caseType;
				if (caseType === undefined) continue;
				noteType(caseTypes, caseType);
				for (const write of op.writes)
					writes.push({
						caseType,
						property: write.property,
						field: write.value.field,
						...(boundDateTime(form, write.value.field) && { dateTime: true }),
					});
				for (const link of op.links)
					links.push({
						child: caseType,
						identifier: link.identifier,
						parent: link.targetType,
						relationship: link.relationship,
					});
			}
			for (const block of saveToCaseReading(form)?.proposals ?? []) {
				const caseType = block.action === "own" ? menuType : block.caseType;
				if (caseType === undefined) continue;
				noteType(caseTypes, caseType);
				const destination = block.retype ?? caseType;
				noteType(caseTypes, destination);
				for (const write of block.writes) {
					// A value that is one question's answer is that question's write.
					const field =
						write.value.kind === "text"
							? write.value.readsField
							: write.value.field;
					writes.push({
						caseType: destination,
						property: write.property,
						...(field !== undefined && { field }),
						...(boundDateTime(form, field) && { dateTime: true }),
					});
				}
				for (const link of block.links)
					links.push({
						child: caseType,
						identifier: link.identifier,
						parent: link.targetType,
						relationship: link.relationship,
					});
			}
			// A preload is a default reading the case's property.
			const xform = form.xform;
			if (xform !== null)
				for (const field of fieldsOf(xform.childrenOf, null)) {
					const read = field.field.default_value as
						| {
								kind?: string;
								term?: { kind?: string; caseType?: string; property?: string };
						  }
						| undefined;
					if (
						read?.kind === "term" &&
						read.term?.kind === "form-case" &&
						read.term.caseType !== undefined &&
						read.term.property !== undefined
					)
						writes.push({
							caseType: read.term.caseType,
							property: read.term.property,
							read: true,
						});
				}
		}
	}
	const selections: { child: string; parent: string }[] = [];
	for (const module of app.modules) {
		const parent = app.modules.find(
			(one) => one.uuid === module.module.parentCaseModuleUuid,
		);
		const child = module.module.caseType;
		const parentType = parent?.module.caseType;
		if (child !== undefined && parentType !== undefined)
			selections.push({ child, parent: parentType });
	}
	noteParents(caseTypes, links, selections, ctx.input.knownCaseTypes);
	const selects = selectTypes(
		writes.flatMap((one) =>
			one.read === true
				? []
				: [{ ...one, kind: one.field?.kind ?? "expression" }],
		),
	);
	const next = produce(caseTypes, (draft) => {
		for (const write of writes) {
			noteProperty(draft, write.caseType, write.property);
			const field = write.field;
			if (field === undefined || !isSelect(field.kind)) continue;
			const property = draft
				.find((type) => type.name === write.caseType)
				?.properties.find((one) => one.name === write.property);
			if (property === undefined) continue;
			noteChoices(property, inlineOptions(field.field));
		}
		declareSelectTypes(draft, selects);
		DATETIME_DECLARATIONS.set(ctx, declareHiddenDateTimes(draft, writes));
	});
	ctx.writeDraft(() => {
		app.caseTypes = next as Catalog;
	});
}

const WRITER_CLAIMS = defineClaims("caseManagement.catalog", {
	singleMulti: refuse(
		`forms-and-case-writes/writers-single-select-multi-select`,
		null,
	),
	otherPair: refuse(`forms-and-case-writes/any-other-mixed-writer-pair`, null),
});

/**
 * The writers of each property judged over the bound document
 * (`concreteCasePropertyWriterTypes`): writers that agree on one stored type
 * (`agreedStorageType`: `int` with `decimal` on `decimal`, `text` with
 * `single_select` on `text`) are one type Nova holds, with nothing claimed,
 * since those entries name no key; writers that do not are the manifest's
 * row for their pair, one finding per property, at the first menu of its
 * case type.
 */
export function settleWriterTypes(
	ctx: ReadContext,
	app: DraftApp,
	doc: BlueprintDoc,
): void {
	let opinions: ReturnType<typeof concreteCasePropertyWriterTypes>;
	try {
		opinions = concreteCasePropertyWriterTypes(doc);
	} catch {
		return;
	}
	for (const [caseType, byProperty] of opinions) {
		if (NOT_CATALOGUED.has(caseType)) continue;
		for (const [property, types] of byProperty) {
			if (types.size < 2 || agreedStorageType(types) !== undefined) continue;
			const pair = (a: CasePropertyDataType, b: CasePropertyDataType) =>
				types.size === 2 && types.has(a) && types.has(b);
			const claim = pair("single_select", "multi_select")
				? WRITER_CLAIMS.singleMulti
				: WRITER_CLAIMS.otherPair;
			const menu = app.modules.find(
				(module) => module.module.caseType === caseType,
			);
			ctx.accounting.finding(claim, menu?.place ?? appPlace(), {
				name: property,
			});
		}
	}
}

function fieldsOf(
	childrenOf: (parent: DraftField | null) => readonly DraftField[],
	parent: DraftField | null,
): DraftField[] {
	return childrenOf(parent).flatMap((field) => [
		field,
		...fieldsOf(childrenOf, field),
	]);
}

/** The properties a menu's case list and its simple Search fields name, each
 *  on the case type it is a property of: a column's and a field's with no
 *  `via` on the menu's, and a field's with a `via` on the type the relation
 *  reaches, whose read the search's own filter prints. */
function listProperties(
	module: Readonly<Record<string, unknown>>,
	caseType: string,
	caseTypes: Parameters<typeof resolveRelationDestination>[2],
): { caseType: string; property: string }[] {
	const out: { caseType: string; property: string }[] = [];
	const config = module.caseListConfig as
		| {
				columns?: readonly Readonly<Record<string, unknown>>[];
				searchInputs?: readonly Readonly<Record<string, unknown>>[];
		  }
		| undefined;
	for (const column of config?.columns ?? [])
		if (typeof column.field === "string")
			out.push({ caseType, property: column.field });
	for (const input of config?.searchInputs ?? []) {
		if (input.kind !== "simple" || typeof input.property !== "string") continue;
		if (input.via === undefined) {
			out.push({ caseType, property: input.property });
			continue;
		}
		const destination = resolveRelationDestination(
			input.via as Parameters<typeof resolveRelationDestination>[0],
			caseType,
			caseTypes,
		);
		if (destination.ok)
			out.push({ caseType: destination.caseType, property: input.property });
	}
	return out;
}

/** Every property reference a document's expressions hold, by structure:
 *  a record read (`prop`), on the type its relation reaches from the type it
 *  starts from, or a form's read of its case (`form-case`). */
function expressionReads(
	value: unknown,
	out: { caseType: string; property: string }[],
	caseTypes: Parameters<typeof resolveRelationDestination>[2],
): void {
	if (Array.isArray(value)) {
		for (const one of value) expressionReads(one, out, caseTypes);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	const record = value as Readonly<Record<string, unknown>>;
	if (
		(record.kind === "prop" || record.kind === "form-case") &&
		typeof record.caseType === "string" &&
		typeof record.property === "string"
	) {
		const destination =
			record.kind === "prop"
				? resolveRelationDestination(
						record.via as Parameters<typeof resolveRelationDestination>[0],
						record.caseType,
						caseTypes,
					)
				: undefined;
		const caseType =
			destination === undefined
				? record.caseType
				: destination.ok
					? destination.caseType
					: undefined;
		if (caseType !== undefined)
			out.push({ caseType, property: record.property });
	}
	for (const one of Object.values(record)) expressionReads(one, out, caseTypes);
}

/** The properties that a sorted column, a date Search field or a date range
 *  Search field reads, each with the types its reader keeps declared where
 *  no writer types the property: `exact`, the types a reader prints apart,
 *  and `dateClass`, the properties whose sort element names a `date`
 *  comparison for every type of the date class alike. */
function typedReaders(doc: BlueprintDoc): {
	readonly exact: Map<string, ReadonlySet<CasePropertyDataType>>;
	readonly dateClass: ReadonlySet<string>;
} {
	const out = new Map<string, Set<CasePropertyDataType>>();
	const dateClass = new Set<string>();
	const add = (
		caseType: string,
		property: string,
		types: readonly CasePropertyDataType[],
	) => {
		const key = `${caseType}\u0000${property}`;
		const set = out.get(key) ?? new Set<CasePropertyDataType>();
		for (const type of types) set.add(type);
		out.set(key, set);
	};
	for (const uuid of doc.moduleOrder) {
		const module = doc.modules[uuid];
		const caseType = module?.caseType;
		if (module === undefined || caseType === undefined) continue;
		for (const property of rawValueSortKeys(doc, uuid))
			dateClass.add(`${caseType}\u0000${property}`);
		for (const column of module.caseListConfig?.columns ?? []) {
			if (column.sort === undefined) continue;
			const field = (column as { field?: unknown }).field;
			if (typeof field === "string") add(caseType, field, ["int", "decimal"]);
			// A sorted calculated column that is one property's read alone, on
			// the menu's case or a case a relation reaches, orders by it.
			if (
				column.kind === "calculated" &&
				column.expression.kind === "term" &&
				column.expression.term.kind === "prop"
			) {
				const { property, via } = column.expression.term;
				const destination = resolveRelationDestination(
					via,
					caseType,
					effectiveCaseTypes(doc),
				);
				if (destination.ok)
					add(destination.caseType, property, ["int", "decimal"]);
			}
		}
		for (const input of module.caseListConfig?.searchInputs ?? []) {
			const record = input as {
				kind?: string;
				property?: unknown;
				type?: unknown;
				via?: unknown;
			};
			if (record.kind !== "simple" || typeof record.property !== "string")
				continue;
			// A field with a `via` reads the property of the case its relation
			// reaches, whose type its derivation prints
			// (`dateSearch.ts::exactDateSearchPredicate`).
			const destination = resolveRelationDestination(
				record.via as Parameters<typeof resolveRelationDestination>[0],
				caseType,
				effectiveCaseTypes(doc),
			);
			if (!destination.ok) continue;
			if (record.type === "date")
				add(destination.caseType, record.property, ["date", "datetime"]);
			if (record.type === "date-range")
				add(destination.caseType, record.property, ["date"]);
		}
	}
	for (const [caseType, property] of hiddenDateTimeWrites(doc))
		add(caseType, property, ["datetime"]);
	return { exact: out, dateClass };
}

/**
 * The properties a written rule of `moduleUuid`'s list orders by raw value,
 * by the list's order plan: the keys whose sort element
 * `hqJson/caseList.ts::sortElementType` writes as a `date` comparison where
 * the property's type is of the date class, and as another where it is not.
 */
function rawValueSortKeys(doc: BlueprintDoc, moduleUuid: Uuid): string[] {
	const module = doc.modules[moduleUuid];
	const config = module?.caseListConfig;
	if (module === undefined || config === undefined) return [];
	const properties =
		effectiveCaseTypes(doc).find((type) => type.name === module.caseType)
			?.properties ?? [];
	let plan: ReturnType<typeof caseListOrderPlan>;
	try {
		plan = caseListOrderPlan(
			config,
			properties,
			caseListOrderOptions(module, doc, true),
		);
	} catch {
		return [];
	}
	return [
		...plan.fields.flatMap((field) =>
			field.rule?.written === true &&
			!field.rule.implicit &&
			field.key?.kind === "property"
				? [field.key.property]
				: [],
		),
		...plan.carriers.flatMap((carrier) =>
			carrier.rule.written && !carrier.rule.implicit ? [carrier.property] : [],
		),
	];
}

/** Each `(case type, property)` a Hidden Value saves its answer to straight, where Nova binds
 *  the Hidden Value `xsd:dateTime` (`xform/bindType.ts::fieldBindType`): the type its export
 *  carries on the question that writes the property. */
function hiddenDateTimeWrites(
	doc: BlueprintDoc,
): (readonly [string, string])[] {
	const out: (readonly [string, string])[] = [];
	let caseTypes: ReturnType<typeof effectiveCaseTypes> | undefined;
	for (const moduleUuid of doc.moduleOrder)
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			if (doc.forms[formUuid] === undefined) continue;
			for (const [fieldUuid, views] of formCaseWriteViews(doc, formUuid)) {
				const field = doc.fields[fieldUuid];
				if (field?.kind !== "hidden") continue;
				caseTypes ??= effectiveCaseTypes(doc);
				if (
					fieldBindType(
						field,
						caseTypes,
						fieldCaseWriteViews(doc, fieldUuid),
					) !== "xsd:dateTime"
				)
					continue;
				for (const view of views)
					if (view.slot === "write" && view.via === undefined)
						out.push([view.caseType, view.property]);
			}
		}
	return out;
}

/** Each expression slot of `doc`, with the case type its menu lists: the
 *  type a relation the slot walks starts from. */
function slotsWithOrigin(
	doc: BlueprintDoc,
): { readonly value: ExpressionSlotValue; readonly origin?: string }[] {
	const out: { value: ExpressionSlotValue; origin?: string }[] = [];
	const owned = (owner: ExpressionCarrierRef, origin: string | undefined) => {
		for (const value of expressionSlotValues(doc, owner))
			out.push({ value, ...(origin !== undefined && { origin }) });
	};
	for (const moduleUuid of doc.moduleOrder) {
		const origin = doc.modules[moduleUuid]?.caseType;
		owned({ entity: "module", uuid: moduleUuid }, origin);
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			owned({ entity: "form", uuid: formUuid }, origin);
			const walk = (parent: Uuid) => {
				for (const uuid of doc.fieldOrder[parent] ?? []) {
					owned({ entity: "field", uuid }, origin);
					walk(uuid);
				}
			};
			walk(formUuid);
		}
	}
	return out;
}

/**
 * Each child type a read of the cases under a case names, with the type it
 * stands under: a count, a presence or an absence of the cases indexed
 * `parent` to the case of the slot's row, of the type it reaches, which its
 * print tests. The reading
 * reads that walk's type test (`expressions/scanReads.ts`, its parent links)
 * and names the child type's parent where the catalog says none.
 */
function subcaseLinks(
	doc: BlueprintDoc,
	caseTypes: Parameters<typeof resolveRelationDestination>[2],
): { readonly child: string; readonly parent: string }[] {
	const out: { child: string; parent: string }[] = [];
	const walk = (value: unknown, origin: string | undefined): void => {
		if (Array.isArray(value)) {
			for (const one of value) walk(one, origin);
			return;
		}
		if (typeof value !== "object" || value === null) return;
		const record = value as Readonly<Record<string, unknown>>;
		const via = record.via as RelationPath | undefined;
		if (
			(record.kind === "count" ||
				record.kind === "exists" ||
				record.kind === "missing") &&
			isRelationPath(via)
		) {
			const destination = resolveRelationDestination(via, origin, caseTypes);
			if (
				via.kind === "subcase" &&
				via.identifier === "parent" &&
				destination.ok &&
				origin !== undefined
			)
				out.push({ child: destination.caseType, parent: origin });
			walk(record.where, destination.ok ? destination.caseType : undefined);
			return;
		}
		for (const one of Object.values(record)) walk(one, origin);
	};
	for (const { value, origin } of slotsWithOrigin(doc))
		walk(value.expression, origin);
	return out;
}

/**
 * The types the document's record slots give properties the catalog as read
 * holds untyped, as the reading types them before binding
 * (`expressions/comparedTypes.ts`): each property compared with a value of a
 * known type, measured as a distance or tested for the choices it holds;
 * and two such properties compared with each other where the document holds
 * both as dates and times, whose print is then the moments' comparison.
 */
function recordComparedTypes(
	doc: BlueprintDoc,
	untyped: (caseType: string, property: string) => boolean,
): ComparedType[] {
	const found: ComparedType[] = [];
	const effective = effectiveCaseTypes(doc);
	const typeOfProperty = (caseType: string, property: string) =>
		effective
			.find((type) => type.name === caseType)
			?.properties.find((one) => one.name === property)?.data_type;
	const selfProperty = (side: Expression | undefined) =>
		side?.kind === "term" &&
		side.term.kind === "prop" &&
		side.term.caseType !== undefined &&
		(side.term.via === undefined || side.term.via.kind === "self")
			? { caseType: side.term.caseType, property: side.term.property }
			: undefined;
	for (const { value } of slotsWithOrigin(doc)) {
		let context: ReturnType<typeof slotContext>;
		try {
			context = slotContext(doc, value.ref, new Map());
		} catch {
			context = undefined;
		}
		if (context?.ruleSet !== "record") continue;
		found.push(...comparedTypes(value.expression, context, untyped));
		walkExpressionNodes(value.expression, (node) => {
			if (
				node.kind !== "eq" &&
				node.kind !== "neq" &&
				node.kind !== "gt" &&
				node.kind !== "gte" &&
				node.kind !== "lt" &&
				node.kind !== "lte"
			)
				return;
			const sides = [selfProperty(node.left), selfProperty(node.right)];
			if (
				sides.every(
					(side) =>
						side !== undefined &&
						untyped(side.caseType, side.property) &&
						typeOfProperty(side.caseType, side.property) === "datetime",
				)
			)
				for (const side of sides)
					if (side !== undefined) found.push({ ...side, dataType: "datetime" });
		});
	}
	return agreedComparedTypes(found);
}

/** The catalog this section's rules give over the document's own menus,
 *  operations, preloads, columns, search fields and expression reads: types
 *  in menu order; `parent_type` and `relationship` where the document's
 *  links agree, and the document's own where no link and no parent selection
 *  gives a type one (a reading of its export is told them,
 *  `ReaderInput.knownCaseTypes`); properties by `noteProperty`; `data_type` only where a
 *  sort or a date Search field needs it and no writer types the property,
 *  or where every writer is a select question of one kind; choices where
 *  select questions write a property, and as each plain column states them. */
export function catalogAsRead(
	doc: BlueprintDoc,
): NonNullable<BlueprintDoc["caseTypes"]> {
	const caseTypes: Catalog = [];
	const links: ReadLink[] = [];
	const writes: {
		caseType: string;
		property: string;
		options?: readonly { value: string; label: ProseTemplate }[];
		/** The writing question's kind, or `expression` for any other value. */
		kind: string;
	}[] = [];
	const selections: { child: string; parent: string }[] = [];
	for (const uuid of doc.moduleOrder)
		noteType(caseTypes, doc.modules[uuid]?.caseType);
	for (const moduleUuid of doc.moduleOrder) {
		const module = doc.modules[moduleUuid];
		const menuType = module?.caseType;
		if (module?.parentCaseModuleUuid !== undefined && menuType !== undefined) {
			const parent = doc.modules[module.parentCaseModuleUuid]?.caseType;
			if (parent !== undefined) selections.push({ child: menuType, parent });
		}
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid];
			for (const op of form?.caseOperations ?? []) {
				const caseType = op.action === "own" ? menuType : op.caseType;
				if (caseType === undefined) continue;
				noteType(caseTypes, caseType);
				const destination = (op.action === "update" && op.retype) || caseType;
				noteType(caseTypes, destination);
				for (const write of op.writes ?? []) {
					// A write through an index saves to a case above; its type is the
					// expression stage's to note, by the read it binds.
					if (write.via !== undefined) continue;
					const value = write.value;
					const field =
						value.kind === "term" && value.term.kind === "field"
							? doc.fields[value.term.uuid]
							: undefined;
					writes.push({
						caseType: destination,
						property: write.property,
						kind: field?.kind ?? "expression",
						...(field !== undefined &&
							isSelect(field.kind) && {
								options: inlineOptions(
									field as unknown as Readonly<Record<string, unknown>>,
								),
							}),
					});
				}
				for (const link of (
					op as {
						links?: readonly {
							identifier: string;
							targetType: string;
							relationship: "child" | "extension";
						}[];
					}
				).links ?? [])
					links.push({
						child: caseType,
						identifier: link.identifier,
						parent: link.targetType,
						relationship: link.relationship,
					});
			}
		}
	}
	noteParents(caseTypes, links, selections, knownCaseTypesOf(doc));
	const reads: { caseType: string; property: string }[] = [];
	const effectiveTypes = effectiveCaseTypes(doc);
	const subcases = subcaseLinks(doc, effectiveTypes);
	expressionReads(doc.fields, reads, effectiveTypes);
	expressionReads(doc.forms, reads, effectiveTypes);
	expressionReads(doc.modules, reads, effectiveTypes);
	const readers = typedReaders(doc);
	const selects = selectTypes(writes);
	return produce(caseTypes, (draft) => {
		for (const write of writes) {
			noteProperty(draft, write.caseType, write.property);
			if (write.options === undefined) continue;
			const property = draft
				.find((type) => type.name === write.caseType)
				?.properties.find((one) => one.name === write.property);
			if (property !== undefined) noteChoices(property, write.options);
		}
		for (const uuid of doc.moduleOrder) {
			const module = doc.modules[uuid];
			if (module?.caseType === undefined) continue;
			for (const one of listProperties(
				module as unknown as Readonly<Record<string, unknown>>,
				module.caseType,
				effectiveTypes,
			))
				noteProperty(draft, one.caseType, one.property);
		}
		for (const read of reads) noteProperty(draft, read.caseType, read.property);
		// A walk to the cases under a case names the child type and its parent
		// where the catalog says neither.
		for (const link of subcases) {
			if (
				!CASE_TYPE_PATTERN.test(link.child) ||
				!CASE_TYPE_PATTERN.test(link.parent) ||
				NOT_CATALOGUED.has(link.child) ||
				NOT_CATALOGUED.has(link.parent)
			)
				continue;
			const known = draft.find((type) => type.name === link.child);
			if (known?.parent_type !== undefined) continue;
			if (known === undefined) draft.push({ name: link.child, properties: [] });
			if (!draft.some((type) => type.name === link.parent))
				draft.push({ name: link.parent, properties: [] });
			const child = draft.find((type) => type.name === link.child);
			if (child === undefined) continue;
			child.parent_type = link.parent;
			child.relationship = "child";
		}
		declareSelectTypes(draft, selects);
		// A plain column states its property's choices, as the list reader reads
		// them (`caseList/details.ts::declareShownChoices`,
		// `withholdRawShownChoices`): where the column shows the choices' labels,
		// its enum is the property's kind and its choices exactly, whatever the
		// select questions writing it hold; where it shows the values, the
		// property keeps no choices and keeps its select type.
		const effective = effectiveCaseTypes(doc);
		const stated = new Set<string>();
		for (const uuid of doc.moduleOrder) {
			const module = doc.modules[uuid];
			const caseType = module?.caseType;
			if (caseType === undefined) continue;
			for (const column of module?.caseListConfig?.columns ?? []) {
				if (column.kind !== "plain") continue;
				const shown = effective
					.find((type) => type.name === caseType)
					?.properties.find((one) => one.name === column.field);
				const entry = draft
					.find((type) => type.name === caseType)
					?.properties.find((one) => one.name === column.field);
				if (shown === undefined || entry === undefined) continue;
				if (!casePropertyShowsOptionLabels(shown)) {
					delete entry.options;
					continue;
				}
				const key = `${caseType}\u0000${column.field}`;
				if (
					stated.has(key) ||
					(entry.data_type !== undefined && entry.data_type !== shown.data_type)
				)
					continue;
				stated.add(key);
				entry.data_type = shown.data_type;
				entry.options = (shown.options ?? []).map((option) => ({
					value: option.value,
					label: structuredClone(option.label) as never,
				}));
			}
		}
		// A type declared only where a reader keeps it and no writer types the
		// property: the type itself where a reader prints it apart, and the
		// date class's one print where only a sort element names it, which
		// writes every type of the class as one `date` comparison and is the
		// declaration a reading of the element makes
		// (`caseList/order.ts::dateSortDeclarations`).
		const declared = new Map<string, CasePropertyDataType>();
		for (const type of doc.caseTypes ?? [])
			for (const property of type.properties)
				if (property.data_type !== undefined)
					declared.set(
						`${type.name}\u0000${property.name}`,
						property.data_type,
					);
		const untyped = effectiveCaseTypes({
			...doc,
			caseTypes: draft as Catalog,
		} as BlueprintDoc);
		for (const type of draft)
			for (const property of type.properties) {
				const key = `${type.name}\u0000${property.name}`;
				const keep = declared.get(key);
				if (keep === undefined) continue;
				const kept =
					readers.exact.get(key)?.has(keep) === true
						? keep
						: readers.dateClass.has(key) && DATE_SORT_CLASS.has(keep)
							? DATE_SORT_DECLARED_TYPE
							: undefined;
				if (kept === undefined) continue;
				const derived = untyped
					.find((one) => one.name === type.name)
					?.properties.find((one) => one.name === property.name)?.data_type;
				if (derived === undefined) property.data_type = kept;
			}
		// A property the record slots compare, still untyped, takes the type
		// the comparison gives it.
		const asRead = effectiveCaseTypes({
			...doc,
			caseTypes: draft as Catalog,
		} as BlueprintDoc);
		const compared = recordComparedTypes(doc, (caseType, property) => {
			const entry = asRead
				.find((type) => type.name === caseType)
				?.properties.find((one) => one.name === property);
			return (
				entry !== undefined &&
				entry.data_type === undefined &&
				draft
					.find((type) => type.name === caseType)
					?.properties.some((one) => one.name === property) === true
			);
		});
		for (const one of compared) {
			const property = draft
				.find((type) => type.name === one.caseType)
				?.properties.find((entry) => entry.name === one.property);
			if (property !== undefined && property.data_type === undefined)
				property.data_type = one.dataType;
		}
	}) as Catalog;
}
