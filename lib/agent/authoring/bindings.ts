import { formUserProperty } from "@/lib/commcare/xpath/referenceBindings";
import {
	computeFieldPath,
	findContainingForm,
} from "@/lib/doc/mutations/helpers";
import {
	asUuid,
	type BlueprintDoc,
	type CaseType,
	caseDataTypeForFieldKind,
	caseSelectionCardinality,
	effectiveCaseTypes,
	type FieldKind,
	type Module,
	moduleUuidOfForm,
	searchInputRuntimeValueType,
	type Uuid,
} from "@/lib/domain";
import {
	type RecordQueryContext,
	recordQueryContext,
	type SearchInputDecl,
} from "@/lib/domain/expression/context";
import type { FormStructure } from "@/lib/domain/expression/formStructure";
import { resolveRelationDestination } from "@/lib/domain/expression/relationDestination";
import {
	type Choice,
	type Literal,
	type RelationPath,
	type Term,
	termSchema,
} from "@/lib/domain/expression/types";
import { formRecordScope } from "@/lib/domain/formRecordScope";
import { isSearchOnlyCaseProperty } from "@/lib/domain/standardCaseProperties";
import { userPropertiesOf } from "@/lib/domain/users";
import type { LookupTableDefinition } from "@/lib/lookup/types";
import { AuthoringInputError } from "./errors";
import { quoteAuthoringLiteral as quote } from "./expressionSyntax";
import { fieldNameCandidates, fieldPathCandidates } from "./fieldNames";
import type { QueryPrintContext } from "./printQueryExpression";
import type { QueryBindings } from "./queryExpressions";

export interface NamedAuthoringField {
	uuid: Uuid;
	path: string;
	kind: FieldKind;
}

/** A nested value inherits its enclosing table and the Search validation slot.
 * Reads and writes use this same scope selection. */
export function enclosingAuthoringTable(
	input: unknown,
	path: readonly (string | number)[],
	initial?: string,
) {
	let enclosing = input;
	let tableId = initial;
	for (const segment of path) {
		if (enclosing !== null && typeof enclosing === "object") {
			if ("tableId" in enclosing && typeof enclosing.tableId === "string")
				tableId = enclosing.tableId;
			enclosing = (enclosing as Record<string | number, unknown>)[segment];
		}
	}
	return tableId;
}

export function authoringValueScope(
	options: AuthoringScopeOptions,
	input: unknown,
	path: readonly (string | number)[],
	searchValidation = false,
): AuthoringScope {
	let enclosing = input;
	let candidateCaseType: string | undefined;
	for (const segment of path) {
		if (enclosing !== null && typeof enclosing === "object") {
			if (
				"kind" in enclosing &&
				enclosing.kind === "cases" &&
				"caseType" in enclosing &&
				typeof enclosing.caseType === "string"
			)
				candidateCaseType = enclosing.caseType;
			enclosing = (enclosing as Record<string | number, unknown>)[segment];
		}
	}
	return new AuthoringScope({
		...options,
		...(candidateCaseType && {
			candidateCaseType,
			selectedCaseType: options.currentCaseType,
			currentCaseType: candidateCaseType,
		}),
		tableId: enclosingAuthoringTable(input, path, options.tableId),
		...(searchValidation &&
			path.some((part) => part === "required" || part === "validation") && {
				patternMatching: true,
			}),
	});
}
export interface AuthoringScopeOptions {
	doc: BlueprintDoc;
	formUuid?: Uuid;
	moduleUuid?: Uuid;
	currentCaseType?: string;
	/** Complete call-local names, including additions and both sides of a rename. */
	fields?: readonly NamedAuthoringField[];
	form?: FormStructure;
	inputs?: readonly SearchInputDecl[];
	caseTypes?: readonly CaseType[];
	/** Authoritatively Project-scoped, rows-free data definitions. */
	tables?: readonly LookupTableDefinition[];
	locations?: readonly { uuid: Uuid; name: string; siteCode?: string }[];
	operations?: readonly { uuid: Uuid; name: string }[];
	tableId?: string;
	candidateCaseType?: string;
	selectedCaseType?: string;
	patternMatching?: true;
	ownerValues?: boolean;
}

function one<T>(
	values: readonly T[],
	matches: (value: T) => boolean,
	describe: string,
): T {
	const found = values.filter(matches);
	if (found.length !== 1)
		throw new AuthoringInputError(
			`${describe} is ${found.length ? "ambiguous" : "not in this scope"}.`,
		);
	return found[0];
}

/** One invocation's names and types. This is a view over the canonical document
 * and prepared declarations, never another document or mutation engine. */
export class AuthoringScope implements QueryBindings, QueryPrintContext {
	get formUuid() {
		return this.options.formUuid;
	}
	readonly typeContext: RecordQueryContext;
	get currentCaseType() {
		return this.options.currentCaseType;
	}
	private readonly formCaseTypes: ReadonlySet<string> | undefined;
	readonly fields: readonly NamedAuthoringField[];
	private readonly inputs: readonly SearchInputDecl[];
	private readonly tables: readonly LookupTableDefinition[];
	constructor(private readonly options: AuthoringScopeOptions) {
		const { doc, formUuid } = options;
		const moduleUuid =
			options.moduleUuid ??
			(formUuid ? moduleUuidOfForm(doc, formUuid) : undefined);
		const module = moduleUuid ? doc.modules[moduleUuid] : undefined;
		this.fields =
			options.fields ??
			Object.values(doc.fields)
				.filter(
					(field) =>
						formUuid !== undefined &&
						findContainingForm(doc, field.uuid) === formUuid,
				)
				.map((field) => {
					const path = computeFieldPath(doc, field.uuid);
					if (!path)
						throw new AuthoringInputError(
							`Field ${field.id} has no path in this form.`,
						);
					return { uuid: field.uuid, path, kind: field.kind };
				});
		this.inputs =
			options.inputs ??
			(module?.caseListConfig?.searchInputs ?? []).map((input) => ({
				uuid: input.uuid,
				name: input.name,
				data_type: searchInputRuntimeValueType(input),
			}));
		this.tables = options.tables ?? [];
		const lookupTables = new Map(
			this.tables.map((table) => [
				table.id,
				new Map(table.columns.map((column) => [column.id, column.dataType])),
			]),
		);
		const table = options.tableId ? this.table(options.tableId) : undefined;
		this.formCaseTypes =
			options.candidateCaseType && formUuid
				? formRecordScope(doc, formUuid).caseTypes
				: undefined;
		this.typeContext = recordQueryContext({
			caseTypes: options.caseTypes ?? effectiveCaseTypes(doc),
			currentCaseType: options.currentCaseType,
			knownInputs: this.inputs,
			formFieldTypes: new Map(
				this.fields.map((field) => [
					field.uuid,
					caseDataTypeForFieldKind(field.kind),
				]),
			),
			operationIds: new Set(
				options.operations?.map((operation) => operation.uuid),
			),
			organizationLevels: doc.organizationLevels,
			userPropertySlugs: new Map(
				Object.values(userPropertiesOf(doc)).map((property) => [
					property.uuid,
					property.slug,
				]),
			),
			lookupTables,
			...(table === undefined ? {} : { lookupTableId: table.id }),
		});
	}
	private table(name: string) {
		const identity = this.tables.find((table) => table.id === name);
		if (identity) return identity;
		return one(
			this.tables,
			(table) => table.id === name || table.name === name || table.tag === name,
			`Data table ${name}`,
		);
	}
	resolveField = (segments: readonly string[]): Uuid | undefined => {
		const candidates = fieldNameCandidates(segments.join("/"), this.fields);
		return candidates.length === 1 ? candidates[0].uuid : undefined;
	};
	resolveFieldPath = (segments: readonly string[]): Uuid | undefined => {
		const candidates = fieldPathCandidates(segments.join("/"), this.fields);
		return candidates.length === 1 ? candidates[0].uuid : undefined;
	};
	resolveSearchInput = (name: string): Uuid | undefined => {
		const identity = this.inputs.find((input) => input.uuid === name);
		if (identity) return identity.uuid;
		const ids = new Set(
			this.inputs
				.filter((input) => input.name === name)
				.map((input) => input.uuid),
		);
		return ids.size === 1 ? [...ids][0] : undefined;
	};
	reference(namespace: string, path: readonly string[]): Term;
	reference(term: Term): string | undefined;
	reference(
		value: string | Term,
		path: readonly string[] = [],
	): Term | string | undefined {
		if (typeof value !== "string") return this.printReference(value);
		const name = path.join("/");
		if (value === "form") {
			const uuid = this.resolveField(path);
			if (!uuid)
				throw new AuthoringInputError(
					`Field ${name} is missing or ambiguous in this form.`,
				);
			return { kind: "field", uuid };
		}
		if (value === "search") {
			const uuid = this.resolveSearchInput(name);
			if (!uuid)
				throw new AuthoringInputError(
					`Search answer ${name} is missing or ambiguous.`,
				);
			return { kind: "input", searchInputUuid: uuid };
		}
		if (value === "user") {
			const properties = Object.values(this.options.doc.userProperties ?? {});
			const byId = properties.find((property) => property.uuid === name);
			const uuid =
				byId?.uuid ??
				(() => {
					const resolved = formUserProperty(this.options, name);
					return resolved.kind === "session-user-property"
						? resolved.userPropertyUuid
						: undefined;
				})();
			if (uuid)
				return {
					kind: "session-user-property",
					userPropertyUuid: asUuid(uuid),
				};
			if (
				properties.some(
					(property) => property.slug.toLowerCase() === name.toLowerCase(),
				)
			)
				throw new AuthoringInputError(
					`Worker information ${name} is ambiguous or has different capitalization.`,
				);
			throw new AuthoringInputError(
				`Worker information ${name} is not declared. Choose an app worker property, session('userid') or session('username') for built-in identity, or external-user(${quote(name)}) for custom data supplied outside this app.`,
			);
		}
		if (
			value === "row" &&
			this.options.candidateCaseType &&
			!this.options.tableId
		) {
			return termSchema.parse({
				kind: "prop",
				caseType: this.currentCaseType,
				property: name,
			});
		}
		if (
			this.options.candidateCaseType &&
			(value === "case" || this.formCaseTypes?.has(value))
		) {
			const caseType = value === "case" ? this.options.selectedCaseType : value;
			if (!caseType || !this.formCaseTypes?.has(caseType))
				throw new AuthoringInputError(
					"This form has no selected record in that scope.",
				);
			return termSchema.parse({ kind: "form-case", caseType, property: name });
		}
		if (value === "row") {
			if (!this.options.tableId)
				throw new AuthoringInputError(
					"A row reference needs a data-table scope.",
				);
			const table = this.table(this.options.tableId);
			const column = this.column(table, name);
			return { kind: "table-column", tableId: table.id, columnId: column.id };
		}
		if (value === "record" && path.length !== 2)
			throw new AuthoringInputError(
				"A record reference needs exactly one record type and property.",
			);
		const caseType =
			value === "case"
				? this.currentCaseType
				: value === "record"
					? path[0]
					: value;
		const property = value === "record" ? path[1] : name;
		const type = this.typeContext.facts.caseTypes.find(
			(type) => type.name === caseType,
		);
		if (!type || !property)
			throw new AuthoringInputError(
				`Record ${caseType ?? "in this context"} is not available.`,
			);
		if (this.currentCaseType && type.name !== this.currentCaseType)
			throw new AuthoringInputError(
				`This scope reads ${this.currentCaseType}; use a relationship to read ${type.name}.`,
			);
		// A search-only property (Date closed) parses as any property; the
		// checker decides which slots can read it.
		if (
			!isSearchOnlyCaseProperty(property) &&
			!type.properties.some((candidate) => candidate.name === property)
		)
			throw new AuthoringInputError(
				`Record ${type.name} has no property ${property}.`,
			);
		return termSchema.parse({ kind: "prop", caseType: type.name, property });
	}
	choice(fieldUuid: Uuid, value: Literal): Literal | Choice {
		if (typeof value.value !== "string") return value;
		const prepared = this.options.form?.fields.get(fieldUuid);
		const saved = this.options.doc.fields[fieldUuid];
		const kind = prepared?.kind ?? saved?.kind;
		const source =
			prepared?.choices ??
			(saved !== undefined && "optionsSource" in saved
				? saved.optionsSource
				: undefined);
		if (source?.kind !== "inline") return value;
		const values =
			kind === "multi_select"
				? value.value.split(/\s+/u).filter(Boolean)
				: [value.value];
		const options = values.map(
			(selected) =>
				source.options.find((option) => option.value === selected)?.uuid,
		);
		if (
			options.length === 0 ||
			!options.every((uuid): uuid is Uuid => uuid !== undefined)
		)
			return value;
		return {
			kind: "choice",
			field: fieldUuid,
			options: options as [Uuid, ...Uuid[]],
		};
	}
	choiceValues(
		field: Uuid,
		options: readonly Uuid[],
	): readonly string[] | undefined {
		const prepared = this.options.form?.fields.get(field)?.choices;
		const saved = this.options.doc.fields[field];
		const source =
			prepared ??
			(saved !== undefined && "optionsSource" in saved
				? saved.optionsSource
				: undefined);
		if (source?.kind !== "inline") return undefined;
		const values = options.map(
			(uuid) => source.options.find((option) => option.uuid === uuid)?.value,
		);
		return values.every((value): value is string => value !== undefined)
			? values
			: undefined;
	}
	private column(table: LookupTableDefinition, name: string) {
		const identity = table.columns.find((column) => column.id === name);
		if (identity) return identity;
		return one(
			table.columns,
			(column) =>
				column.id === name || column.wireName === name || column.label === name,
			`Column ${name} in ${table.name}`,
		);
	}
	/** The app's menus, in menu order. */
	private modules(): Module[] {
		const { doc } = this.options;
		return doc.moduleOrder
			.map((uuid) => doc.modules[uuid])
			.filter((module): module is Module => module !== undefined);
	}
	/** A menu by its UUID, its name or its id, matching exactly one module. */
	private module(name: string): Module {
		const modules = this.modules();
		const identity = modules.find((module) => module.uuid === name);
		if (identity) return identity;
		const found = modules.filter(
			(module) => module.name === name || module.id === name,
		);
		if (found.length === 1) return found[0];
		if (found.length > 1)
			throw new AuthoringInputError(
				`More than one menu is called ${name}. You can name the one you mean by its ID: ${found.map((module) => module.uuid).join(", ")}.`,
			);
		throw new AuthoringInputError(
			modules.length === 0
				? `This app has no menu called ${name}.`
				: `This app has no menu called ${name}. You can use one of its menus: ${modules.map((module) => module.name).join(", ")}.`,
		);
	}
	chosenCaseMenu(name: string): { module: Uuid; caseType: string } {
		const module = this.module(name);
		if (module.caseType === undefined) {
			const choosing = this.modules().find(
				(candidate) => candidate.caseType !== undefined,
			);
			throw new AuthoringInputError(
				`${module.name} doesn't ask the worker to choose a case, so there's no chosen case to read.${choosing ? ` You can use a menu that does, such as ${choosing.name}.` : ""}`,
			);
		}
		if (caseSelectionCardinality(module) !== "single")
			throw new AuthoringInputError(
				`In ${module.name} the worker chooses several cases at once, so there's no one chosen case to read. You can use a menu where one case is chosen.`,
			);
		return { module: module.uuid, caseType: module.caseType };
	}
	identity(
		kind: "table" | "column" | "operation" | "location" | "level" | "module",
		name: string,
		owner?: string,
	): string {
		if (kind === "module") return this.module(name).uuid;
		if (kind === "table") return this.table(name).id;
		if (kind === "column") {
			if (!owner)
				throw new AuthoringInputError(
					"A column reference needs its data table.",
				);
			return this.column(this.table(owner), name).id;
		}
		const values =
			kind === "operation"
				? (this.options.operations ?? [])
				: kind === "location"
					? (this.options.locations ?? [])
					: Object.values(this.options.doc.organizationLevels ?? {});
		const identity = values.find((value) => value.uuid === name);
		if (identity) return identity.uuid;
		return one(
			values,
			(value) =>
				value.uuid === name ||
				value.name === name ||
				("code" in value && value.code === name),
			`${kind} ${name}`,
		).uuid;
	}
	forRelation(relation: RelationPath): AuthoringScope {
		if (relation.kind === "self") return this;
		const source = this.currentCaseType;
		if (!source)
			throw new AuthoringInputError(
				"A record relationship needs an originating record.",
			);
		const resolved = resolveRelationDestination(
			relation,
			source,
			this.typeContext.facts.caseTypes,
		);
		if (!resolved.ok) throw new AuthoringInputError(resolved.message);
		const destination = resolved.caseType;
		return new AuthoringScope({
			...this.options,
			currentCaseType: destination,
		});
	}
	name(
		kind: "table" | "column" | "operation" | "location" | "level" | "module",
		id: string,
		owner?: string,
	): string {
		let name: string | undefined;
		if (kind === "module") name = this.options.doc.modules[id as Uuid]?.name;
		else if (kind === "table")
			name = this.tables.find((table) => table.id === id)?.name;
		else if (kind === "column")
			name = this.tables
				.find((table) => table.id === owner)
				?.columns.find((column) => column.id === id)?.wireName;
		else {
			const values =
				kind === "operation"
					? (this.options.operations ?? [])
					: kind === "location"
						? (this.options.locations ?? [])
						: Object.values(this.options.doc.organizationLevels ?? {});
			name = values.find((value) => value.uuid === id)?.name;
		}
		if (name) {
			try {
				if (this.identity(kind, name, owner) === id) return name;
			} catch {
				/* An ambiguous display name must not replace a stable address. */
			}
		}
		return id;
	}
	forTable(tableId: string): AuthoringScope {
		return new AuthoringScope({
			...this.options,
			tableId: this.table(tableId).id,
		});
	}
	private printReference(term: Term): string | undefined {
		if (term.kind === "form-case")
			return `#${term.caseType === this.options.selectedCaseType ? "case" : term.caseType}/${term.property}`;
		if (term.kind === "field") {
			const field = this.fields.find(
				(field) =>
					field.uuid === term.uuid &&
					this.resolveField(field.path.split("/")) === term.uuid,
			);
			return field ? `#form/${field.path}` : undefined;
		}
		if (term.kind === "input") {
			const input = this.inputs.find(
				(input) => input.uuid === term.searchInputUuid,
			);
			return input ? `#search/${input.name}` : undefined;
		}
		if (term.kind === "session-user-property") {
			const property = this.options.doc.userProperties?.[term.userPropertyUuid];
			return property ? `user(${quote(property.slug)})` : undefined;
		}
		if (term.kind === "session-user")
			return `external-user(${quote(term.field)})`;
		if (
			term.kind === "prop" &&
			!term.via &&
			term.caseType === this.currentCaseType
		)
			return this.options.candidateCaseType && this.options.tableId
				? `#record/${term.caseType}/${term.property}`
				: `#${this.options.candidateCaseType ? "row" : "case"}/${term.property}`;
		if (term.kind === "table-column" && term.tableId === this.options.tableId) {
			const column = this.table(term.tableId).columns.find(
				(column) => column.id === term.columnId,
			);
			if (column) {
				try {
					if (
						this.column(this.table(term.tableId), column.wireName).id ===
						term.columnId
					)
						return `#row/${column.wireName}`;
				} catch {
					/* Fall back to the scoped stable column address. */
				}
			}
			return undefined;
		}
		return undefined;
	}
}
