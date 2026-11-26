import {
	type BlueprintDoc,
	effectiveCaseSearchConfig,
	type Module,
	requestedRecordTypes,
	type Uuid,
} from "@/lib/domain";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import { checkExpression, slotContext } from "@/lib/domain/expression";
import { LOCATION_NOT_IN_SEARCH_MESSAGE } from "@/lib/domain/expression/typeChecker";
import {
	isOrdinaryCaseSearchConfig,
	projectSpaceMatchingFits,
} from "@/lib/domain/modules";
import {
	CASE_NODE_ATTRIBUTE_PROPERTIES,
	isDeviceOnlyCaseProperty,
	STANDARD_CASE_LIST_PROPERTY_DATA_TYPES,
} from "@/lib/domain/standardCaseProperties";
import {
	readSearchFilterTarget,
	searchFilterKey,
} from "../../../suite/case-search/nativeFilters";
import { type ValidationError, validationError } from "../../errors";
import {
	checkErrorDetails,
	type LookupTypeIndex,
	semanticCheckErrors,
} from "../../lookupTypeContext";

export function nativeSearchFilters(
	mod: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
	lookups?: LookupTypeIndex,
): ValidationError[] {
	const errors: ValidationError[] = [];
	const filters = mod.caseListConfig?.searchFilters ?? [];
	const types = effectiveCaseTypes(doc);
	const requested = mod.caseType
		? requestedRecordTypes(mod.caseType, mod.caseListConfig)
		: [];
	// An order names a property of a requested record type or an indexed attribute (`case_search/const.py::INDEXED_METADATA_BY_KEY`).
	const order = [
		...(isOrdinaryCaseSearchConfig(mod.caseSearchConfig)
			? (mod.caseSearchConfig.requestOrder ?? [])
			: []),
		...filters.flatMap((row) => ("order" in row ? row.order : [])),
	];
	if (order.length > 0) {
		const properties = types
			.filter((type) => requested.includes(type.name))
			.flatMap((type) => type.properties);
		for (const term of order) {
			if (isDeviceOnlyCaseProperty(term.property)) {
				errors.push(
					validationError(
						"CASE_SEARCH_FILTER_INVALID",
						"module",
						LOCATION_NOT_IN_SEARCH_MESSAGE,
						{ moduleUuid, moduleName: mod.name },
						{ reason: "order-device-only", property: term.property },
					),
				);
				continue;
			}
			const known =
				CASE_NODE_ATTRIBUTE_PROPERTIES.has(term.property) ||
				Object.hasOwn(STANDARD_CASE_LIST_PROPERTY_DATA_TYPES, term.property) ||
				properties.some((property) => property.name === term.property);
			if (!known)
				errors.push(
					validationError(
						"CASE_SEARCH_FILTER_INVALID",
						"module",
						`Choose a property from the records this search requests in place of “${term.property}” to order the matches.`,
						{ moduleUuid, moduleName: mod.name },
					),
				);
		}
	}
	// One `commcare_blacklisted_owner_ids` value per request: HQ refuses the
	// key twice (`SearchCriteria._validate_multiple_terms`).
	const ownerRows = filters.filter(
		(row) => "target" in row && row.target.kind === "excluded-owners",
	);
	if (ownerRows.length > 1)
		errors.push(
			validationError(
				"CASE_SEARCH_FILTER_INVALID",
				"module",
				"Choose one rule for the owners to leave out of Search, and name all of their IDs in it.",
				{ moduleUuid, moduleName: mod.name },
			),
		);
	const names = new Set(
		mod.caseListConfig?.searchInputs.map((input) => input.name),
	);
	const offered = new Set(
		Object.values(doc.modules).map((menu) => menu.caseType),
	);
	for (const type of mod.caseListConfig?.additionalCaseTypes ?? []) {
		if (type === mod.caseType || !offered.has(type))
			errors.push(
				validationError(
					"CASE_SEARCH_FILTER_INVALID",
					"module",
					"Choose another record type with a menu in this app.",
					{ moduleUuid, moduleName: mod.name },
				),
			);
	}
	const checkRelatedId = (property: string) => {
		if (isDeviceOnlyCaseProperty(property)) {
			errors.push(
				validationError(
					"CASE_SEARCH_FILTER_INVALID",
					"module",
					LOCATION_NOT_IN_SEARCH_MESSAGE,
					{ moduleUuid, moduleName: mod.name },
					{ reason: "related-record-id-device-only", property },
				),
			);
			return;
		}
		if (
			!types.some(
				(type) =>
					requested.includes(type.name) &&
					type.properties.some((p) => p.name === property),
			)
		) {
			errors.push(
				validationError(
					"CASE_SEARCH_FILTER_INVALID",
					"module",
					"Choose a property on a record type in this search that holds the related record ID.",
					{ moduleUuid, moduleName: mod.name },
				),
			);
		}
	};
	const dedicatedProperty =
		effectiveCaseSearchConfig(mod)?.relatedRecordIdProperty;
	if (dedicatedProperty) checkRelatedId(dedicatedProperty);
	for (const [index, filter] of filters.entries()) {
		const reject = (message: string, details: Record<string, string>) =>
			errors.push(
				validationError(
					"CASE_SEARCH_FILTER_INVALID",
					"module",
					message,
					{ moduleUuid, moduleName: mod.name },
					{ index: String(index), filterUuid: filter.uuid, ...details },
				),
			);
		if (!("target" in filter)) {
			if (
				filter.kind === "request-record-type" &&
				!effectiveCaseTypes(doc).some((type) => type.name === filter.caseType)
			) {
				reject("Choose a record type in this app for the search request.", {
					reason: "record-type",
				});
			}
			if (filter.kind === "related-record-id") checkRelatedId(filter.property);
			if (
				filter.kind === "related-record-id" &&
				(effectiveCaseSearchConfig(mod)?.relatedRecordIdProperty ||
					filters.some(
						(other) =>
							other !== filter &&
							"kind" in other &&
							other.kind === "related-record-id",
					))
			) {
				reject("Choose one property that holds the related record ID.", {
					reason: "related-record-id",
				});
			}
			continue;
		}
		const key = searchFilterKey(filter.target);
		const parsed = readSearchFilterTarget(key);
		if (names.has(key))
			reject(
				`Search filter ${index + 1} on "${mod.name}" sends "${key}", which a search field there already sends.`,
				{ reason: "key-taken", key },
			);
		if (parsed?.kind !== filter.target.kind)
			reject(
				`Search filter ${index + 1} on "${mod.name}" names record information its key "${key}" does not read back as.`,
				{ reason: "target", key },
			);
		const scope = slotContext(
			doc,
			{
				entity: "module",
				uuid: moduleUuid,
				slot: "search_filter_value",
				member: { filterUuid: filter.uuid },
			},
			lookups ?? new Map(),
		);
		if (scope) {
			for (const issue of semanticCheckErrors(
				checkExpression(filter.value, scope),
			))
				reject(
					`Search filter ${index + 1} on "${mod.name}" has a value the search screen can't work out: ${issue.message}`,
					{ reason: "value", ...checkErrorDetails(issue, scope) },
				);
		}
	}
	for (const input of mod.caseListConfig?.searchInputs ?? []) {
		if (input.kind !== "simple" || input.matching !== "project-space") continue;
		if (projectSpaceMatchingFits(input)) continue;
		errors.push(
			validationError(
				"CASE_SEARCH_FILTER_INVALID",
				"module",
				`Search field "${input.name}" on "${mod.name}" uses the project space's matching rule, which matches only the field's own property with no separate matching rule.`,
				{ moduleUuid, moduleName: mod.name },
				{
					inputUuid: input.uuid,
					reason: "project-space-matching",
					field: input.name,
				},
			),
		);
	}
	return errors;
}
