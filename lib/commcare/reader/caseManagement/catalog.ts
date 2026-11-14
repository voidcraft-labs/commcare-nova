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
import type { CasePropertyDataType } from "@/lib/domain";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import { CASE_TYPE_PATTERN } from "@/lib/domain/expression/types";
import { type ProseTemplate, proseText } from "@/lib/domain/prose";
import { isStandardCaseListProperty } from "@/lib/domain/standardCaseProperties";
import type { DraftApp, ReadContext } from "../context";
import type { DraftField } from "../xform";
import { advancedCaseReading } from "./advancedActions";
import { basicCaseReading } from "./basicActions";
import { saveToCaseReading } from "./saveToCase";

type Catalog = NonNullable<BlueprintDoc["caseTypes"]>;
type CatalogType = Catalog[number];

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
 *  gives its menu's case type a parent where no link says otherwise. */
function noteParents(
	caseTypes: Catalog,
	links: readonly ReadLink[],
	selections: readonly { readonly child: string; readonly parent: string }[],
): void {
	for (const type of caseTypes) {
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
	}
}

/** The inline choices a select question offers, by value, first label kept. */
function noteChoices(
	property: Draft<CatalogType["properties"][number]>,
	options: readonly { readonly value: string; readonly label: ProseTemplate }[],
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
		| { kind: string; options?: { value: string; label: ProseTemplate }[] }
		| undefined;
	return source?.kind === "inline" ? (source.options ?? []) : [];
}

function isSelect(kind: unknown): boolean {
	return kind === "single_select" || kind === "multi_select";
}

/**
 * Step 3: the catalog of the reading, written into the draft from what the
 * structure and case readers read: every menu's case type, every child
 * case's, open action's and Save to Case block's, in menu order; each child
 * type's parent; one property per property written or preloaded and per
 * column and simple Search field the drafts hold; and each select-written
 * property's choices. A property an expression reads is noted by the
 * expression stage through `noteProperty`.
 */
export function readCaseCatalog(ctx: ReadContext, app: DraftApp): void {
	const caseTypes: Catalog = [];
	for (const module of app.modules) {
		const stored = module.module.caseType ?? module.json.peek("case_type");
		noteType(caseTypes, typeof stored === "string" ? stored : undefined);
	}
	const links: ReadLink[] = [];
	const writes: { caseType: string; property: string; field?: DraftField }[] =
		[];
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
				for (const write of block.writes)
					writes.push({
						caseType: destination,
						property: write.property,
						...(write.value.kind === "capture" && { field: write.value.field }),
					});
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
	noteParents(caseTypes, links, selections);
	const next = produce(caseTypes, (draft) => {
		for (const write of writes) {
			noteProperty(draft, write.caseType, write.property);
			const kind = write.field?.kind;
			if (write.field === undefined || !isSelect(kind)) continue;
			const property = draft
				.find((type) => type.name === write.caseType)
				?.properties.find((one) => one.name === write.property);
			if (property !== undefined)
				noteChoices(property, inlineOptions(write.field.field));
		}
		for (const module of app.modules) {
			const caseType = module.module.caseType;
			if (caseType === undefined) continue;
			for (const property of listProperties(module.module))
				noteProperty(draft, caseType, property);
		}
	});
	ctx.writeDraft(() => {
		app.caseTypes = next as Catalog;
	});
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

/** The properties a menu's case list and its simple Search fields name. */
function listProperties(module: Readonly<Record<string, unknown>>): string[] {
	const out: string[] = [];
	const config = module.caseListConfig as
		| {
				columns?: readonly Readonly<Record<string, unknown>>[];
				searchInputs?: readonly Readonly<Record<string, unknown>>[];
		  }
		| undefined;
	for (const column of config?.columns ?? [])
		if (typeof column.field === "string") out.push(column.field);
	for (const input of config?.searchInputs ?? [])
		if (
			input.kind === "simple" &&
			typeof input.property === "string" &&
			input.via === undefined
		)
			out.push(input.property);
	return out;
}

/** Every property reference a document's expressions hold, by structure:
 *  a record read (`prop`) or a form's read of its case (`form-case`). */
function expressionReads(
	value: unknown,
	out: { caseType: string; property: string }[],
): void {
	if (Array.isArray(value)) {
		for (const one of value) expressionReads(one, out);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	const record = value as Readonly<Record<string, unknown>>;
	if (
		(record.kind === "prop" || record.kind === "form-case") &&
		typeof record.caseType === "string" &&
		typeof record.property === "string"
	)
		out.push({ caseType: record.caseType, property: record.property });
	for (const one of Object.values(record)) expressionReads(one, out);
}

/** The properties that a sorted column, a date Search field or a date range
 *  Search field reads, each with the types its reader keeps declared where
 *  no writer types the property. */
function typedReaders(
	doc: BlueprintDoc,
): Map<string, ReadonlySet<CasePropertyDataType>> {
	const out = new Map<string, Set<CasePropertyDataType>>();
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
		for (const column of module.caseListConfig?.columns ?? []) {
			const field = (column as { field?: unknown }).field;
			if (column.sort !== undefined && typeof field === "string")
				add(caseType, field, ["int", "decimal"]);
		}
		for (const input of module.caseListConfig?.searchInputs ?? []) {
			const record = input as {
				kind?: string;
				property?: unknown;
				type?: unknown;
				via?: unknown;
			};
			if (
				record.kind !== "simple" ||
				typeof record.property !== "string" ||
				record.via !== undefined
			)
				continue;
			if (record.type === "date")
				add(caseType, record.property, ["date", "datetime"]);
			if (record.type === "date-range")
				add(caseType, record.property, ["date"]);
		}
	}
	return out;
}

/** The catalog this section's rules give over the document's own menus,
 *  operations, preloads, columns, search fields and expression reads: types
 *  in menu order; `parent_type` and `relationship` where the document's
 *  links agree; properties by `noteProperty`; `data_type` only under the
 *  four rules of the table above. */
export function catalogAsRead(
	doc: BlueprintDoc,
): NonNullable<BlueprintDoc["caseTypes"]> {
	const caseTypes: Catalog = [];
	const links: ReadLink[] = [];
	const writes: {
		caseType: string;
		property: string;
		options?: readonly { value: string; label: ProseTemplate }[];
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
	noteParents(caseTypes, links, selections);
	const reads: { caseType: string; property: string }[] = [];
	expressionReads(doc.fields, reads);
	expressionReads(doc.forms, reads);
	expressionReads(doc.modules, reads);
	const readers = typedReaders(doc);
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
			for (const property of listProperties(
				module as unknown as Readonly<Record<string, unknown>>,
			))
				noteProperty(draft, module.caseType, property);
		}
		for (const read of reads) noteProperty(draft, read.caseType, read.property);
		// A type declared only where a reader keeps it and no writer types the property.
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
				const wants = readers.get(key);
				if (keep === undefined || wants === undefined || !wants.has(keep))
					continue;
				const derived = untyped
					.find((one) => one.name === type.name)
					?.properties.find((one) => one.name === property.name)?.data_type;
				if (derived === undefined) property.data_type = keep;
			}
	}) as Catalog;
}
