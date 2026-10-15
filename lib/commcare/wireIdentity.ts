// lib/commcare/wireIdentity.ts
//
// The ids CommCare HQ holds for Nova's menus and forms, and each form's
// `xmlns`. Each is a pure function of the Nova entity's UUID, so two exports
// of one document carry the same ids, a republish keeps every id HQ stores,
// and a newer `.ccz` keeps every form's identity on a phone. Nothing is drawn
// and nothing is stored beside the document.
//
// The derivation is HQ's own shape: a menu's and a form's `unique_id` are 32
// lower case hex (`models/modules.py::ModuleBase.get_or_create_unique_id`),
// and a form's `xmlns` is `http://openrosa.org/formdesigner/` followed by an
// upper case hyphenated UUID (`util.py::generate_xmlns`). Nova's UUIDs are
// canonical lower case (`lib/domain/uuid.ts::uuidSchema`), and no two Nova
// apps share an entity UUID.
//
// A project space can hold ids that are not the derivation, for a deployment
// made before Nova derived them. The deployment ledger records exactly those
// (`app_deployment_identities`), and `targetWireIdentity` lays them over the
// derivation. The row shape is declared here because `lib/commcare` imports
// nothing from `lib/deployment`.

import type { Form, Uuid } from "@/lib/domain";

/** The ids one export writes for every menu and form. */
export interface WireIdentity {
	/** Any module of the emission plan, the hidden menu included. */
	moduleUniqueId(moduleUuid: Uuid): string;
	formUniqueId(formUuid: Uuid): string;
	formXmlns(form: Form): string;
}

const XMLNS_PREFIX = "http://openrosa.org/formdesigner/";

/** The entity's UUID with its hyphens removed: 32 lower case hex, HQ's own shape. */
export function derivedUniqueId(uuid: Uuid): string {
	return uuid.replaceAll("-", "");
}

/** `http://openrosa.org/formdesigner/${uuid.toUpperCase()}`, HQ's own shape. */
export function derivedFormXmlns(uuid: Uuid): string {
	return `${XMLNS_PREFIX}${uuid.toUpperCase()}`;
}

/** Every id derived from its entity's UUID. */
export const DERIVED_WIRE_IDENTITY: WireIdentity = {
	moduleUniqueId: derivedUniqueId,
	formUniqueId: derivedUniqueId,
	formXmlns: (form) => derivedFormXmlns(form.uuid),
};

/** One id a target holds that is not the derivation. */
export interface WireIdentityOverride {
	readonly entityKind: "module" | "form";
	readonly novaEntityUuid: string;
	readonly uniqueId: string | null;
	/** Forms only. */
	readonly xmlns: string | null;
}

/**
 * A target's overrides first, the derivation for every entity without one.
 * The fallback is per entity and per field: a form row that holds HQ's
 * `xmlns` and no `unique_id` gives that `xmlns` beside the derived id.
 */
export function targetWireIdentity(
	overrides: readonly WireIdentityOverride[],
): WireIdentity {
	if (overrides.length === 0) return DERIVED_WIRE_IDENTITY;
	const moduleIds = new Map<string, string>();
	const formIds = new Map<string, string>();
	const formXmlns = new Map<string, string>();
	for (const override of overrides) {
		if (override.entityKind === "module") {
			if (override.uniqueId !== null) {
				moduleIds.set(override.novaEntityUuid, override.uniqueId);
			}
			continue;
		}
		if (override.uniqueId !== null) {
			formIds.set(override.novaEntityUuid, override.uniqueId);
		}
		if (override.xmlns !== null) {
			formXmlns.set(override.novaEntityUuid, override.xmlns);
		}
	}
	return {
		moduleUniqueId: (moduleUuid) =>
			moduleIds.get(moduleUuid) ?? derivedUniqueId(moduleUuid),
		formUniqueId: (formUuid) =>
			formIds.get(formUuid) ?? derivedUniqueId(formUuid),
		formXmlns: (form) =>
			formXmlns.get(form.uuid) ?? derivedFormXmlns(form.uuid),
	};
}
