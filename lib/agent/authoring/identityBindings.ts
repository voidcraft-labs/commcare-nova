import {
	computeFieldPath,
	findContainingForm,
} from "@/lib/doc/mutations/helpers";
import {
	entryPointInventory,
	moduleUuidOfForm,
	uuidSchema,
} from "@/lib/domain";
import {
	type AuthoringScopeOptions,
	enclosingAuthoringTable,
} from "./bindings";
import { AuthoringInputError } from "./errors";
import { fieldNameCandidates } from "./fieldNames";
import {
	NAMED_IDENTITY_FAMILIES,
	type NamedIdentityInput,
} from "./identitySchema";

type Input = Record<string, unknown>;
type Named = { id: string; names: readonly (string | undefined)[] };
const record = (value: unknown): Input | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Input)
		: undefined;
const items = (value: unknown): Input[] =>
	Array.isArray(value)
		? value.flatMap((item) => {
				const object = record(item);
				return object ? [object] : [];
			})
		: [];
const text = (value: unknown) =>
	typeof value === "string" ? value : undefined;

function one(
	value: string,
	candidates: readonly Named[],
	label: string,
): string {
	const identity = candidates.find((item) => item.id === value);
	if (identity) return identity.id;
	const matches = new Set(
		candidates
			.filter((item) => item.names.includes(value))
			.map((item) => item.id),
	);
	if (matches.size !== 1)
		throw new AuthoringInputError(
			`${label} ${value} is ${matches.size ? "ambiguous" : "not in this scope"}.`,
		);
	return [...matches][0];
}

function declarations(
	value: unknown,
	idKey: string,
	...names: string[]
): Named[] {
	return items(value).flatMap((item) => {
		const id = text(item[idKey]);
		return id ? [{ id, names: names.map((key) => text(item[key])) }] : [];
	});
}

function named<T extends { uuid: string }>(
	values: readonly T[],
	names: (item: T) => Named["names"],
): Named[] {
	return values.map((item) => ({ id: item.uuid, names: names(item) }));
}

/** The workspace supplies the document and authorized catalogs. Names are
 * resolved once; canonical admission still checks the resulting identities. */
export function bindNamedIdentity(args: {
	toolName: string;
	input: Input;
	slot: NamedIdentityInput;
	scope: AuthoringScopeOptions;
}): void {
	const { toolName, input, slot } = args;
	// An explicit identity keeps the owning tool's existing missing-item and
	// no-op semantics. Names must resolve, never turn into new identities.
	if (uuidSchema.safeParse(slot.value).success) return;
	const scope = { ...args.scope };
	let fieldUuid: string | undefined;
	let owner: unknown = input;
	for (const part of slot.path) {
		const object = record(owner);
		if (object) {
			if (uuidSchema.safeParse(object.fieldUuid).success)
				fieldUuid = uuidSchema.parse(object.fieldUuid);
			if (uuidSchema.safeParse(object.moduleUuid).success)
				scope.moduleUuid = uuidSchema.parse(object.moduleUuid);
			if (uuidSchema.safeParse(object.formUuid).success)
				scope.formUuid = uuidSchema.parse(object.formUuid);
		}
		owner =
			object?.[part] ??
			(Array.isArray(owner) && typeof part === "number"
				? owner[part]
				: undefined);
	}
	const { doc, moduleUuid, formUuid } = scope;
	const module = moduleUuid ? doc.modules[moduleUuid] : undefined;
	let candidates: Named[];
	switch (slot.family) {
		case "module":
			candidates = named(Object.values(doc.modules), (item) => [
				item.name,
				item.parentModuleUuid
					? `${doc.modules[item.parentModuleUuid]?.name}/${item.name}`
					: undefined,
			]);
			if (toolName === "createModule")
				candidates.push(...declarations([input], "moduleUuid", "name"));
			break;
		case "form":
			candidates = named(
				Object.values(doc.forms).filter(
					(item) =>
						!moduleUuid || moduleUuidOfForm(doc, item.uuid) === moduleUuid,
				),
				(item) => [item.name],
			);
			if (toolName === "createModule")
				candidates.push(...declarations(input.forms, "formUuid", "name"));
			if (toolName === "createForm")
				candidates.push(...declarations([input], "formUuid", "name"));
			break;
		case "field": {
			const fields =
				scope.fields ??
				Object.values(doc.fields).flatMap((item) => {
					if (
						formUuid === undefined ||
						findContainingForm(doc, item.uuid) !== formUuid
					)
						return [];
					const path = computeFieldPath(doc, item.uuid);
					return path === undefined ? [] : [{ uuid: item.uuid, path }];
				});
			candidates = named(fieldNameCandidates(slot.value, fields), () => [
				slot.value,
			]);
			break;
		}
		case "select-option": {
			const field = fieldUuid ? doc.fields[fieldUuid] : undefined;
			candidates =
				field &&
				"optionsSource" in field &&
				field.optionsSource.kind === "inline"
					? named(field.optionsSource.options, (item) => [item.value])
					: [];
			break;
		}
		case "case-list-column":
			candidates = named(module?.caseListConfig?.columns ?? [], (item) => [
				item.header,
			]);
			if (["configureCaseList", "addCaseListColumns"].includes(toolName))
				candidates.push(...declarations(input.columns, "columnUuid", "header"));
			if (["createModule", "updateModule"].includes(toolName))
				candidates.push(
					...declarations(input.case_list_columns, "columnUuid", "header"),
				);
			break;
		case "search-input":
			candidates = named<{ uuid: string; name: string }>(
				scope.inputs ?? module?.caseListConfig?.searchInputs ?? [],
				(item) => [item.name],
			);
			break;
		case "case-operation":
			candidates = named(scope.operations ?? [], (item) => [item.name]);
			break;
		case "worker-property":
			candidates = named(Object.values(doc.userProperties ?? {}), (item) => [
				item.slug,
				item.label,
			]);
			break;
		case "user-type":
			candidates = named(Object.values(doc.userTypes ?? {}), (item) => [
				item.name,
			]);
			break;
		case "persona":
			candidates = named(Object.values(doc.personas ?? {}), (item) => [
				item.name,
			]);
			break;
		case "organization-level":
			candidates = named(
				Object.values(doc.organizationLevels ?? {}),
				(item) => [item.code, item.name],
			);
			if (toolName === "addOrganizationLevels")
				candidates.push(...declarations(input.levels, "uuid", "code", "name"));
			break;
		case "location-property":
			candidates = named(
				Object.values(doc.locationProperties ?? {}),
				(item) => [item.slug, item.label],
			);
			break;
		case "location":
			candidates = named(scope.locations ?? [], (item) => [
				item.name,
				item.siteCode,
			]);
			break;
		case "entry-point":
			candidates = named(
				entryPointInventory(doc).map((item) => item.entryPoint),
				(item) => [item.id],
			);
			break;
		case "automation":
			candidates = named(Object.values(doc.automations ?? {}), (item) => [
				item.name,
			]);
			if (toolName === "addAutomations")
				candidates.push(...declarations(input.automations, "uuid", "name"));
			break;
		case "lookup-table":
			candidates = (scope.tables ?? []).map((item) => ({
				id: item.id,
				names: [item.name, item.tag],
			}));
			break;
		case "lookup-column": {
			const tableId = enclosingAuthoringTable(input, slot.path, scope.tableId);
			const table = scope.tables?.find((item) => item.id === tableId);
			if (!table)
				throw new AuthoringInputError(
					"Choose the data table before naming its columns.",
				);
			candidates = table.columns.map((item) => ({
				id: item.id,
				names: [item.wireName, item.label],
			}));
			break;
		}
	}
	slot.replace(
		one(slot.value, candidates, NAMED_IDENTITY_FAMILIES[slot.family]),
	);
}
