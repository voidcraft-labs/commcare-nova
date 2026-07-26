/**
 * User-property, user-type, and persona rules — app-scoped, because none
 * of these collections belongs to a module or a form.
 *
 * Most of what follows is not stylistic. A user property's slug is the key
 * CommCare stores worker data under, and HQ adjudicates it in three places
 * that all run when a domain admin saves the user-data schema
 * (`custom_data_fields/edit_model.py::XmlSlugField`,
 * `custom_data_fields/models.py::validate_reserved_words`, and
 * `edit_model.py::CustomDataFieldsForm.verify_no_duplicates` /
 * `::verify_no_reserved_words`). A slug that fails any of them makes the
 * eventual push fail on identity grounds — long after the author wrote it —
 * so Nova refuses it at construction instead. The same goes for a value
 * outside a property's choice list (`models.py::Field.validate_choices`)
 * and a missing required value (`::Field.validate_required`): both are
 * checked when the worker account is created, and both are knowable here.
 */

import { referencedUserPropertyUuids } from "@/lib/doc/referenceIndex";
import {
	type BlueprintDoc,
	ownRecordValue,
	personasOf,
	personaUserData,
	userPropertiesOf,
	userTypesOf,
} from "@/lib/domain";
import { type ValidationError, validationError } from "../errors";
import { userPropertySlugVerdict } from "../userPropertySlug";

/** Case-insensitive display-name key, so two roles can't look identical. */
function nameKey(name: string): string {
	return name.trim().toLowerCase();
}

function userPropertySlugs(doc: BlueprintDoc): ValidationError[] {
	const errors: ValidationError[] = [];
	const properties = Object.values(userPropertiesOf(doc));
	const duplicateCounts = new Map<string, number>();
	for (const property of properties) {
		const key = property.slug.trim().toLowerCase();
		duplicateCounts.set(key, (duplicateCounts.get(key) ?? 0) + 1);
	}
	for (const property of properties) {
		const verdict = userPropertySlugVerdict(property.slug, new Set());
		if (!verdict.ok) {
			errors.push(
				validationError(
					"USER_PROPERTY_SLUG_INVALID",
					"app",
					`"${property.label}" saves under the name "${property.slug}", which CommCare won't accept. ${verdict.userMessage}`,
					{},
					{ userPropertyUuid: property.uuid, slug: property.slug },
				),
			);
			continue;
		}
		if ((duplicateCounts.get(property.slug.trim().toLowerCase()) ?? 0) < 2) {
			continue;
		}
		errors.push(
			validationError(
				"USER_PROPERTY_SLUG_DUPLICATE",
				"app",
				`"${property.label}" saves under the name "${property.slug}", which is also used by another piece of worker information. CommCare treats capitalization as the same, so give each one a different name.`,
				{},
				{ userPropertyUuid: property.uuid, slug: property.slug },
			),
		);
	}
	return errors;
}

function duplicateUserTypeNames(doc: BlueprintDoc): ValidationError[] {
	const errors: ValidationError[] = [];
	const types = Object.values(userTypesOf(doc));
	const counts = new Map<string, number>();
	for (const type of types) {
		const key = nameKey(type.name);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	for (const type of types) {
		if ((counts.get(nameKey(type.name)) ?? 0) < 2) continue;
		errors.push(
			validationError(
				"USER_TYPE_NAME_DUPLICATE",
				"app",
				`Two roles are both called "${type.name}". Give each role a name of its own — otherwise there's no way to tell them apart when assigning one to a persona.`,
				{},
				{ userTypeUuid: type.uuid, name: type.name },
			),
		);
	}
	return errors;
}

function duplicatePersonaNames(doc: BlueprintDoc): ValidationError[] {
	const errors: ValidationError[] = [];
	const personas = Object.values(personasOf(doc));
	const counts = new Map<string, number>();
	for (const persona of personas) {
		const key = nameKey(persona.name);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	for (const persona of personas) {
		if ((counts.get(nameKey(persona.name)) ?? 0) < 2) continue;
		errors.push(
			validationError(
				"PERSONA_NAME_DUPLICATE",
				"app",
				`Two personas are both called "${persona.name}". Give each one a name of its own — otherwise there's no way to tell which you're previewing as.`,
				{},
				{ personaUuid: persona.uuid, name: persona.name },
			),
		);
	}
	return errors;
}

function unknownPersonaUserType(doc: BlueprintDoc): ValidationError[] {
	const types = userTypesOf(doc);
	const errors: ValidationError[] = [];
	for (const persona of Object.values(personasOf(doc))) {
		if (persona.userTypeUuid === undefined) continue;
		if (ownRecordValue(types, persona.userTypeUuid) !== undefined) continue;
		errors.push(
			validationError(
				"PERSONA_USER_TYPE_UNKNOWN",
				"app",
				`"${persona.name}" is assigned to a role that no longer exists. Pick a role for them, or leave the role empty.`,
				{},
				{ personaUuid: persona.uuid },
			),
		);
	}
	return errors;
}

/**
 * Every value bag — a user type's defaults and a persona's overrides —
 * names properties by UUID, so a key that resolves to nothing is a value
 * with nowhere to go. It would silently vanish on push rather than
 * arriving under some other name, which is why this is a finding rather
 * than a cleanup.
 */
function unknownUserDataProperties(doc: BlueprintDoc): ValidationError[] {
	const properties = userPropertiesOf(doc);
	const errors: ValidationError[] = [];
	const check = (
		owner: string,
		ownerKind: "userType" | "persona",
		ownerUuid: string,
		values: Record<string, string> | undefined,
	): void => {
		for (const propertyUuid of Object.keys(values ?? {})) {
			if (ownRecordValue(properties, propertyUuid) !== undefined) continue;
			errors.push(
				validationError(
					"USER_DATA_UNKNOWN_PROPERTY",
					"app",
					`${owner} carries a value for a piece of worker information that no longer exists. Remove the value, or add that information back to the list.`,
					{},
					{ ownerKind, ownerUuid, propertyUuid },
				),
			);
		}
	};
	for (const type of Object.values(userTypesOf(doc))) {
		check(`The role "${type.name}"`, "userType", type.uuid, type.values);
	}
	for (const persona of Object.values(personasOf(doc))) {
		check(
			`The persona "${persona.name}"`,
			"persona",
			persona.uuid,
			persona.values,
		);
	}
	return errors;
}

/** Identity-backed custom worker references must keep a live catalog target. */
function unknownUserPropertyReferences(doc: BlueprintDoc): ValidationError[] {
	const properties = userPropertiesOf(doc);
	const errors: ValidationError[] = [];
	for (const propertyUuid of referencedUserPropertyUuids(doc).sort()) {
		if (ownRecordValue(properties, propertyUuid) !== undefined) continue;
		errors.push(
			validationError(
				"USER_PROPERTY_REFERENCE_UNKNOWN",
				"app",
				"A condition or calculation uses worker information that no longer exists. Choose a current worker-information property, or add the referenced property back.",
				{},
				{ userPropertyUuid: propertyUuid },
			),
		);
	}
	return errors;
}

/**
 * A value outside a property's choice list, checked on the persona's
 * EFFECTIVE data — the role's defaults with the persona's overrides on top
 * — because that is the data a worker would actually be created with.
 *
 * A REQUIRED property with no value is deliberately not a finding here.
 * Whether a persona satisfies `required` is a question about creating a
 * worker on a specific HQ domain, and it is that deployment's preflight to
 * answer: HQ only enforces the flag when the pushed field's `required_for`
 * names the user type being created
 * (`custom_data_fields/edit_model.py::UserFieldsView.is_field_required`).
 * Gating the document on it would also make marking an existing property
 * required impossible — every persona missing a value would be a finding
 * the same batch introduced. The Users & Personas surface says so inline
 * instead, where the author can act on it.
 */
function personaUserDataValues(doc: BlueprintDoc): ValidationError[] {
	const properties = userPropertiesOf(doc);
	const errors: ValidationError[] = [];
	for (const persona of Object.values(personasOf(doc))) {
		const data = personaUserData(persona, doc);
		for (const property of Object.values(properties)) {
			const value = ownRecordValue(data, property.uuid);
			const blank = value === undefined || value.trim() === "";
			if (blank || property.choices === undefined) continue;
			if (property.choices.includes(value)) continue;
			errors.push(
				validationError(
					"USER_DATA_INVALID_CHOICE",
					"app",
					`"${persona.name}" has ${property.label} set to "${value}", which isn't one of the accepted values (${property.choices.join(", ")}). CommCare checks this when the worker is created.`,
					{},
					{
						personaUuid: persona.uuid,
						userPropertyUuid: property.uuid,
						slug: property.slug,
					},
				),
			);
		}
	}
	return errors;
}

/**
 * The same choice check over a role's own defaults. A role that hands
 * every persona an unaccepted value is broken whether or not a persona
 * exists yet to inherit it.
 */
function userTypeUserDataValues(doc: BlueprintDoc): ValidationError[] {
	const properties = userPropertiesOf(doc);
	const errors: ValidationError[] = [];
	for (const type of Object.values(userTypesOf(doc))) {
		for (const [propertyUuid, value] of Object.entries(type.values ?? {})) {
			const property = ownRecordValue(properties, propertyUuid);
			if (property?.choices === undefined) continue;
			if (value.trim() === "" || property.choices.includes(value)) continue;
			errors.push(
				validationError(
					"USER_DATA_INVALID_CHOICE",
					"app",
					`The role "${type.name}" sets ${property.label} to "${value}", which isn't one of the accepted values (${property.choices.join(", ")}). CommCare checks this when a worker is created.`,
					{},
					{
						userTypeUuid: type.uuid,
						userPropertyUuid: property.uuid,
						slug: property.slug,
					},
				),
			);
		}
	}
	return errors;
}

/**
 * A duplicate choice makes the authoring control ambiguous and HQ's accepted
 * value list redundant. The schema prevents new instances; this rule keeps
 * imported or historical documents repairable through the ordinary gate.
 */
function duplicateUserPropertyChoices(doc: BlueprintDoc): ValidationError[] {
	const errors: ValidationError[] = [];
	for (const property of Object.values(userPropertiesOf(doc))) {
		if (property.choices === undefined) continue;
		if (new Set(property.choices).size === property.choices.length) continue;
		errors.push(
			validationError(
				"USER_PROPERTY_CHOICES_DUPLICATE",
				"app",
				`"${property.label}" lists the same accepted value more than once. Keep each accepted value only once.`,
				{},
				{ userPropertyUuid: property.uuid, slug: property.slug },
			),
		);
	}
	return errors;
}

export const USER_RULES = [
	userPropertySlugs,
	duplicateUserPropertyChoices,
	duplicateUserTypeNames,
	duplicatePersonaNames,
	unknownPersonaUserType,
	unknownUserDataProperties,
	unknownUserPropertyReferences,
	userTypeUserDataValues,
	personaUserDataValues,
];
