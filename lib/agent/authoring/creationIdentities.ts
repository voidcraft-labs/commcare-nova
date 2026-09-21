/** Creation slots only. References and anchors never allocate an identity. */
export type CreationEntityKind =
	| "entry_point"
	| "module"
	| "form"
	| "field"
	| "option"
	| "case_list_column"
	| "search_input"
	| "case_operation"
	| "worker_property"
	| "user_type"
	| "persona"
	| "organization_level"
	| "location_property"
	| "location"
	| "automation"
	| "automation_criterion"
	| "automation_setup_criterion"
	| "automation_update"
	| "automation_recipient"
	| "automation_event"
	| "automation_user_data_filter";

export interface CreationIdentitySpec {
	readonly path: readonly string[];
	readonly entityKind: CreationEntityKind;
	readonly preserveExisting?: true;
}

const spec = (
	path: readonly string[],
	entityKind: CreationEntityKind,
	preserveExisting?: true,
): CreationIdentitySpec => ({
	path,
	entityKind,
	...(preserveExisting && { preserveExisting }),
});

const AUTOMATION_ITEM_SPECS = (
	prefix: readonly string[],
	preserveExisting?: true,
): readonly CreationIdentitySpec[] => [
	spec(
		[...prefix, "criteria", "*", "uuid"],
		"automation_criterion",
		preserveExisting,
	),
	spec(
		[...prefix, "setupOnlyCriteria", "*", "uuid"],
		"automation_setup_criterion",
		preserveExisting,
	),
	spec(
		[...prefix, "updates", "*", "uuid"],
		"automation_update",
		preserveExisting,
	),
	spec(
		[...prefix, "recipients", "*", "uuid"],
		"automation_recipient",
		preserveExisting,
	),
	spec(
		[...prefix, "schedule", "events", "*", "uuid"],
		"automation_event",
		preserveExisting,
	),
	spec(
		[...prefix, "userDataFilters", "*", "uuid"],
		"automation_user_data_filter",
		preserveExisting,
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
	startAppTest: [spec(["places", "*", "uuid"], "location")],
	/* Shared structural creation tools. */
	addEntryPoint: [spec(["entryPointUuid"], "entry_point")],
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
	 * items retain existing identities when the author names them. */
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
