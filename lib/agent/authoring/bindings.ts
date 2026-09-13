import { resolvableUserPropertySlug } from "@/lib/doc/expressionText";
import {
	computeFieldPath,
	findContainingForm,
} from "@/lib/doc/mutations/helpers";
import {
	asUuid,
	type BlueprintDoc,
	type CaseType,
	caseDataTypeForFieldKind,
	effectiveCaseTypes,
	type FieldKind,
	moduleUuidOfForm,
	searchInputRuntimeValueType,
	type Uuid,
} from "@/lib/domain";
import {
	type CheckError,
	checkRelationPath,
	type RelationPath,
	type SearchInputDecl,
	type Term,
	type TypeContext,
	termSchema,
} from "@/lib/domain/predicate";
import type { LookupTableDefinition } from "@/lib/lookup/types";
import { quoteAuthoringLiteral as quote } from "./expressionSyntax";
import type { QueryPrintContext } from "./printQueryExpression";
import type { QueryBindings } from "./queryExpressions";

export interface NamedAuthoringField {
	uuid: Uuid;
	path: string;
	kind: FieldKind;
}
export interface AuthoringScopeOptions {
	doc: BlueprintDoc;
	formUuid?: Uuid;
	moduleUuid?: Uuid;
	currentCaseType?: string;
	/** Complete call-local names, including additions and both sides of a rename. */
	fields?: readonly NamedAuthoringField[];
	inputs?: readonly SearchInputDecl[];
	caseTypes?: readonly CaseType[];
	/** Authoritatively Project-scoped, rows-free data definitions. */
	tables?: readonly LookupTableDefinition[];
	locations?: readonly { uuid: Uuid; name: string }[];
	operations?: readonly { uuid: Uuid; name: string }[];
	tableId?: string;
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
		throw new Error(
			`${describe} is ${found.length ? "ambiguous" : "not in this scope"}.`,
		);
	return found[0];
}

/** One invocation's names and types. This is a view over the canonical document
 * and prepared declarations, never another document or mutation engine. */
export class AuthoringScope implements QueryBindings, QueryPrintContext {
	readonly typeContext: TypeContext;
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
						throw new Error(`Field ${field.id} has no path in this form.`);
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
		this.typeContext = {
			caseTypes: [...(options.caseTypes ?? effectiveCaseTypes(doc))],
			currentCaseType: options.currentCaseType,
			patternMatching: options.patternMatching,
			ownerValues: options.ownerValues,
			knownInputs: [...this.inputs],
			formFields: new Map(
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
				Object.values(doc.userProperties ?? {}).map((property) => [
					property.uuid,
					property.slug,
				]),
			),
			lookupTables,
			...(table && {
				tableScope: {
					tableId: table.id,
					columns: new Map(
						table.columns.map((column) => [column.id, column.dataType]),
					),
				},
			}),
		};
	}
	private table(name: string) {
		return one(
			this.tables,
			(table) => table.id === name || table.name === name || table.tag === name,
			`Data table ${name}`,
		);
	}
	resolveField = (segments: readonly string[]): Uuid | undefined => {
		const name = segments.join("/");
		const ids = new Set(
			this.fields
				.filter((field) => field.path === name || field.uuid === name)
				.map((field) => field.uuid),
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
				throw new Error(`Field ${name} is missing or ambiguous in this form.`);
			return { kind: "field", uuid };
		}
		if (value === "search") {
			const input = one(
				this.inputs,
				(input) => input.uuid === name || input.name === name,
				`Search answer ${name}`,
			);
			return { kind: "input", searchInputUuid: input.uuid };
		}
		if (value === "user") {
			const properties = Object.values(this.options.doc.userProperties ?? {});
			const byId = properties.find((property) => property.uuid === name);
			const uuid =
				byId?.uuid ?? resolvableUserPropertySlug(this.options.doc)(name);
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
				throw new Error(
					`Worker information ${name} is ambiguous or has different capitalization.`,
				);
			return termSchema.parse({ kind: "session-user", field: name });
		}
		if (value === "row") {
			if (!this.options.tableId)
				throw new Error("A row reference needs a data-table scope.");
			const table = this.table(this.options.tableId);
			const column = this.column(table, name);
			return { kind: "table-column", tableId: table.id, columnId: column.id };
		}
		const caseType =
			value === "case"
				? this.typeContext.currentCaseType
				: value === "record"
					? path[0]
					: value;
		const property = value === "record" ? path[1] : name;
		const type = this.typeContext.caseTypes.find(
			(type) => type.name === caseType,
		);
		if (!type || !property)
			throw new Error(
				`Record ${caseType ?? "in this context"} is not available.`,
			);
		if (
			this.typeContext.currentCaseType &&
			type.name !== this.typeContext.currentCaseType
		)
			throw new Error(
				`This scope reads ${this.typeContext.currentCaseType}; use a relationship to read ${type.name}.`,
			);
		if (!type.properties.some((candidate) => candidate.name === property))
			throw new Error(`Record ${type.name} has no property ${property}.`);
		return termSchema.parse({ kind: "prop", caseType: type.name, property });
	}
	private column(table: LookupTableDefinition, name: string) {
		return one(
			table.columns,
			(column) =>
				column.id === name || column.wireName === name || column.label === name,
			`Column ${name} in ${table.name}`,
		);
	}
	identity(
		kind: "table" | "column" | "operation" | "location" | "level",
		name: string,
		owner?: string,
	): string {
		if (kind === "table") return this.table(name).id;
		if (kind === "column") {
			if (!owner) throw new Error("A column reference needs its data table.");
			return this.column(this.table(owner), name).id;
		}
		const values =
			kind === "operation"
				? (this.options.operations ?? [])
				: kind === "location"
					? (this.options.locations ?? [])
					: Object.values(this.options.doc.organizationLevels ?? {});
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
		const source = this.typeContext.currentCaseType;
		if (!source)
			throw new Error("A record relationship needs an originating record.");
		const errors: CheckError[] = [];
		const destination = checkRelationPath(
			relation,
			source,
			this.typeContext,
			errors,
			[],
		);
		if (!destination || errors.length)
			throw new Error(
				errors.map((error) => error.message).join(" ") ||
					"The relationship has no single record type.",
			);
		return new AuthoringScope({
			...this.options,
			currentCaseType: destination,
		});
	}
	name(
		kind: "table" | "column" | "operation" | "location" | "level",
		id: string,
		owner?: string,
	): string {
		let name: string | undefined;
		if (kind === "table")
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
		if (term.kind === "session-user") return `user(${quote(term.field)})`;
		if (
			term.kind === "prop" &&
			!term.via &&
			term.caseType === this.typeContext.currentCaseType
		)
			return `#case/${term.property}`;
		if (term.kind === "table-column" && term.tableId === this.options.tableId) {
			const column = this.table(term.tableId).columns.find(
				(column) => column.id === term.columnId,
			);
			return column ? `#row/${column.wireName}` : undefined;
		}
		return undefined;
	}
}
