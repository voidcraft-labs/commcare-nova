/** Client-safe activity catalog. Executable registration is typed against these
 * names and their read/change classification. Server implementations never enter
 * the transcript bundle. */
export interface ToolPresentation {
	readonly kind: "read" | "change" | "activity";
	readonly doing: string;
	readonly done: string;
	readonly detail?: string;
}
const read = (doing: string, done: string, detail?: string) => ({
	kind: "read" as const,
	doing,
	done,
	...(detail && { detail }),
});
const change = (doing: string, done: string) => ({
	kind: "change" as const,
	doing,
	done,
});
export const SHARED_TOOL_PRESENTATION = {
	getAuthoringGuide: read(
		"Reading authoring guidance",
		"Read authoring guidance",
	),
	getAutomations: read("Inspecting automations", "Inspected automations"),
	addAutomations: change("Adding automations", "Added automations"),
	updateAutomation: change("Updating automation", "Updated automation"),
	removeAutomation: change("Removing automation", "Removed automation"),
	addFields: change("Adding fields", "Added fields"),
	getLanguages: read("Reading languages", "Read languages"),
	getTranslatableContent: read("Reading translations", "Read translations"),
	addLanguage: change("Adding language", "Added language"),
	updateLanguage: change("Updating language", "Updated language"),
	removeLanguage: change("Removing language", "Removed language"),
	updateTranslations: change("Updating translations", "Updated translations"),
	getLookupTables: read("Reading data tables", "Read data tables"),
	getLookupTableRows: read("Reading table rows", "Read table rows"),
	createLookupTable: change("Creating data table", "Created data table"),
	updateLookupTable: change("Updating data table", "Updated data table"),
	editLookupColumns: change("Updating table columns", "Updated table columns"),
	editLookupRows: change("Updating table rows", "Updated table rows"),
	replaceLookupRows: change("Replacing table rows", "Replaced table rows"),
	removeLookupTable: change("Removing data table", "Removed data table"),
	setFieldOptionsSource: change(
		"Updating answer choices",
		"Updated answer choices",
	),
	configureConnect: change(
		"Configuring CommCare Connect",
		"Configured CommCare Connect",
	),
	createForm: change("Creating form", "Created form"),
	createModule: change("Creating module", "Created module"),
	editField: change("Updating field", "Updated field"),
	generateSchema: change("Recording the data model", "Recorded the data model"),
	getCaseProperty: read("Reading case property", "Read case property"),
	setCaseTypeParent: change(
		"Updating record relationship",
		"Updated record relationship",
	),
	updateCaseProperty: change("Updating case property", "Updated case property"),
	getField: read("Inspecting a field", "Inspected a field"),
	evaluateForm: read(
		"Checking form behavior",
		"Checked form behavior",
		"Checked answers and proposed record values. No records were submitted; navigation and additional record operations were not checked.",
	),
	getForm: read("Inspecting a form", "Inspected a form"),
	getModule: read("Inspecting a module", "Inspected a module"),
	getCaseOperations: read(
		"Inspecting case operations",
		"Inspected case operations",
	),
	moveField: change("Moving question", "Moved question"),
	setFormSections: change("Arranging sections", "Arranged sections"),
	moveModule: change("Moving module", "Moved module"),
	removeField: change("Removing field", "Removed field"),
	removeForm: change("Removing form", "Removed form"),
	removeModule: change("Removing module", "Removed module"),
	renameCaseProperties: change(
		"Renaming case properties",
		"Renamed case properties",
	),
	searchBlueprint: read("Searching the app", "Searched the app"),
	addCaseOperations: change("Adding case operations", "Added case operations"),
	updateCaseOperation: change(
		"Updating case operation",
		"Updated case operation",
	),
	removeCaseOperation: change(
		"Removing case operation",
		"Removed case operation",
	),
	moveCaseOperation: change("Moving case operation", "Moved case operation"),
	addFormLinks: change("Adding after-submit links", "Added after-submit links"),
	getEntryPoints: read("Reading deep links", "Read deep links"),
	addEntryPoint: change("Adding deep link", "Added deep link"),
	updateEntryPoint: change("Updating deep link", "Updated deep link"),
	removeEntryPoint: change("Removing deep link", "Removed deep link"),
	updateFormLink: change(
		"Updating after-submit link",
		"Updated after-submit link",
	),
	removeFormLink: change(
		"Removing after-submit link",
		"Removed after-submit link",
	),
	moveFormLink: change("Moving after-submit link", "Moved after-submit link"),
	addCaseListColumns: change("Adding columns", "Added columns"),
	configureCaseList: change(
		"Configuring the case list",
		"Configured the case list",
	),
	configureCaseSelection: change(
		"Updating case selection",
		"Updated case selection",
	),
	addSearchInputs: change("Adding search fields", "Added search fields"),
	removeCaseListColumn: change("Removing column", "Removed column"),
	removeSearchInput: change("Removing search field", "Removed search field"),
	reorderCaseListColumns: change("Reordering columns", "Reordered columns"),
	reorderSearchInputs: change(
		"Reordering search fields",
		"Reordered search fields",
	),
	setCaseListFilter: change(
		"Updating available cases",
		"Updated available cases",
	),
	setCaseListTile: change("Updating record tiles", "Updated record tiles"),
	updateCaseListColumn: change("Updating column", "Updated column"),
	updateSearchInput: change("Updating search field", "Updated search field"),
	setCaseSearchAdvanced: change(
		"Updating advanced search",
		"Updated advanced search",
	),
	setCaseSearchDisplay: change(
		"Updating the search screen",
		"Updated the search screen",
	),
	attachFieldMedia: change("Setting field media", "Set field media"),
	attachOptionMedia: change("Setting option media", "Set option media"),
	setMenuMedia: change("Setting menu media", "Set menu media"),
	setAppLogo: change("Updating app logo", "Updated app logo"),
	listMediaAssets: read("Reading media", "Read media"),
	removeMediaAsset: change("Removing media", "Removed media"),
	getUsers: read("Inspecting users", "Inspected users"),
	getOrganization: read("Reading organization", "Read organization"),
	addOrganizationLevels: change(
		"Adding organization levels",
		"Added organization levels",
	),
	updateOrganizationLevel: change(
		"Updating organization level",
		"Updated organization level",
	),
	removeOrganizationLevel: change(
		"Removing organization level",
		"Removed organization level",
	),
	addLocationProperties: change(
		"Adding place information",
		"Added place information",
	),
	updateLocationProperty: change(
		"Updating place information",
		"Updated place information",
	),
	removeLocationProperty: change(
		"Removing place information",
		"Removed place information",
	),
	createLocation: change("Adding place", "Added place"),
	updateLocation: change("Updating place", "Updated place"),
	moveLocation: change("Moving place", "Moved place"),
	setLocationArchived: change(
		"Updating place availability",
		"Updated place availability",
	),
	addUserProperties: change(
		"Adding worker information",
		"Added worker information",
	),
	updateUserProperty: change(
		"Updating worker information",
		"Updated worker information",
	),
	removeUserProperty: change(
		"Removing worker information",
		"Removed worker information",
	),
	addUserTypes: change("Adding roles", "Added roles"),
	updateUserType: change("Updating role", "Updated role"),
	removeUserType: change("Removing role", "Removed role"),
	addPersonas: change("Adding personas", "Added personas"),
	updatePersona: change("Updating persona", "Updated persona"),
	removePersona: change("Removing persona", "Removed persona"),
	updateApp: change("Updating app settings", "Updated app settings"),
	updateForm: change("Updating form", "Updated form"),
	updateModule: change("Updating module", "Updated module"),
} satisfies Record<string, ToolPresentation>;
export const AUTHORING_TOOL_PRESENTATION = {
	readPlan: read("Reading the plan", "Read the plan"),
	writePlan: {
		kind: "activity",
		doing: "Writing the plan",
		done: "Wrote the plan",
	},
	editPlan: {
		kind: "activity",
		doing: "Updating the plan",
		done: "Updated the plan",
	},
	readSource: read("Reading source material", "Read source material"),
	getApp: read("Reading the app", "Read the app"),
	reviewPlan: {
		kind: "activity",
		doing: "Reviewing the plan",
		done: "Reviewed the plan",
	},
	startBuilding: {
		kind: "activity",
		doing: "Starting the app",
		done: "Started the app",
	},
	saveWork: {
		kind: "activity",
		doing: "Saving progress",
		done: "Saved progress",
	},
	reviewApp: {
		kind: "activity",
		doing: "Reviewing the app",
		done: "Reviewed the app",
	},
	translateLanguage: change("Translating the app", "Translated the app"),
	toolSearch: read("Finding authoring tools", "Found authoring tools"),
	askQuestions: {
		kind: "activity",
		doing: "Considering your choices",
		done: "Recorded your choices",
	},
} satisfies Record<string, ToolPresentation>;
const presentations: Readonly<Record<string, ToolPresentation>> = {
	...SHARED_TOOL_PRESENTATION,
	...AUTHORING_TOOL_PRESENTATION,
};
export function toolPresentation(name: string): ToolPresentation | undefined {
	return Object.hasOwn(presentations, name) ? presentations[name] : undefined;
}
