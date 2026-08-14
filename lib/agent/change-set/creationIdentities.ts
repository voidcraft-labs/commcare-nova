/**
 * The ONE annotated table of raw creation-identity slots on the private
 * executor surface.
 *
 * Three consumers derive from it, so they cannot disagree:
 *
 *   - the executor wire projection (`lib/agent/build/executorWireSchemas.ts`)
 *     narrows each path's slot to a REQUIRED `{ handle }` and refuses raw
 *     UUIDs before dispatch;
 *   - the shared-tool handle declarers (`handleDeclarations.ts`) walk the
 *     same paths to bind each declared handle with its entity kind;
 *   - the workspace then resolves `{ handle }` structurally and re-parses the
 *     resolved input through the tool's ORIGINAL canonical schema.
 *
 * Before this table existed, the wire paths and the declarer walkers were two
 * hand-written lists: a slot present in one but not the other made the wire
 * REQUIRE a handle the workspace never bound, and every dispatch died on
 * "handle is not bound" — advice the executor cannot follow. Add a new
 * creatable entity HERE, once.
 *
 * Keep the table closed and explicit so target, parent, and anchor slots
 * never accidentally mint an entity. `referenceIfBound` marks replacement
 * slots (nested option/automation-item replacement), which may preserve a
 * handle already bound to this kind instead of re-declaring it.
 */

import { asHandleRef, type StagedHandleDeclaration } from "./handles";
import type { StagedEntityKind } from "./schemas";

/** One creation slot: where it lives in the RAW tool input (`"*"` walks an
 * array), and what entity kind a handle declared there binds. */
export interface CreationIdentitySpec {
	readonly path: readonly string[];
	readonly entityKind: StagedEntityKind;
	readonly referenceIfBound?: true;
}

const spec = (
	path: readonly string[],
	entityKind: StagedEntityKind,
	referenceIfBound?: true,
): CreationIdentitySpec => ({
	path,
	entityKind,
	...(referenceIfBound && { referenceIfBound }),
});

const AUTOMATION_ITEM_SPECS = (
	prefix: readonly string[],
	referenceIfBound?: true,
): readonly CreationIdentitySpec[] => [
	spec(
		[...prefix, "criteria", "*", "uuid"],
		"automation_criterion",
		referenceIfBound,
	),
	spec(
		[...prefix, "setupOnlyCriteria", "*", "uuid"],
		"automation_setup_criterion",
		referenceIfBound,
	),
	spec(
		[...prefix, "updates", "*", "uuid"],
		"automation_update",
		referenceIfBound,
	),
	spec(
		[...prefix, "recipients", "*", "uuid"],
		"automation_recipient",
		referenceIfBound,
	),
	spec(
		[...prefix, "schedule", "events", "*", "uuid"],
		"automation_event",
		referenceIfBound,
	),
	spec(
		[...prefix, "userDataFilters", "*", "uuid"],
		"automation_user_data_filter",
		referenceIfBound,
	),
];

const FIELD_SPECS = (
	prefix: readonly string[],
): readonly CreationIdentitySpec[] => [
	spec([...prefix, "fieldUuid"], "field"),
	spec([...prefix, "optionsSource", "options", "*", "optionUuid"], "option"),
];

export const CREATION_IDENTITY_SPECS: Readonly<
	Record<string, readonly CreationIdentitySpec[]>
> = {
	/* Shared structural creation tools. */
	createModule: [
		spec(["moduleUuid"], "module"),
		spec(["forms", "*", "formUuid"], "form"),
		...FIELD_SPECS(["forms", "*", "fields", "*"]),
		spec(["case_list_columns", "*", "columnUuid"], "case_list_column"),
	],
	createForm: [spec(["formUuid"], "form"), ...FIELD_SPECS(["fields", "*"])],
	addFields: FIELD_SPECS(["fields", "*"]),
	addCaseListColumns: [
		spec(["columns", "*", "columnUuid"], "case_list_column"),
	],
	configureCaseList: [
		spec(["columns", "*", "columnUuid"], "case_list_column"),
		spec(["searchInputs", "*", "searchInputUuid"], "search_input"),
	],
	updateModule: [
		spec(["case_list_columns", "*", "columnUuid"], "case_list_column"),
	],
	addSearchInputs: [
		spec(["searchInputs", "*", "searchInputUuid"], "search_input"),
	],
	addCaseOperations: [
		spec(["operations", "*", "operationUuid"], "case_operation"),
	],
	addUserProperties: [
		spec(["properties", "*", "userPropertyUuid"], "worker_property"),
	],
	addUserTypes: [spec(["userTypes", "*", "userTypeUuid"], "user_type")],
	addPersonas: [spec(["personas", "*", "personaUuid"], "persona")],
	addOrganizationLevels: [spec(["levels", "*", "uuid"], "organization_level")],
	addLocationProperties: [
		spec(["properties", "*", "locationPropertyUuid"], "location_property"),
	],
	addAutomations: [
		spec(["automations", "*", "uuid"], "automation"),
		...AUTOMATION_ITEM_SPECS(["automations", "*"]),
	],
	/* Replacement tools: the root is an existing reference; nested replacement
	 * items preserve a bound handle or declare a newly introduced one. */
	updateAutomation: AUTOMATION_ITEM_SPECS(["automation"], true),
	editField: [
		spec(
			["updates", "optionsSource", "options", "*", "optionUuid"],
			"option",
			true,
		),
	],
	setFieldOptionsSource: [
		spec(["source", "options", "*", "optionUuid"], "option", true),
	],
};

/** The raw wire paths for one tool — what the executor projection narrows to
 * required handles and refuses raw UUIDs on. */
export function creationIdentityPaths(
	toolName: string,
): readonly (readonly string[])[] {
	return (CREATION_IDENTITY_SPECS[toolName] ?? []).map((entry) => entry.path);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function collectAlongPath(
	value: unknown,
	entry: CreationIdentitySpec,
	index: number,
	out: StagedHandleDeclaration[],
): void {
	const segment = entry.path[index];
	if (segment === undefined) {
		const handle = asHandleRef(value);
		if (handle !== null) {
			out.push({
				handle,
				entityKind: entry.entityKind,
				...(entry.referenceIfBound && { referenceIfBound: true }),
			});
		}
		return;
	}
	if (segment === "*") {
		if (!Array.isArray(value)) return;
		for (const item of value) collectAlongPath(item, entry, index + 1, out);
		return;
	}
	collectAlongPath(asRecord(value)?.[segment], entry, index + 1, out);
}

/** Walk one tool's RAW input along its creation paths and return every handle
 * declaration found. Junk-tolerant: absent or misshapen branches yield
 * nothing (the canonical parse after resolution is what rejects them). */
export function collectCreationHandleDeclarations(
	toolName: string,
	input: unknown,
): readonly StagedHandleDeclaration[] {
	const declarations: StagedHandleDeclaration[] = [];
	for (const entry of CREATION_IDENTITY_SPECS[toolName] ?? []) {
		collectAlongPath(input, entry, 0, declarations);
	}
	return declarations;
}
