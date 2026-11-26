/**
 * The case catalog a reading writes. A document's catalog is a seed: a
 * property's type is "declared, else the one type its writers agree on"
 * (`lib/domain/effectiveCaseTypes.ts`), so the reader declares little and
 * lets the writers speak: case types in menu order, each child type's
 * parent where every link out of it agrees, one property per name the app
 * writes, loads or reads, choices where select questions write a property,
 * and a type only where a reader needs it to write the same wire, or, for an
 * app Nova holds, where its document declares one (`ReaderInput.knownCaseTypes`).
 */

import { type Draft, produce } from "immer";
import {
	type CasePropertyDataType,
	caseDataTypeForFieldKind,
	caseListColumnTextShows,
	type Uuid,
} from "@/lib/domain";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { casePropertyShowsOptionLabels } from "@/lib/domain/caseListOrder";
import {
	CaseRelationCatalog,
	relationMetadata,
} from "@/lib/domain/caseRelations";
import { columnPropertyCaseType } from "@/lib/domain/columnRelation";
import {
	concreteCasePropertyWriterTypes,
	effectiveCaseTypes,
	materializableCaseTypes,
} from "@/lib/domain/effectiveCaseTypes";
import { slotContext } from "@/lib/domain/expression/context";
import { hiddenWriterVerdicts } from "@/lib/domain/expression/inference";
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
import {
	CASE_SCALAR_PROPERTY_NAMES,
	isStandardCaseListProperty,
} from "@/lib/domain/standardCaseProperties";
import { declaredTypeHolds } from "../../validator/rules/fieldKindMatchesPropertyType";
import { rethrowWorkStop } from "../../workMeter";
import { withCandidate } from "../candidate";
import { defineClaims, refuse } from "../claims";
import type { DraftApp, ReadContext } from "../context";
import {
	agreedComparedTypes,
	type ComparedType,
	comparedTypes,
} from "../expressions/comparedTypes";
import { appPlace } from "../place";
import type { ReaderKnownCaseTypes } from "../types";
import type { DraftField } from "../xform";
import { advancedCaseReading } from "./advancedActions";
import { basicCaseReading, boundDateTime } from "./basicActions";
import { knownCaseTypesOf } from "./knownCaseTypes";
import { saveToCaseReading } from "./saveToCase";

type Catalog = NonNullable<BlueprintDoc["caseTypes"]>;
type CatalogType = Catalog[number];

/** System-owned schemas do not become authored case-type declarations. A menu
 *  that lists worker records reads the derived worker schema. */
const NOT_CATALOGUED: ReadonlySet<string> = new Set([
	"commcare-user",
	"user-owner-mapping-case",
]);

/** Adds `(caseType, name)` to `caseTypes` where the type holds no such
 *  property and the name is no standard property: label the name, placed in
 *  name order by code unit, with the `data_type` `told` says the document Nova
 *  holds declares for it (`ReaderInput.knownCaseTypes`) and none otherwise. A
 *  no-op otherwise, and where the catalog holds no case type of that name: a
 *  property is declared on a type the app has, never on one an expression
 *  names alone. It reads and writes the catalog it is given and nothing else. */
export function noteProperty(
	caseTypes: Draft<NonNullable<BlueprintDoc["caseTypes"]>>,
	caseType: string,
	name: string,
	told?: ReaderKnownCaseTypes,
): void {
	if (isStandardCaseListProperty(name)) return;
	const type = caseTypes.find((candidate) => candidate.name === caseType);
	if (type === undefined) return;
	if (type.properties.some((property) => property.name === name)) return;
	const at = type.properties.findIndex((property) => property.name > name);
	// Untold, no `data_type`: unknown is honest until a writer types the property.
	const dataType = told?.declaredTypeOf(caseType, name);
	const declared = {
		name,
		label: proseText(name),
		...(dataType !== undefined && { data_type: dataType }),
	};
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

/** Bind the declared catalog after all case writers and selections have been
 * read. HQ's index name is scoped to the source type and can reach several
 * different target types, including child and extension relationships. */
function noteParents(
	caseTypes: Catalog,
	links: readonly ReadLink[],
	selections: readonly { readonly child: string; readonly parent: string }[],
	known: ReaderKnownCaseTypes | undefined,
): void {
	const graph = new CaseRelationCatalog([]);
	for (const link of links)
		graph.note(link.child, {
			identifier: link.identifier,
			targetType: link.parent,
			relationship: link.relationship,
		});
	for (const selected of selections) {
		const existing = graph.edges(selected.child, "parent");
		if (!existing.some((edge) => edge.targetType === selected.parent))
			graph.note(selected.child, {
				identifier: "parent",
				targetType: selected.parent,
				relationship: "child",
			});
	}
	for (let at = 0; at < caseTypes.length; at++) {
		const type = caseTypes[at];
		for (const edge of known?.relationsOf?.(type.name) ?? [])
			graph.note(type.name, edge);
		if (
			known?.relationsOf === undefined &&
			graph.edges(type.name, "parent").length === 0
		) {
			const parent = known?.targetOf(type.name, "parent");
			if (parent !== undefined)
				graph.note(type.name, {
					identifier: "parent",
					targetType: parent.caseType,
					...(parent.relationship !== undefined && {
						relationship: parent.relationship,
					}),
				});
		}
		const edges = graph.edges(type.name);
		for (const edge of edges) noteType(caseTypes, edge.targetType);
		const held = edges.filter((edge) =>
			caseTypes.some((one) => one.name === edge.targetType),
		);
		Object.assign(type, relationMetadata(held));
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
 *  a select question: the type its writers agree on, which the
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
		if (![...set].every(isSelect)) continue;
		// One choice and several join on several, a list holding one choice
		// as the text a device stores for it (`ruleSets.ts::agreedStorageType`).
		out.set(key, set.has("multi_select") ? "multi_select" : "single_select");
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

/**
 * Declares on each property of the catalog the type `told` says the document Nova holds declares
 * for it, over what the reading's own rules declared, unless a question that writes it gives values
 * that type cannot hold (the gate's `FIELD_KIND_PROPERTY_TYPE_MISMATCH`, which a change made in
 * CommCare HQ since can make): no print tells a reading a declared type, while every print of a read
 * of the property lowers by it (a sort's comparator, `datetime-coerce`, `format-date`, a comparison
 * of dates and times), so the reading prints the logic as the document it was published from did.
 */
function declareToldTypes(
	draft: Draft<Catalog>,
	told: ReaderKnownCaseTypes | undefined,
	writes: readonly CatalogWrite[],
): void {
	if (told === undefined) return;
	for (const type of draft)
		for (const property of type.properties) {
			const declared = told.declaredTypeOf(type.name, property.name);
			if (declared === undefined) continue;
			const contradicted = writes.some((one) => {
				if (
					one.read === true ||
					one.caseType !== type.name ||
					one.property !== property.name ||
					one.field === undefined
				)
					return false;
				// A date-and-time question saves its moment through its sibling,
				// which only a `datetime` property holds, or its day straight.
				if (one.field.kind === "datetime")
					return declared !== (one.day === true ? "date" : "datetime");
				const given = caseDataTypeForFieldKind(one.field.kind);
				return given !== undefined && !declaredTypeHolds(given, declared);
			});
			if (!contradicted) property.data_type = declared;
		}
}

interface CatalogWrite {
	readonly caseType: string;
	readonly property: string;
	readonly field?: DraftField;
	readonly day?: true;
	readonly read?: true;
}

/** The writers of `write`'s property, preloads left out. */
function writersOf(
	writes: readonly CatalogWrite[],
	write: CatalogWrite,
): CatalogWrite[] {
	return writes.filter(
		(other) =>
			other.read !== true &&
			other.caseType === write.caseType &&
			other.property === write.property,
	);
}

/** Whether a writer gives a property a day: a date-and-time question's
 *  answer saved straight, or a date question's. */
function writesDay(write: CatalogWrite): boolean {
	return write.day === true || write.field?.kind === "date";
}

/**
 * Declares `date` on each property a date-and-time question's answer is
 * saved straight to, where every writer of it gives a day: HQ's build binds
 * the case block's leaf with no type, so Core keeps the answer's day
 * (`Recalculate.wrapData`), and Nova saves a date-and-time question to a
 * `date` property straight (`ruleSets.ts::isAnswerWriteAssignable`). A
 * property another writer gives something else is `mixedDays`'s.
 */
function declareDays(
	draft: Draft<Catalog>,
	writes: readonly CatalogWrite[],
): void {
	for (const one of writes) {
		if (one.day !== true) continue;
		if (!writersOf(writes, one).every(writesDay)) continue;
		const property = draft
			.find((type) => type.name === one.caseType)
			?.properties.find((candidate) => candidate.name === one.property);
		if (property !== undefined && property.data_type === undefined)
			property.data_type = "date";
	}
}

/** Each property a date-and-time question's day is saved straight to beside
 *  a writer that gives it no day: a pair of writers no one type holds
 *  (`any-other-mixed-writer-pair`), once per property. */
function mixedDays(
	writes: readonly CatalogWrite[],
): { readonly caseType: string; readonly property: string }[] {
	const mixed = new Map<string, { caseType: string; property: string }>();
	for (const one of writes) {
		if (one.day !== true || writersOf(writes, one).every(writesDay)) continue;
		mixed.set(JSON.stringify([one.caseType, one.property]), {
			caseType: one.caseType,
			property: one.property,
		});
	}
	return [...mixed.values()];
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
 * `doc` with each property a case type holds carried onto each type a change
 * of the document gives such a case (an update's `retype`), where that type
 * holds no property of the name, or holds it untyped (only a read names it
 * there: no writer of that type types it and no declaration the reading
 * derives, such as a sort's or a date Search field's, does): as the earlier
 * type holds it, typed as the earlier type's writers and declaration type it. A device and CommCare HQ's
 * server change only a case's type and keep every property as it is (Core's
 * `CaseXmlParser.updateCase`; HQ's `update_strategy.py::SqlCaseUpdateStrategy.
 * _apply_update_action`), so the later type holds what the earlier one does,
 * and Nova changes a case's type only where it does
 * (`lib/domain/caseRetype.ts::planCaseRetype`, which this answers over the
 * same effective catalog). A property both types type, as two types, stays
 * as it is, the gate's refusal. Chains of changes are carried until nothing
 * moves; `doc` itself where nothing does. A carried property is in no export:
 * no change of the later type writes it and nothing reads it there.
 */
export function carryRetypedProperties(doc: BlueprintDoc): BlueprintDoc {
	const changes: { readonly from: string; readonly to: string }[] = [];
	for (const form of Object.values(doc.forms))
		for (const one of form?.caseOperations ?? [])
			if (
				one.action === "update" &&
				one.retype !== undefined &&
				one.retype !== one.caseType &&
				one.target.kind !== "worker-record"
			)
				changes.push({ from: one.caseType, to: one.retype });
	let current = doc;
	// Each round carries at least one property, and a chain of n changes
	// carries in at most n rounds.
	for (let round = 0; round <= changes.length; round++) {
		const effective = materializableCaseTypes(current);
		const carried: {
			readonly caseType: string;
			readonly property: string;
			readonly dataType: CasePropertyDataType | undefined;
		}[] = [];
		for (const { from, to } of changes) {
			const source = effective.find((type) => type.name === from);
			const destination = effective.find((type) => type.name === to);
			if (source === undefined || destination === undefined) continue;
			for (const property of source.properties) {
				if (CASE_SCALAR_PROPERTY_NAMES.has(property.name)) continue;
				if (
					carried.some(
						(one) => one.caseType === to && one.property === property.name,
					)
				)
					continue;
				const held = destination.properties.find(
					(one) => one.name === property.name,
				);
				// A property the later type holds and types (a writer of its own, or
				// a declaration the reading derives) stays as it is; one it holds
				// only through a read takes the earlier type's type.
				if (
					held !== undefined &&
					(held.data_type !== undefined || property.data_type === undefined)
				)
					continue;
				carried.push({
					caseType: to,
					property: property.name,
					dataType: property.data_type,
				});
			}
		}
		if (carried.length === 0) return current;
		current = withCandidate(current, (draft) => {
			const catalog = (draft.caseTypes ?? []) as Draft<Catalog>;
			for (const one of carried) {
				noteProperty(catalog, one.caseType, one.property);
				const declared = catalog
					.find((type) => type.name === one.caseType)
					?.properties.find((entry) => entry.name === one.property);
				if (declared !== undefined && one.dataType !== undefined)
					declared.data_type = one.dataType;
			}
		});
	}
	return current;
}

/**
 * The catalog of the reading, written into the draft from what the
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
		/** A date-and-time question's answer saved straight, its day. */
		day?: true;
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
							...(write.value.day === true && { day: true }),
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
						...(write.value.day === true && { day: true }),
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
				const destinations =
					block.typeChoice === undefined
						? [destination]
						: [destination, block.typeChoice.otherwise];
				for (const type of destinations) noteType(caseTypes, type);
				for (const write of block.writes) {
					// A value that is one question's answer is that question's write.
					const field =
						write.value.kind === "text"
							? write.value.readsField
							: write.value.field;
					for (const type of destinations)
						writes.push({
							caseType: type,
							property: write.property,
							...(field !== undefined && { field }),
							...(boundDateTime(form, field) && { dateTime: true }),
						});
				}
				for (const link of block.links) {
					noteType(caseTypes, link.targetType);
					if (link.target === null) continue;
					links.push({
						child: destination,
						identifier: link.identifier,
						parent: link.targetType,
						relationship: link.relationship,
					});
				}
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
	// A link names its target's type, which the catalog declares, as the gate
	// holds every link's (`CASE_OPERATION_UNKNOWN_CASE_TYPE`): an unlink's too,
	// whose type no other change may name. After every type a change names, so
	// a type some change names keeps its place.
	for (const link of links) noteType(caseTypes, link.parent);
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
		declareDays(draft, writes);
		declareToldTypes(draft, ctx.input.knownCaseTypes, writes);
		DATETIME_DECLARATIONS.set(ctx, declareHiddenDateTimes(draft, writes));
	});
	for (const mixed of mixedDays(writes)) {
		reportedPairs(ctx).add(JSON.stringify([mixed.caseType, mixed.property]));
		const menu = app.modules.find(
			(module) => module.module.caseType === mixed.caseType,
		);
		ctx.accounting.finding(WRITER_CLAIMS.otherPair, menu?.place ?? appPlace(), {
			name: mixed.property,
		});
	}
	/* An app with no case type holds no catalog, as a new app does
	 * (`emptyBlueprintDoc`): an empty one prints the same bytes, and the
	 * document a birth builds from the construction batch holds none. */
	ctx.writeDraft(() => {
		app.caseTypes = next.length === 0 ? null : (next as Catalog);
	});
}

/** The properties whose writers a reading already found agree on no type. */
const REPORTED_PAIRS = new WeakMap<ReadContext, Set<string>>();

function reportedPairs(ctx: ReadContext): Set<string> {
	let reported = REPORTED_PAIRS.get(ctx);
	if (reported === undefined) {
		reported = new Set();
		REPORTED_PAIRS.set(ctx, reported);
	}
	return reported;
}

const WRITER_CLAIMS = defineClaims("caseManagement.catalog", {
	otherPair: refuse(`forms-and-case-writes/any-other-mixed-writer-pair`, null),
});

/**
 * The writers of each property judged over the bound document
 * (`concreteCasePropertyWriterTypes`): writers that agree on one stored type
 * (`agreedStorageType`: `int` with `decimal` on `decimal`, `text` with
 * `single_select` on `text`, `single_select` with `multi_select` on
 * `multi_select`), or that are saved as text
 * (`ruleSets.ts::joinsAsText`, which adds the one type `text`), are one type
 * Nova holds, with nothing claimed, since those entries name no key; writers
 * that do not are the manifest's row for their pair, one finding per
 * property, at the first menu of its case type. A Hidden Value whose own
 * results agree on no type names each of theirs there, and one the gate
 * refuses beside the property's other writers
 * (`inference.ts::hiddenWriterVerdicts`, reason `type` or
 * `hidden-disagreement`) is the same row, so the reading refuses what the
 * gate refuses.
 */
export function settleWriterTypes(
	ctx: ReadContext,
	app: DraftApp,
	doc: BlueprintDoc,
): void {
	let opinions: ReturnType<typeof concreteCasePropertyWriterTypes>;
	let verdicts: ReturnType<typeof hiddenWriterVerdicts>;
	try {
		opinions = concreteCasePropertyWriterTypes(doc);
		verdicts = hiddenWriterVerdicts(doc);
	} catch (error) {
		rethrowWorkStop(error);
		return;
	}
	const found = reportedPairs(ctx);
	const finding = (
		caseType: string,
		property: string,
		claim: (typeof WRITER_CLAIMS)[keyof typeof WRITER_CLAIMS],
	): void => {
		const key = JSON.stringify([caseType, property]);
		if (found.has(key)) return;
		found.add(key);
		const menu = app.modules.find(
			(module) => module.module.caseType === caseType,
		);
		ctx.accounting.finding(claim, menu?.place ?? appPlace(), {
			name: property,
		});
	};
	for (const [caseType, byProperty] of opinions) {
		if (NOT_CATALOGUED.has(caseType)) continue;
		for (const [property, types] of byProperty) {
			if (types.size < 2 || agreedStorageType(types) !== undefined) continue;
			finding(caseType, property, WRITER_CLAIMS.otherPair);
		}
	}
	for (const verdict of verdicts) {
		const { caseType, property } = verdict.writer;
		if (NOT_CATALOGUED.has(caseType)) continue;
		if (
			verdict.findings.some(
				(one) => one.reason === "type" || one.reason === "hidden-disagreement",
			)
		)
			finding(caseType, property, WRITER_CLAIMS.otherPair);
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
 *  `via` on the menu's, a column's with a `via` on the type its walk reaches,
 *  whose read the list's field prints, and a field's with a `via` on the type
 *  the relation reaches, whose read the search's own filter prints. */
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
	for (const column of config?.columns ?? []) {
		if (typeof column.field !== "string") continue;
		// The worker's own record is no case type the app declares: a column
		// reads its property as the record holds it, declared or not.
		if (column.readFrom === "worker-record") continue;
		if (column.via === undefined) {
			out.push({ caseType, property: column.field });
			continue;
		}
		const destination = resolveRelationDestination(
			{
				kind: "ancestor",
				via: column.via,
			} as Parameters<typeof resolveRelationDestination>[0],
			caseType,
			caseTypes,
		);
		if (destination.ok)
			out.push({ caseType: destination.caseType, property: column.field });
	}
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

/** Every property reference a document's expressions and texts hold, by
 *  structure: a record read (`prop`), on the type its relation reaches from the
 *  type it starts from, a form's read of its case (`form-case`), or a text's
 *  reference to a case property (`case-ref`). */
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
	// A text's reference to a case property (`case-ref`) prints as the read of that property
	// (`lib/domain/proseExpression.ts::proseReferenceExpression`, a `form-case` term), which the
	// reader declares as any read's.
	if (
		(record.kind === "prop" ||
			record.kind === "form-case" ||
			record.kind === "case-ref") &&
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
		} catch (error) {
			rethrowWorkStop(error);
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
 *  `ReaderInput.knownCaseTypes`); properties by `noteProperty`; `data_type`
 *  the document's own on each property it keeps (a reading of its export is
 *  told that too), else where every writer is a select question of one kind
 *  or a record slot's comparison gives one; choices where
 *  select questions write a property, and as each plain column states them;
 *  and each property a type holds carried onto each type a change of the
 *  document gives such a case (`carryRetypedProperties`). */
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
				const destinations =
					op.action === "create" && op.typeChoice !== undefined
						? [destination, op.typeChoice.otherwise]
						: [destination];
				for (const type of destinations) noteType(caseTypes, type);
				for (const write of op.writes ?? []) {
					// A write through an index saves to a case above; its type is the
					// expression stage's to note, by the read it binds.
					if (write.via !== undefined) continue;
					const value = write.value;
					const field =
						value.kind === "term" && value.term.kind === "field"
							? doc.fields[value.term.uuid]
							: undefined;
					for (const type of destinations)
						writes.push({
							caseType: type,
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
				for (const link of op.links ?? []) {
					noteType(caseTypes, link.targetType);
					if (link.target === null) continue;
					links.push({
						child: destination,
						identifier: link.identifier,
						parent: link.targetType,
						relationship: link.relationship,
					});
				}
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
	const selects = selectTypes(writes);
	const readCatalog = produce(caseTypes, (draft) => {
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
			)) {
				// A column read through a relation names the type its walk reaches,
				// which the list reader declares where nothing else does
				// (`caseList/details.ts`).
				if (
					one.caseType !== module.caseType &&
					CASE_TYPE_PATTERN.test(one.caseType) &&
					!NOT_CATALOGUED.has(one.caseType) &&
					!draft.some((type) => type.name === one.caseType)
				)
					draft.push({ name: one.caseType, properties: [] });
				noteProperty(draft, one.caseType, one.property);
			}
			for (const type of module.caseListConfig?.additionalCaseTypes ?? [])
				noteType(draft, type);
			for (const filter of module.caseListConfig?.searchFilters ?? [])
				if (filter.kind === "request-record-type")
					noteType(draft, filter.caseType);
			const search = module.caseSearchConfig;
			if (
				search &&
				"relatedRecordIdProperty" in search &&
				search.relatedRecordIdProperty
			)
				noteProperty(draft, module.caseType, search.relatedRecordIdProperty);
			// A Details tab's child type, and the related type a search requests
			// beside a tab's own rows, are types the list reader declares
			// (`caseList/details.ts`).
			for (const tab of module.caseListConfig?.detailTabs ?? []) {
				const source = tab.rowSource;
				const named =
					source?.kind === "children"
						? source.caseType
						: source?.includeChildrenOfType;
				if (
					named !== undefined &&
					CASE_TYPE_PATTERN.test(named) &&
					!NOT_CATALOGUED.has(named) &&
					!draft.some((type) => type.name === named)
				)
					draft.push({ name: named, properties: [] });
			}
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
		// Every property kept keeps the type the document declares for it, as a
		// reading of its export is told it (`ReaderInput.knownCaseTypes`) and
		// declares it (`noteProperty`, `declareToldTypes`): no print tells a
		// reading a declared type, and every print of a read of the property
		// lowers by it. The gate holds a declaration to the questions writing the
		// property (`FIELD_KIND_PROPERTY_TYPE_MISMATCH`), so none contradicts one.
		for (const type of doc.caseTypes ?? []) {
			const kept = draft.find((one) => one.name === type.name);
			if (kept === undefined) continue;
			for (const property of type.properties) {
				const entry = kept.properties.find((one) => one.name === property.name);
				if (entry !== undefined && property.data_type !== undefined)
					entry.data_type = property.data_type;
			}
		}
		// The writer supplies the ordinary choices. Only a column actually showing labels
		// states their catalog order and wording independently of the writer.
		const effective = effectiveCaseTypes(doc);
		const stated = new Set<string>();
		for (const uuid of doc.moduleOrder) {
			const module = doc.modules[uuid];
			const caseType = module?.caseType;
			if (caseType === undefined) continue;
			for (const column of module?.caseListConfig?.columns ?? []) {
				if (
					column.kind !== "plain" ||
					column.showChoice === "saved-value" ||
					!caseListColumnTextShows(column)
				)
					continue;
				// A column read through a relation states the reached type's choices.
				const owner = columnPropertyCaseType(
					column,
					caseType,
					doc.caseTypes ?? [],
				);
				if (owner === undefined) continue;
				const shown = effective
					.find((type) => type.name === owner)
					?.properties.find((one) => one.name === column.field);
				const entry = draft
					.find((type) => type.name === owner)
					?.properties.find((one) => one.name === column.field);
				if (shown === undefined || entry === undefined) continue;
				if (!casePropertyShowsOptionLabels(shown)) continue;
				const key = `${owner}\u0000${column.field}`;
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
	// A changed case keeps its properties under its later type, as the
	// reading holds them (`settleCaseManagement`).
	return (carryRetypedProperties({
		...doc,
		caseTypes: readCatalog,
	} as BlueprintDoc).caseTypes ?? readCatalog) as Catalog;
}
