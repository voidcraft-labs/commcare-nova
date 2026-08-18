/**
 * Schema-derived inventory of the final mutation wire.
 *
 * A mutation kind is first assigned an explicit ownership mode below. The
 * generator then expands the semantic leaves owned by that mode: whole-value
 * replacements stay one merge unit, while patch objects, case-operation
 * variants, Search operations, column payloads, and select-source variants are
 * expanded. Tests snapshot the generated inventory, so either a new mutation
 * kind or a new leaf on an existing owner is a review-visible CI failure.
 *
 * This registry is descriptive only. It never parses, defaults, repairs, or
 * rewrites a mutation; `mutationSchema` remains the sole runtime grammar.
 */

import { z } from "zod";
import { mutationSchema } from "@/lib/doc/types";
import {
	mediaSchema,
	proseTemplateSchema,
	xpathExpressionSchema,
} from "@/lib/domain";
import { predicateSchema, valueExpressionSchema } from "@/lib/domain/predicate";

type MutationOwnershipMode =
	| "whole-value"
	| "patch"
	| "update-module"
	| "update-form"
	| "update-field"
	| "update-column";

/**
 * This is intentionally a closed, literal classification rather than a
 * fallback. A new top-level arm is not a generic mutation until a reviewer
 * says which merge-unit ownership model it has.
 */
const MUTATION_KIND_OWNERSHIP = {
	addModule: "whole-value",
	removeModule: "whole-value",
	moveModule: "whole-value",
	renameModule: "whole-value",
	updateModule: "update-module",
	addForm: "whole-value",
	removeForm: "whole-value",
	moveForm: "whole-value",
	renameForm: "whole-value",
	updateForm: "update-form",
	addField: "whole-value",
	removeField: "whole-value",
	moveField: "whole-value",
	updateField: "update-field",
	convertField: "whole-value",
	setAppName: "whole-value",
	setConnectType: "whole-value",
	setAppLogo: "whole-value",
	relabelSourceLanguage: "whole-value",
	addLanguage: "whole-value",
	removeLanguage: "whole-value",
	setDefaultLanguage: "whole-value",
	setTranslation: "whole-value",
	reviewTranslation: "whole-value",
	renameCaseProperties: "whole-value",
	declareCaseType: "whole-value",
	retireCaseType: "whole-value",
	addCaseProperty: "whole-value",
	setCaseProperty: "whole-value",
	removeCaseProperty: "whole-value",
	setCaseTypeMeta: "whole-value",
	addUserProperty: "whole-value",
	updateUserProperty: "patch",
	removeUserProperty: "whole-value",
	addUserType: "whole-value",
	updateUserType: "patch",
	removeUserType: "whole-value",
	addPersona: "whole-value",
	updatePersona: "patch",
	removePersona: "whole-value",
	addOrganizationLevel: "whole-value",
	updateOrganizationLevel: "patch",
	removeOrganizationLevel: "whole-value",
	addLocationProperty: "whole-value",
	updateLocationProperty: "patch",
	removeLocationProperty: "whole-value",
	addAutomation: "whole-value",
	updateAutomation: "patch",
	removeAutomation: "whole-value",
	moveAutomation: "whole-value",
	editAutomationItem: "whole-value",
	setAutomationSchedule: "whole-value",
	updateAutomationSchedule: "patch",
	addColumn: "whole-value",
	updateColumn: "update-column",
	removeColumn: "whole-value",
	moveColumn: "whole-value",
	addSearchInput: "whole-value",
	updateSearchInput: "whole-value",
	removeSearchInput: "whole-value",
	moveSearchInput: "whole-value",
	setCaseListMeta: "patch",
	addOption: "whole-value",
	updateOption: "whole-value",
	removeOption: "whole-value",
	moveOption: "whole-value",
	setFieldMedia: "whole-value",
	setModuleMedia: "whole-value",
	setFormMedia: "whole-value",
} as const satisfies Readonly<Record<string, MutationOwnershipMode>>;

export type MutationWireNodeRole =
	| "leaf"
	| "semantic-payload-owner"
	| "explicit-patch-owner";
export type MutationWirePresence = "required" | "optional";

export interface MutationWireRegistryEntry {
	/** Stable semantic name including every discriminator that owns the leaf. */
	readonly mutationLeaf: string;
	/** RFC 6901 pointer within one mutation object. */
	readonly jsonPointer: string;
	readonly role: MutationWireNodeRole;
	readonly presence: MutationWirePresence;
	readonly nullable: boolean;
	readonly defaulted: boolean;
	readonly schemaKind: string;
}

export type MutationNullMeaning = "clear" | "stored-null" | "first-position";
export type MutationNullOmissionMeaning =
	| "no-intent"
	| "append"
	| "absent-value"
	| "invalid";

export interface MutationClearSlotManifestEntry {
	readonly mutationLeaf: string;
	readonly jsonPointer: string;
	readonly nullMeaning: MutationNullMeaning;
	readonly omissionMeaning: MutationNullOmissionMeaning;
	readonly ownUndefined: "invalid";
}

interface Presence {
	readonly schema: z.ZodType;
	readonly optional: boolean;
	readonly nullable: boolean;
	readonly defaulted: boolean;
}

const DISCRIMINATOR_KEYS = [
	"targetKind",
	"targetAction",
	"collection",
	"operation",
	"action",
	"source",
	"kind",
	"repeat_mode",
] as const;

const DEEP_NULL_SCAN_LEAVES = new Set<z.ZodType>([
	predicateSchema,
	valueExpressionSchema,
	xpathExpressionSchema,
	proseTemplateSchema,
	mediaSchema,
]);

function inspectPresence(schema: z.ZodType): Presence {
	let current = schema;
	let optional = false;
	let nullable = false;
	let defaulted = false;
	for (;;) {
		if (current instanceof z.ZodOptional || current instanceof z.ZodDefault) {
			optional = true;
			if (current instanceof z.ZodDefault) defaulted = true;
			current = current.unwrap() as z.ZodType;
			continue;
		}
		if (current instanceof z.ZodNullable) {
			nullable = true;
			current = current.unwrap() as z.ZodType;
			continue;
		}
		break;
	}
	if (current instanceof z.ZodNull) nullable = true;
	return { schema: current, optional, nullable, defaulted };
}

function schemaKind(schema: z.ZodType): string {
	const { schema: current } = inspectPresence(schema);
	return current.constructor.name.replace(/^Zod/u, "").toLowerCase();
}

function literalValue(schema: z.ZodType | undefined): string | undefined {
	if (schema === undefined) return undefined;
	const current = inspectPresence(schema).schema;
	if (current instanceof z.ZodLiteral && typeof current.value === "string") {
		return current.value;
	}
	return undefined;
}

function objectArms(schema: z.ZodType): z.ZodObject[] {
	const current = inspectPresence(schema).schema;
	if (current instanceof z.ZodUnion) {
		return (current.options as z.ZodType[]).flatMap(objectArms);
	}
	if (!(current instanceof z.ZodObject)) {
		throw new Error(
			`Mutation registry expected an object arm, received ${current.constructor.name}.`,
		);
	}
	return [current];
}

function objectDiscriminators(schema: z.ZodObject): string[] {
	const values: string[] = [];
	for (const key of DISCRIMINATOR_KEYS) {
		const value = literalValue(schema.shape[key] as z.ZodType | undefined);
		if (value !== undefined) values.push(`${key}=${value}`);
	}
	return values;
}

function pointer(tokens: readonly string[]): string {
	return `/${tokens
		.map((token) => token.replaceAll("~", "~0").replaceAll("/", "~1"))
		.join("/")}`;
}

function leafName(root: string, tokens: readonly string[]): string {
	return `${root}.${tokens.join(".")}`;
}

function registryEntry(
	root: string,
	tokens: readonly string[],
	schema: z.ZodType,
	role: MutationWireNodeRole = "leaf",
): MutationWireRegistryEntry {
	const presence = inspectPresence(schema);
	return {
		mutationLeaf: leafName(root, tokens),
		jsonPointer: pointer(tokens),
		role,
		presence: presence.optional ? "optional" : "required",
		nullable: presence.nullable,
		defaulted: presence.defaulted,
		schemaKind: schemaKind(schema),
	};
}

function requireObjectProperty(
	object: z.ZodObject,
	key: string,
	context: string,
): z.ZodType {
	const property = object.shape[key] as z.ZodType | undefined;
	if (property === undefined) {
		throw new Error(`Mutation registry expected ${context}.${key}.`);
	}
	return property;
}

function patchEntries(
	root: string,
	object: z.ZodObject,
	key: string,
): MutationWireRegistryEntry[] {
	const patchSchema = requireObjectProperty(object, key, root);
	const patchArms = objectArms(patchSchema);
	const entries: MutationWireRegistryEntry[] = [];
	for (const patchArm of patchArms) {
		const discriminators =
			patchArms.length === 1 ? [] : objectDiscriminators(patchArm);
		if (patchArms.length > 1 && discriminators.length === 0) {
			throw new Error(
				`Mutation registry found an undiscriminated patch arm under ${root}.${key}.`,
			);
		}
		const patchRoot =
			discriminators.length === 0
				? root
				: `${root}[${discriminators.join(",")}]`;
		entries.push(
			registryEntry(patchRoot, [key], patchSchema, "explicit-patch-owner"),
		);
		for (const [patchKey, child] of Object.entries(patchArm.shape)) {
			const childSchema = child as z.ZodType;
			if (patchKey === "optionsSource") {
				const sourceArms = objectArms(childSchema);
				for (const sourceArm of sourceArms) {
					const source = literalValue(sourceArm.shape.kind as z.ZodType);
					if (source === undefined) {
						throw new Error(
							`Mutation registry found an optionsSource arm without source under ${root}.${key}.`,
						);
					}
					entries.push(
						registryEntry(
							`${patchRoot}.${key}.optionsSource[source=${source}]`,
							[key, patchKey],
							childSchema,
						),
					);
				}
			} else {
				entries.push(registryEntry(patchRoot, [key, patchKey], childSchema));
			}
		}
	}
	return entries;
}

function genericEntries(
	root: string,
	object: z.ZodObject,
	except: ReadonlySet<string> = new Set(),
): MutationWireRegistryEntry[] {
	const entries: MutationWireRegistryEntry[] = [];
	for (const [key, value] of Object.entries(object.shape)) {
		if (except.has(key)) continue;
		const schema = value as z.ZodType;
		if (key !== "optionsSource") {
			entries.push(registryEntry(root, [key], schema));
			continue;
		}
		for (const sourceArm of objectArms(schema)) {
			const source = literalValue(sourceArm.shape.kind as z.ZodType);
			if (source === undefined) {
				throw new Error(
					`Mutation registry found an optionsSource arm without kind under ${root}.`,
				);
			}
			entries.push(
				registryEntry(`${root}.optionsSource[source=${source}]`, [key], schema),
			);
		}
	}
	return entries;
}

function enumValues(schema: z.ZodType, context: string): readonly string[] {
	const current = inspectPresence(schema).schema;
	if (!(current instanceof z.ZodEnum)) {
		throw new Error(`Mutation registry expected ${context} to be an enum.`);
	}
	const options = current.options;
	if (!options.every((value): value is string => typeof value === "string")) {
		throw new Error(
			`Mutation registry expected ${context} to contain strings.`,
		);
	}
	return options;
}

function updateModuleEntries(
	root: string,
	object: z.ZodObject,
): MutationWireRegistryEntry[] {
	const handled = new Set([
		"patch",
		"caseSearchConfigOperation",
		"caseSearchConfigPatch",
	]);
	const entries = genericEntries(root, object, handled);
	entries.push(...patchEntries(root, object, "patch"));

	const operationSchema = requireObjectProperty(
		object,
		"caseSearchConfigOperation",
		root,
	);
	for (const operation of enumValues(
		operationSchema,
		`${root}.caseSearchConfigOperation`,
	)) {
		entries.push(
			registryEntry(
				`${root}.caseSearchConfigOperation[value=${operation}]`,
				["caseSearchConfigOperation"],
				operationSchema,
			),
		);
	}
	entries.push(...patchEntries(root, object, "caseSearchConfigPatch"));
	return entries;
}

function nestedOperationEntries(
	root: string,
	key: "caseOperationChange" | "caseOperationPatch",
	schema: z.ZodType,
): MutationWireRegistryEntry[] {
	const entries: MutationWireRegistryEntry[] = [];
	for (const arm of objectArms(schema)) {
		const discriminators = objectDiscriminators(arm).filter(
			(value) => !value.startsWith("kind="),
		);
		if (discriminators.length === 0) {
			throw new Error(
				`Mutation registry found an undiscriminated ${root}.${key}.`,
			);
		}
		const variantRoot = `${root}.${key}[${discriminators.join(",")}]`;
		entries.push(
			registryEntry(variantRoot, [key], schema, "semantic-payload-owner"),
		);
		for (const [member, child] of Object.entries(arm.shape)) {
			if (member === "patch") {
				const patch = inspectPresence(child as z.ZodType).schema;
				if (!(patch instanceof z.ZodObject)) {
					throw new Error(
						`Mutation registry expected ${variantRoot}.patch to be an object.`,
					);
				}
				entries.push(
					registryEntry(
						variantRoot,
						[key, "patch"],
						child as z.ZodType,
						"explicit-patch-owner",
					),
				);
				for (const [patchKey, patchChild] of Object.entries(patch.shape)) {
					entries.push(
						registryEntry(
							variantRoot,
							[key, "patch", patchKey],
							patchChild as z.ZodType,
						),
					);
				}
			} else {
				entries.push(
					registryEntry(variantRoot, [key, member], child as z.ZodType),
				);
			}
		}
	}
	return entries;
}

function updateFormEntries(
	root: string,
	object: z.ZodObject,
): MutationWireRegistryEntry[] {
	const handled = new Set([
		"patch",
		"caseOperationChange",
		"caseOperationPatch",
	]);
	const entries = genericEntries(root, object, handled);
	entries.push(...patchEntries(root, object, "patch"));
	for (const key of ["caseOperationChange", "caseOperationPatch"] as const) {
		entries.push(
			...nestedOperationEntries(
				root,
				key,
				requireObjectProperty(object, key, root),
			),
		);
	}
	return entries;
}

function updateFieldEntries(
	root: string,
	object: z.ZodObject,
): MutationWireRegistryEntry[] {
	return [
		...genericEntries(root, object, new Set(["patch"])),
		...patchEntries(root, object, "patch"),
	];
}

function updateColumnEntries(
	root: string,
	object: z.ZodObject,
): MutationWireRegistryEntry[] {
	const payloads = new Set([
		"column",
		"sortPatch",
		"tilePatch",
		"visibilityPatch",
	]);
	const entries = genericEntries(root, object, payloads);
	for (const payload of payloads) {
		const schema = requireObjectProperty(object, payload, root);
		if (payload === "column") {
			for (const arm of objectArms(schema)) {
				const kind = literalValue(arm.shape.kind as z.ZodType);
				if (kind === undefined) {
					throw new Error(
						"Mutation registry found an updateColumn content arm without kind.",
					);
				}
				entries.push(
					registryEntry(`${root}.column[kind=${kind}]`, [payload], schema),
				);
			}
		} else {
			entries.push(registryEntry(root, [payload], schema));
		}
	}
	return entries;
}

function outerMutationArms(): z.ZodObject[] {
	return mutationSchema.options.flatMap((option) =>
		objectArms(option as z.ZodType),
	);
}

function mutationKind(object: z.ZodObject): string {
	const kind = literalValue(object.shape.kind as z.ZodType | undefined);
	if (kind === undefined) {
		throw new Error("Mutation registry found an outer arm without kind.");
	}
	return kind;
}

export function buildMutationWireRegistry(): MutationWireRegistryEntry[] {
	const actualKinds = new Set<string>();
	const entries: MutationWireRegistryEntry[] = [];

	for (const object of outerMutationArms()) {
		const kind = mutationKind(object);
		actualKinds.add(kind);
		const mode =
			MUTATION_KIND_OWNERSHIP[kind as keyof typeof MUTATION_KIND_OWNERSHIP];
		if (mode === undefined) {
			throw new Error(`Unclassified mutation kind: ${kind}.`);
		}
		const targetKind =
			kind === "updateField" ||
			kind === "updateAutomation" ||
			kind === "editAutomationItem"
				? literalValue(object.shape.targetKind as z.ZodType | undefined)
				: undefined;
		const root =
			targetKind === undefined ? kind : `${kind}[targetKind=${targetKind}]`;

		switch (mode) {
			case "whole-value":
				entries.push(...genericEntries(root, object));
				break;
			case "patch":
				entries.push(
					...genericEntries(root, object, new Set(["patch"])),
					...patchEntries(root, object, "patch"),
				);
				break;
			case "update-module":
				entries.push(...updateModuleEntries(root, object));
				break;
			case "update-form":
				entries.push(...updateFormEntries(root, object));
				break;
			case "update-field":
				entries.push(...updateFieldEntries(root, object));
				break;
			case "update-column":
				entries.push(...updateColumnEntries(root, object));
				break;
		}
	}

	const classifiedKinds = Object.keys(MUTATION_KIND_OWNERSHIP);
	for (const kind of classifiedKinds) {
		if (!actualKinds.has(kind)) {
			throw new Error(`Dead mutation-kind classification: ${kind}.`);
		}
	}

	const sorted = entries.toSorted(
		(left, right) =>
			left.mutationLeaf.localeCompare(right.mutationLeaf) ||
			left.jsonPointer.localeCompare(right.jsonPointer) ||
			left.role.localeCompare(right.role),
	);
	const keys = sorted.map(
		(entry) =>
			`${entry.mutationLeaf}\u0000${entry.jsonPointer}\u0000${entry.role}`,
	);
	if (new Set(keys).size !== keys.length) {
		throw new Error(
			"Mutation wire registry contains a duplicate semantic leaf.",
		);
	}
	return sorted;
}

function nullableUnion(schema: z.ZodType): boolean {
	const current = inspectPresence(schema).schema;
	return (
		current instanceof z.ZodUnion &&
		(current.options as z.ZodType[]).some(
			(option) => inspectPresence(option).schema instanceof z.ZodNull,
		)
	);
}

function nullMeaning(
	kind: string,
	mutationLeaf: string,
	jsonPointer: string,
): MutationNullMeaning {
	const finalToken = jsonPointer.split("/").at(-1);
	if (
		finalToken === "after" ||
		finalToken === "afterInList" ||
		finalToken === "afterInDetail"
	) {
		return "first-position";
	}
	if (kind === "setConnectType" && jsonPointer === "/connectType") {
		return "stored-null";
	}
	if (
		finalToken === "target" &&
		(mutationLeaf.includes(".links.items.") ||
			mutationLeaf.includes("operation=add-link") ||
			mutationLeaf.includes("operation=update-link"))
	) {
		return "stored-null";
	}
	if (
		finalToken === "connect" &&
		!mutationLeaf.startsWith("updateForm.patch.")
	) {
		return "stored-null";
	}

	const clear =
		(kind === "updateModule" &&
			(jsonPointer.startsWith("/patch/") ||
				jsonPointer.startsWith("/caseSearchConfigPatch/"))) ||
		(kind === "updateForm" &&
			(jsonPointer.startsWith("/patch/") ||
				jsonPointer.includes("/caseOperationPatch/"))) ||
		(kind === "updateField" && jsonPointer.startsWith("/patch/")) ||
		kind === "setAppLogo" ||
		kind === "setTranslation" ||
		kind === "setCaseTypeMeta" ||
		((kind === "updateUserProperty" ||
			kind === "updateUserType" ||
			kind === "updatePersona") &&
			(jsonPointer.startsWith("/patch/") ||
				jsonPointer === "/valuePatch/value")) ||
		((kind === "updateOrganizationLevel" ||
			kind === "updateLocationProperty") &&
			jsonPointer.startsWith("/patch/")) ||
		((kind === "updateAutomation" || kind === "updateAutomationSchedule") &&
			jsonPointer.startsWith("/patch/")) ||
		(kind === "updateColumn" &&
			(jsonPointer === "/sortPatch" || jsonPointer === "/tilePatch")) ||
		(kind === "setCaseListMeta" && jsonPointer.startsWith("/patch/")) ||
		kind === "setFieldMedia" ||
		kind === "setModuleMedia" ||
		kind === "setFormMedia";
	if (clear) return "clear";

	throw new Error(
		`Unclassified nullable mutation leaf: ${mutationLeaf} (${jsonPointer}).`,
	);
}

function omissionMeaning(
	kind: string,
	mutationLeaf: string,
	jsonPointer: string,
	optional: boolean,
	meaning: MutationNullMeaning,
): MutationNullOmissionMeaning {
	if (!optional) return "invalid";
	if (meaning === "first-position") return "append";
	if (
		meaning === "stored-null" &&
		kind === "addForm" &&
		jsonPointer.endsWith("/connect")
	) {
		return "absent-value";
	}
	if (
		meaning === "stored-null" &&
		mutationLeaf.includes(".links.items.target")
	) {
		return "absent-value";
	}
	return "no-intent";
}

function branchSuffix(object: z.ZodObject, index: number): string {
	const discriminators = objectDiscriminators(object);
	return discriminators.length > 0
		? `[${discriminators.join(",")}]`
		: `[union=${index}]`;
}

function collectNullableSlots(
	kind: string,
	schema: z.ZodType,
	tokens: readonly string[],
	mutationLeaf: string,
	out: MutationClearSlotManifestEntry[],
	stack: ReadonlySet<z.ZodType>,
): void {
	const presence = inspectPresence(schema);
	const nullable = presence.nullable || nullableUnion(schema);
	if (nullable) {
		const jsonPointer = pointer(tokens);
		const meaning = nullMeaning(kind, mutationLeaf, jsonPointer);
		out.push({
			mutationLeaf,
			jsonPointer,
			nullMeaning: meaning,
			omissionMeaning: omissionMeaning(
				kind,
				mutationLeaf,
				jsonPointer,
				presence.optional,
				meaning,
			),
			ownUndefined: "invalid",
		});
	}

	const current = presence.schema;
	if (
		current instanceof z.ZodNull ||
		current instanceof z.ZodLazy ||
		DEEP_NULL_SCAN_LEAVES.has(current) ||
		stack.has(current)
	) {
		return;
	}
	const nextStack = new Set(stack).add(current);
	if (current instanceof z.ZodObject) {
		for (const [key, child] of Object.entries(current.shape)) {
			collectNullableSlots(
				kind,
				child as z.ZodType,
				[...tokens, key],
				`${mutationLeaf}.${key}`,
				out,
				nextStack,
			);
		}
		return;
	}
	if (current instanceof z.ZodArray) {
		collectNullableSlots(
			kind,
			current.element as z.ZodType,
			[...tokens, "*"],
			`${mutationLeaf}.items`,
			out,
			nextStack,
		);
		return;
	}
	if (current instanceof z.ZodRecord) {
		collectNullableSlots(
			kind,
			current.valueType as z.ZodType,
			[...tokens, "*"],
			`${mutationLeaf}.values`,
			out,
			nextStack,
		);
		return;
	}
	if (current instanceof z.ZodTuple) {
		const definition = current.def as unknown as {
			readonly items: readonly z.ZodType[];
			readonly rest: z.ZodType | null;
		};
		for (const [index, item] of definition.items.entries()) {
			collectNullableSlots(
				kind,
				item,
				[...tokens, String(index)],
				`${mutationLeaf}.items.${index}`,
				out,
				nextStack,
			);
		}
		if (definition.rest !== null) {
			collectNullableSlots(
				kind,
				definition.rest,
				[...tokens, "*"],
				`${mutationLeaf}.rest`,
				out,
				nextStack,
			);
		}
		return;
	}
	if (current instanceof z.ZodIntersection) {
		const definition = current.def as unknown as {
			readonly left: z.ZodType;
			readonly right: z.ZodType;
		};
		for (const [side, schema] of [
			["left", definition.left],
			["right", definition.right],
		] as const) {
			collectNullableSlots(
				kind,
				schema,
				tokens,
				`${mutationLeaf}.${side}`,
				out,
				nextStack,
			);
		}
		return;
	}
	if (current instanceof z.ZodUnion) {
		for (const [index, option] of (current.options as z.ZodType[]).entries()) {
			const optionSchema = inspectPresence(option).schema;
			if (optionSchema instanceof z.ZodNull) continue;
			if (optionSchema instanceof z.ZodObject) {
				collectNullableSlots(
					kind,
					optionSchema,
					tokens,
					`${mutationLeaf}${branchSuffix(optionSchema, index)}`,
					out,
					nextStack,
				);
			} else {
				collectNullableSlots(
					kind,
					option,
					tokens,
					`${mutationLeaf}[union=${index}]`,
					out,
					nextStack,
				);
			}
		}
	}
}

export function buildMutationClearSlotManifest(): MutationClearSlotManifestEntry[] {
	const entries: MutationClearSlotManifestEntry[] = [];
	for (const object of outerMutationArms()) {
		const kind = mutationKind(object);
		const targetKind =
			kind === "updateField" ||
			kind === "updateAutomation" ||
			kind === "editAutomationItem"
				? literalValue(object.shape.targetKind as z.ZodType | undefined)
				: undefined;
		const root =
			targetKind === undefined ? kind : `${kind}[targetKind=${targetKind}]`;
		for (const [key, child] of Object.entries(object.shape)) {
			collectNullableSlots(
				kind,
				child as z.ZodType,
				[key],
				`${root}.${key}`,
				entries,
				new Set(),
			);
		}
	}

	const sorted = entries.toSorted(
		(left, right) =>
			left.mutationLeaf.localeCompare(right.mutationLeaf) ||
			left.jsonPointer.localeCompare(right.jsonPointer),
	);
	const keys = sorted.map(
		(entry) => `${entry.mutationLeaf}\u0000${entry.jsonPointer}`,
	);
	if (new Set(keys).size !== keys.length) {
		const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
		throw new Error(
			`Mutation clear-slot manifest contains a duplicate leaf: ${[...new Set(duplicates)].join(", ")}.`,
		);
	}
	return sorted;
}

export const MUTATION_WIRE_REGISTRY = buildMutationWireRegistry();
export const MUTATION_CLEAR_SLOT_MANIFEST = buildMutationClearSlotManifest();
