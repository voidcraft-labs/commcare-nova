/** Closed identity families shared by canonical inventory and authored references.
 * This module has no dependency on tool registration or execution. */
import { CANONICAL_UUID_PATTERN, LOOKUP_UUID_V7_PATTERN } from "@/lib/domain";

type JsonNode = Record<string, unknown>;

export type AuthorableIdentityFamily =
	| "module"
	| "form"
	| "field"
	| "select-option"
	| "case-list-column"
	| "case-list-sort"
	| "case-detail-tab"
	| "case-mapping-row"
	| "installation-profile"
	| "project-search"
	| "project-search-parameter"
	| "search-input"
	| "worker-property"
	| "user-type"
	| "persona"
	| "organization-level"
	| "location-property"
	| "location"
	| "case-operation"
	| "form-link"
	| "form-entry-supply"
	| "form-opening-assignment"
	| "entry-point"
	| "automation"
	| "automation-criterion"
	| "automation-setup-criterion"
	| "automation-update"
	| "automation-recipient"
	| "automation-event"
	| "automation-user-data-filter"
	| "search-filter"
	| "media-asset"
	| "lookup-table"
	| "lookup-column"
	| "lookup-attribute"
	| "lookup-value-property"
	| "lookup-row"
	| "project-worker"
	| "project-place"
	| "worker-group";

export interface AuthorableIdentityPointer {
	readonly tool: string;
	readonly schemaPointer: string;
	readonly logicalPointer: string;
	readonly property: string;
	readonly discriminators: readonly string[];
	readonly family: AuthorableIdentityFamily;
	readonly pattern: string;
	readonly schema: JsonNode;
}

interface UnclassifiedIdentityPointer
	extends Omit<AuthorableIdentityPointer, "family"> {}

function jsonPointer(tokens: readonly string[]): string {
	return `/${tokens
		.map((token) => token.replaceAll("~", "~0").replaceAll("/", "~1"))
		.join("/")}`;
}

function identityProperty(tokens: readonly string[]): string {
	for (let index = tokens.length - 1; index >= 0; index -= 1) {
		if (tokens[index] !== "properties") continue;
		const property = tokens[index + 1];
		if (property !== undefined) return property;
	}
	/* An array's item schema can itself be the identity string, e.g.
	 * `columnUuids: uuidSchema[]`; in that case the owning property is the last
	 * property token before `items`. */
	return "unknown";
}

function logicalPointer(tokens: readonly string[]): string {
	const normalized: string[] = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "properties") {
			const property = tokens[index + 1];
			if (property !== undefined) normalized.push(property);
			index += 1;
			continue;
		}
		if (token === "items" || token === "additionalItems") {
			normalized.push("*");
			continue;
		}
		if (token === "definitions" || token === "$defs") {
			const definition = tokens[index + 1];
			if (definition !== undefined) normalized.push(`$${definition}`);
			index += 1;
			continue;
		}
		if (
			token === "oneOf" ||
			token === "anyOf" ||
			token === "allOf" ||
			/^\d+$/.test(token)
		) {
		}
	}
	return jsonPointer(normalized);
}

export function classifyIdentity(
	occurrence: Pick<
		UnclassifiedIdentityPointer,
		"tool" | "property" | "discriminators" | "logicalPointer"
	>,
): AuthorableIdentityFamily | null {
	const {
		tool,
		property,
		discriminators,
		logicalPointer: pointer,
	} = occurrence;
	// A directory identity can belong to a different application in the same
	// Project. Its exact ID and owning app come from the authorized directory.
	if (
		(tool === "get_worker_groups" || tool === "edit_worker_group") &&
		property === "groupId"
	)
		return "worker-group";
	if (tool === "edit_worker_group" && property === "personaId")
		return "project-worker";
	if (
		tool === "edit_lookup_rows" &&
		property === "id" &&
		pointer.endsWith("/assignments/*/id")
	) {
		if (discriminators.includes("group")) return "worker-group";
		if (discriminators.includes("worker")) return "project-worker";
		if (discriminators.includes("place")) return "project-place";
	}
	if (tool === "start_app_test" && pointer === "/places/*/uuid")
		return "location";
	if (
		(property === "selection" &&
			(tool === "edit_form_entry" ||
				discriminators.includes("form-selection"))) ||
		(property === "datum" && discriminators.includes("entry-value"))
	)
		return "form-entry-supply";
	if (
		(tool === "create_form" && property === "shared_form_uuid") ||
		(tool === "edit_form_entry" && property === "parentFormUuid")
	)
		return "form";
	if (pointer.endsWith("/source/under/relationship/question")) return "field";
	if (pointer.endsWith("/addressReceiver/source")) return "search-input";
	if (tool === "edit_form_entry") {
		if (
			(property === "uuid" || property === "after") &&
			discriminators.some((tag) => tag.endsWith("-assignment"))
		)
			return "form-opening-assignment";
		if (property === "field") return "field";
		if (property === "uuid" || property === "after") return "form-entry-supply";
		if (property === "module") return "module";
		if (property === "table") return "lookup-table";
		if (property === "column") return "lookup-column";
	}
	if (
		(tool === "updateApp" || tool === "update_app") &&
		pointer === "/installation_profile/uuid"
	)
		return "installation-profile";
	if (tool === "configure_project_search") {
		if (pointer === "/change/search/uuid" || pointer === "/change/uuid")
			return "project-search";
		if (pointer === "/change/parameters/*/uuid")
			return "project-search-parameter";
		if (pointer === "/change/fields/*/fieldUuid") return "search-input";
	}
	if (property === "question" && pointer.includes("/androidApp/"))
		return "field";
	if (property === "tableId") return "lookup-table";
	if (tool.includes("lookup")) {
		if (
			property === "attributeId" ||
			property === "attributeIds" ||
			/\/attributes\/\*\/id$/.test(pointer)
		)
			return "lookup-attribute";
		if (property === "propertyId" || /\/properties\/\*\/id$/.test(pointer))
			return "lookup-value-property";
	}
	if (
		/(?:^|\/)(?:columnId|valueColumnId|labelColumnId|sortColumnId|resultColumnId|slot)\/(?:where\/)?(?:attributeId|propertyId)$/.test(
			pointer,
		)
	) {
		return property === "attributeId"
			? "lookup-attribute"
			: "lookup-value-property";
	}
	if (
		property === "columnId" ||
		property === "columnIds" ||
		property === "afterColumnId" ||
		property === "valueColumnId" ||
		property === "labelColumnId" ||
		property === "sortColumnId" ||
		property === "resultColumnId"
	) {
		return "lookup-column";
	}
	if (property === "rowId" || property === "afterRowId") return "lookup-row";
	if (
		(property === "values" || property === "valuePatch") &&
		(tool === "create_location" ||
			tool === "update_location" ||
			tool === "start_app_test")
	) {
		return "location-property";
	}

	if (
		property === "moduleUuid" ||
		property === "confirmedModuleUuids" ||
		property === "parentCaseModuleUuid" ||
		(property === "module" &&
			discriminators.some((kind) =>
				["selected-case", "selected-cases", "tile-group-parents"].includes(
					kind,
				),
			))
	) {
		return "module";
	}
	if (
		property === "parentModuleUuid" &&
		(tool === "create_module" || tool === "move_module")
	) {
		return "module";
	}
	/* A menu listing another menu's forms names its source menu. */
	if (
		(property === "menuUuid" ||
			property === "previousMenuUuid" ||
			property === "sourceMenuUuid") &&
		(tool === "create_module" || tool === "update_module")
	) {
		return "module";
	}
	/* `move_module` anchors on the module it now follows. The slot is named
	 * for the mutation it emits, so the family comes from the tool. */
	if (property === "after" && tool === "move_module") return "module";
	if (
		property === "formUuid" ||
		(property === "excludedFormUuids" && tool === "create_module") ||
		(property === "form" &&
			discriminators.some((kind) =>
				[
					"form-root",
					"connect-learn",
					"connect-assessment",
					"connect-delivery",
					"connect-task",
				].includes(kind),
			))
	)
		return "form";
	/* A Connect activity's part names the activity, a field of the form. */
	if (
		property === "activity" &&
		discriminators.some((kind) =>
			[
				"connect-learn",
				"connect-assessment",
				"connect-delivery",
				"connect-task",
			].includes(kind),
		)
	)
		return "field";
	if (property === "entryPointUuid") return "entry-point";
	if (property === "automationUuid" || property === "afterAutomationUuid") {
		return "automation";
	}
	if (
		(property === "parentUuid" ||
			property === "parentId" ||
			property === "afterSiblingUuid" ||
			property === "afterSiblingId") &&
		(tool === "create_location" ||
			tool === "update_location" ||
			tool === "start_app_test" ||
			tool === "move_location" ||
			(tool === "get_organization" && property === "parentId"))
	) {
		return "location";
	}
	/* `set_form_sections` names sections (fields of kind `section`) and the
	 * top-level questions on each page; both are field identities. */
	if (
		property === "sectionUuid" ||
		(property === "fields" && tool === "set_form_sections")
	) {
		return "field";
	}
	if (
		property === "fieldUuid" ||
		property === "parentUuid" ||
		property === "afterFieldUuid" ||
		property === "beforeFieldUuid" ||
		property === "idFrom" ||
		property === "field" ||
		property === "repeat"
	) {
		return "field";
	}
	if (
		property === "optionUuid" ||
		(property === "options" && discriminators.includes("choice")) ||
		(property === "option" && discriminators.includes("itext")) ||
		// A form behavior's carrier or shared text names its choice.
		(property === "option" && tool === "update_form")
	)
		return "select-option";
	if (
		property === "columnUuid" ||
		property === "columnUuids" ||
		// A named tile position holds the field placed there.
		property === "namedSlots" ||
		property === "resultsColumnOrder" ||
		property === "detailsColumnOrder"
	) {
		return "case-list-column";
	}
	if (
		property === "searchInputUuid" ||
		property === "searchInputUuids" ||
		property === "searchInputOrder"
	) {
		return "search-input";
	}
	if (
		property === "sortUuid" ||
		property === "calculatedSortUuids" ||
		property === "removeCalculatedSorts"
	)
		return "case-list-sort";
	if (property === "tabUuid") return "case-detail-tab";
	if (property === "orderFields" && tool === "set_case_detail_tabs")
		return "case-list-column";
	if (property === "userPropertyUuid" || property === "workerPropertyUuid")
		return "worker-property";
	if (property === "userTypeUuid") return "user-type";
	if (property === "personaUuid") return "persona";
	if (
		property === "locationPropertyUuid" ||
		(property === "property" && discriminators.includes("location-field"))
	)
		return "location-property";
	if (
		property === "levelUuid" ||
		property === "levelUuids" ||
		property === "locationLevelUuids" ||
		property === "parentLevelUuid" ||
		property === "downToLevelUuid" ||
		property === "alsoIncludeTopDownToLevelUuid" ||
		property === "fromLevelUuid" ||
		(property === "level" && discriminators.includes("location-field"))
	) {
		return "organization-level";
	}
	if (
		property === "locationUuid" ||
		property === "locationUuids" ||
		property === "locationIds" ||
		property === "parentUuid" ||
		property === "afterSiblingUuid"
	) {
		return "location";
	}
	if (
		property === "operationUuid" ||
		property === "caseCreationUuids" ||
		property === "afterOperationUuid" ||
		property === "opUuid"
	) {
		return "case-operation";
	}
	if (property === "linkUuid" || property === "afterLinkUuid") {
		return "form-link";
	}
	if (
		property === "assetId" ||
		property === "image" ||
		property === "audio" ||
		property === "video" ||
		property === "videoInline" ||
		property === "icon" ||
		property === "audioLabel" ||
		property === "logo"
	) {
		return "media-asset";
	}

	// A column's ordered display rule and a calculation's translated text are
	// anonymous items of their column, each named by its stable id.
	if (property === "textUuid") return "case-mapping-row";
	/* `edit_search_filter` names one filter of a menu's online search, and
	 * anchors a move or an add on the filter it follows. */
	if (
		tool === "edit_search_filter" &&
		(property === "uuid" || property === "after") &&
		pointer.startsWith("/change/")
	)
		return "search-filter";
	if (property === "uuid") {
		if (pointer.includes("/mapping/") || pointer.includes("/texts/"))
			return "case-mapping-row";
		if (tool === "add_automations" || tool === "update_automation") {
			if (pointer.includes("/criteria/")) return "automation-criterion";
			if (pointer.includes("/setupOnlyCriteria/")) {
				return "automation-setup-criterion";
			}
			if (pointer.includes("/updates/")) return "automation-update";
			if (pointer.includes("/recipients/")) return "automation-recipient";
			if (pointer.includes("/events/")) return "automation-event";
			if (pointer.includes("/userDataFilters/")) {
				return "automation-user-data-filter";
			}
			return "automation";
		}
		if (
			discriminators.includes("field") ||
			discriminators.includes("field-ref") ||
			discriminators.includes("path-ref") ||
			pointer.includes("$FormFieldRef")
		) {
			return "field";
		}
		if (tool === "update_user_property" || tool === "remove_user_property") {
			return "worker-property";
		}
		if (tool === "update_user_type" || tool === "remove_user_type") {
			return "user-type";
		}
		if (tool === "update_persona" || tool === "remove_persona") {
			return "persona";
		}
		if (
			tool === "add_organization_levels" ||
			tool === "update_organization_level" ||
			tool === "remove_organization_level"
		) {
			return "organization-level";
		}
		if (
			tool === "add_location_properties" ||
			tool === "update_location_property" ||
			tool === "remove_location_property"
		) {
			return "location-property";
		}
	}
	return null;
}

export function collectIdentitySchemaPointers(
	tool: string,
	json: JsonNode,
): AuthorableIdentityPointer[] {
	const found: AuthorableIdentityPointer[] = [];

	function walk(
		node: unknown,
		tokens: readonly string[],
		discriminators: readonly string[],
	): void {
		if (Array.isArray(node)) {
			for (const [index, entry] of node.entries()) {
				walk(entry, [...tokens, String(index)], discriminators);
			}
			return;
		}
		if (node === null || typeof node !== "object") return;
		const schema = node as JsonNode;
		const pattern = schema.pattern;
		if (
			pattern === CANONICAL_UUID_PATTERN.source ||
			pattern === LOOKUP_UUID_V7_PATTERN.source
		) {
			const unclassified: UnclassifiedIdentityPointer = {
				tool,
				schemaPointer: jsonPointer(tokens),
				logicalPointer: logicalPointer(tokens),
				property: identityProperty(tokens),
				discriminators,
				pattern,
				schema,
			};
			const family = classifyIdentity(unclassified);
			if (family === null) {
				throw new Error(
					`Unclassified authored identity: ${tool} ${unclassified.schemaPointer} (${unclassified.property}; ${discriminators.join(",")})`,
				);
			}
			found.push({ ...unclassified, family });
		}

		let nestedDiscriminators = discriminators;
		const properties = schema.properties as JsonNode | undefined;
		const kind = (properties?.kind ??
			(tool === "edit_form_entry" ? properties?.operation : undefined)) as
			| JsonNode
			| undefined;
		if (kind !== undefined) {
			const values: string[] = [];
			if (typeof kind.const === "string") values.push(kind.const);
			if (Array.isArray(kind.enum)) {
				for (const value of kind.enum) {
					if (typeof value === "string") values.push(value);
				}
			}
			if (values.length > 0) {
				nestedDiscriminators = [...discriminators, ...values];
			}
		}
		for (const [key, value] of Object.entries(schema)) {
			walk(value, [...tokens, key], nestedDiscriminators);
		}
	}

	walk(json, [], []);
	return found;
}
