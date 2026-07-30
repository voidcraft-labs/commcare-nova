import { z } from "zod";
import { orderedFormUuids } from "@/lib/doc/fieldWalk";
import {
	computeFieldPath,
	findContainingForm,
} from "@/lib/doc/mutations/helpers";
import {
	asUuid,
	type BlueprintDoc,
	type Field,
	type Form,
	type Module,
	type Uuid,
	uuidSchema,
} from "@/lib/domain";

export const moduleAddressSchema = z
	.object({
		moduleUuid: uuidSchema.describe(
			"Stable module uuid, from get_app, get_module, or search_blueprint.",
		),
	})
	.strict();

export const formAddressSchema = moduleAddressSchema
	.extend({
		formUuid: uuidSchema.describe(
			"Stable form uuid, from get_app, get_module, get_form, or search_blueprint.",
		),
	})
	.strict();

export const fieldAddressSchema = formAddressSchema
	.extend({
		fieldUuid: uuidSchema.describe(
			"Stable field uuid, from get_form, get_field, or search_blueprint.",
		),
	})
	.strict();

export interface ModuleAddress {
	readonly moduleUuid: string;
}

export interface FormAddress extends ModuleAddress {
	readonly formUuid: string;
}

export interface FieldAddress extends FormAddress {
	readonly fieldUuid: string;
}

export type ModuleAddressResolution =
	| {
			readonly ok: true;
			readonly moduleUuid: Uuid;
			readonly module: Module;
	  }
	| { readonly ok: false; readonly error: string };

export type FormAddressResolution =
	| {
			readonly ok: true;
			readonly moduleUuid: Uuid;
			readonly module: Module;
			readonly formUuid: Uuid;
			readonly form: Form;
	  }
	| { readonly ok: false; readonly error: string };

export type FieldAddressResolution =
	| {
			readonly ok: true;
			readonly moduleUuid: Uuid;
			readonly module: Module;
			readonly formUuid: Uuid;
			readonly form: Form;
			readonly fieldUuid: Uuid;
			readonly field: Field;
			readonly path: string;
	  }
	| { readonly ok: false; readonly error: string };

/**
 * Resolve one of the stable UUID addresses exposed by every SA/MCP read.
 *
 * Display positions, names, semantic field ids, lookup tags, and emitted wire
 * names are projections, never addresses. Keeping the membership checks here
 * also prevents a valid child UUID paired with the wrong parent from silently
 * mutating a different part of the app.
 */
export function resolveModuleAddress(
	doc: BlueprintDoc,
	address: ModuleAddress,
): ModuleAddressResolution {
	const moduleUuid = asUuid(address.moduleUuid);
	const module = doc.modules[moduleUuid];
	if (module === undefined) {
		return {
			ok: false,
			error: `No module with uuid "${address.moduleUuid}" is in this app. Read get_app, get_module, or search_blueprint for current module uuids.`,
		};
	}
	return { ok: true, moduleUuid, module };
}

export function resolveFormAddress(
	doc: BlueprintDoc,
	address: FormAddress,
): FormAddressResolution {
	const module = resolveModuleAddress(doc, address);
	if (!module.ok) return module;

	const formUuid = asUuid(address.formUuid);
	const form = doc.forms[formUuid];
	if (form === undefined) {
		return {
			ok: false,
			error: `No form with uuid "${address.formUuid}" is in this app. Read get_app, get_module, get_form, or search_blueprint for current form uuids.`,
		};
	}
	if (!orderedFormUuids(doc, module.moduleUuid).includes(formUuid)) {
		return {
			ok: false,
			error: `Form "${form.name}" (${formUuid}) is not in module "${module.module.name}" (${module.moduleUuid}).`,
		};
	}
	return {
		...module,
		formUuid,
		form,
	};
}

export function resolveFieldAddress(
	doc: BlueprintDoc,
	address: FieldAddress,
): FieldAddressResolution {
	const form = resolveFormAddress(doc, address);
	if (!form.ok) return form;

	const fieldUuid = asUuid(address.fieldUuid);
	const field = doc.fields[fieldUuid];
	if (field === undefined) {
		return {
			ok: false,
			error: `No field with uuid "${address.fieldUuid}" is in this app. Read get_form, get_field, or search_blueprint for current field uuids.`,
		};
	}
	if (findContainingForm(doc, fieldUuid) !== form.formUuid) {
		return {
			ok: false,
			error: `Field "${field.id}" (${fieldUuid}) is not in form "${form.form.name}" (${form.formUuid}).`,
		};
	}
	const path = computeFieldPath(doc, fieldUuid);
	if (path === undefined) {
		return {
			ok: false,
			error: `Field "${field.id}" (${fieldUuid}) is not reachable from its form.`,
		};
	}
	return {
		...form,
		fieldUuid,
		field,
		path,
	};
}
