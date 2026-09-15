import {
	computeFieldPath,
	findContainingForm,
} from "@/lib/doc/mutations/helpers";
import { type BlueprintDoc, moduleUuidOfForm, type Uuid } from "@/lib/domain";
import { AuthoringInputError } from "./errors";

type Input = Record<string, unknown>;

function resolve<T extends { uuid: Uuid }>(
	value: unknown,
	items: readonly T[],
	name: (item: T) => readonly (string | undefined)[],
	label: string,
): T {
	if (typeof value !== "string")
		throw new AuthoringInputError(`Choose ${label}.`);
	const identity = items.find((item) => item.uuid === value);
	if (identity) return identity;
	const found = items.filter((item) => name(item).includes(value));
	if (found.length !== 1)
		throw new AuthoringInputError(
			`${label} ${value} is ${found.length ? "ambiguous" : "not in this scope"}.`,
		);
	return found[0];
}

/** Bind existing structural targets against this invocation's document. Stable
 * addresses remain valid after renames; names are conveniences within a scope.
 * Supplying a parent is a constraint, never permission to select a different one. */
export function bindToolAddress(
	toolName: string,
	input: Input,
	doc: BlueprintDoc,
) {
	const modules = Object.values(doc.modules);
	const moduleName = (module: (typeof modules)[number]) => [
		module.name,
		module.parentModuleUuid
			? `${doc.modules[module.parentModuleUuid]?.name}/${module.name}`
			: undefined,
	];
	const module =
		typeof input.moduleUuid === "string" && toolName !== "createModule"
			? resolve(input.moduleUuid, modules, moduleName, "Module")
			: undefined;
	if (module) input.moduleUuid = module.uuid;
	const forms = Object.values(doc.forms).filter(
		(form) => !module || moduleUuidOfForm(doc, form.uuid) === module.uuid,
	);
	let form =
		typeof input.formUuid === "string" &&
		toolName !== "createForm" &&
		toolName !== "createModule"
			? resolve(input.formUuid, forms, (form) => [form.name], "Form")
			: undefined;
	if (typeof input.fieldUuid === "string") {
		const field = resolve(
			input.fieldUuid,
			Object.values(doc.fields).filter((field) => {
				const parent = findContainingForm(doc, field.uuid);
				return (
					parent !== undefined &&
					(form
						? parent === form.uuid
						: !module || moduleUuidOfForm(doc, parent) === module.uuid)
				);
			}),
			(field) => [computeFieldPath(doc, field.uuid)],
			"Field",
		);
		input.fieldUuid = field.uuid;
		const parent = findContainingForm(doc, field.uuid);
		if (!parent)
			throw new AuthoringInputError("This field is no longer in a form.");
		form ??= doc.forms[parent];
	}
	if (form) {
		input.formUuid = form.uuid;
		input.moduleUuid = moduleUuidOfForm(doc, form.uuid);
	}
	if (typeof input.parentModuleUuid === "string")
		input.parentModuleUuid = resolve(
			input.parentModuleUuid,
			modules,
			moduleName,
			"Parent module",
		).uuid;

	// Existing insertion anchors belong to the selected form. New field parents
	// are bound later, once every field in the atomic request has an identity.
	if (form) {
		const fields = Object.values(doc.fields).filter(
			(field) => findContainingForm(doc, field.uuid) === form.uuid,
		);
		for (const key of ["beforeFieldUuid", "afterFieldUuid"])
			if (input[key] !== undefined)
				input[key] = resolve(
					input[key],
					fields,
					(field) => [computeFieldPath(doc, field.uuid)],
					"Field",
				).uuid;
		if (typeof input.parentUuid === "string") {
			input.parentUuid =
				input.parentUuid === form.uuid
					? form.uuid
					: resolve(
							input.parentUuid,
							fields,
							(field) => [computeFieldPath(doc, field.uuid)],
							"Parent field",
						).uuid;
		}
	}
}
