/**
 * Schema-derived inventory of every authored-identity path in the complete
 * shared SA/MCP tool registry.
 *
 * The registry records the exact local JSON-Schema pointer plus a normalized
 * logical pointer used to compare the local Zod, compact SA, and real MCP
 * tools/list projections. Classification is closed: a new patterned identity
 * path with no explicit family rule throws while the registry is generated.
 */

import { z } from "zod";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import { CANONICAL_UUID_PATTERN, LOOKUP_UUID_V7_PATTERN } from "@/lib/domain";

type JsonNode = Record<string, unknown>;

export type AuthorableIdentityFamily =
	| "module"
	| "form"
	| "field"
	| "select-option"
	| "case-list-column"
	| "search-input"
	| "worker-property"
	| "user-type"
	| "persona"
	| "organization-level"
	| "location-property"
	| "location"
	| "case-operation"
	| "form-link"
	| "entry-point"
	| "automation"
	| "automation-criterion"
	| "automation-setup-criterion"
	| "automation-update"
	| "automation-recipient"
	| "automation-event"
	| "automation-user-data-filter"
	| "media-asset"
	| "lookup-table"
	| "lookup-column"
	| "lookup-row";

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

function classifyIdentity(
	occurrence: UnclassifiedIdentityPointer,
): AuthorableIdentityFamily | null {
	const {
		tool,
		property,
		discriminators,
		logicalPointer: pointer,
	} = occurrence;
	if (property === "tableId") return "lookup-table";
	if (
		property === "columnId" ||
		property === "columnIds" ||
		property === "afterColumnId" ||
		property === "valueColumnId" ||
		property === "labelColumnId" ||
		property === "resultColumnId"
	) {
		return "lookup-column";
	}
	if (property === "rowId" || property === "afterRowId") return "lookup-row";
	if (
		(property === "values" || property === "valuePatch") &&
		(tool === "create_location" || tool === "update_location")
	) {
		return "location-property";
	}

	if (property === "moduleUuid" || property === "confirmedModuleUuids") {
		return "module";
	}
	if (
		property === "parentModuleUuid" &&
		(tool === "create_module" || tool === "move_module")
	) {
		return "module";
	}
	/* `move_module` anchors on the module it now follows. The slot is named
	 * for the mutation it emits, so the family comes from the tool. */
	if (property === "after" && tool === "move_module") return "module";
	if (property === "formUuid") return "form";
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
			tool === "move_location")
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
		property === "field" ||
		property === "repeat"
	) {
		return "field";
	}
	if (property === "optionUuid") return "select-option";
	if (
		property === "columnUuid" ||
		property === "columnUuids" ||
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
	if (property === "userPropertyUuid") return "worker-property";
	if (property === "userTypeUuid") return "user-type";
	if (property === "personaUuid") return "persona";
	if (property === "locationPropertyUuid") return "location-property";
	if (
		property === "levelUuid" ||
		property === "levelUuids" ||
		property === "locationLevelUuids" ||
		property === "parentLevelUuid" ||
		property === "downToLevelUuid" ||
		property === "alsoIncludeTopDownToLevelUuid" ||
		property === "fromLevelUuid"
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
		property === "afterOperationUuid" ||
		property === "opUuid" ||
		property === "idFrom"
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
		property === "icon" ||
		property === "audioLabel" ||
		property === "logo"
	) {
		return "media-asset";
	}

	if (property === "uuid") {
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
		const kind = properties?.kind as JsonNode | undefined;
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

export function buildAuthorableIdentityPointerRegistry(): AuthorableIdentityPointer[] {
	return SHARED_TOOL_REGISTRY.flatMap(({ mcpName, tool }) =>
		collectIdentitySchemaPointers(
			mcpName,
			z.toJSONSchema(tool.inputSchema, {
				target: "draft-7",
				io: "input",
			}) as JsonNode,
		),
	);
}

export const AUTHORABLE_IDENTITY_POINTER_REGISTRY =
	buildAuthorableIdentityPointerRegistry();
