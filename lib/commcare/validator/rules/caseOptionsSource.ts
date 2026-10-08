import { caseOptionsNodeset } from "@/lib/commcare/caseOptions";
import { findOnDeviceDateAddIssueInPredicate } from "@/lib/commcare/expression/onDeviceCompatibility";
import { inertLookupWireNaming } from "@/lib/commcare/lookup/naming";
import { matchModeRunsOnDevice } from "@/lib/commcare/predicate/matchModes";
import { orderedFieldUuids } from "@/lib/doc/fieldWalk";
import { type BlueprintDoc, effectiveCaseTypes, type Uuid } from "@/lib/domain";
import { formRecordScope } from "@/lib/domain/formRecordScope";
import {
	checkPredicate,
	type TypeContext,
	walkPredicateNodes,
} from "@/lib/domain/predicate";
import {
	type ValidationError,
	type ValidationErrorCode,
	validationError,
} from "../errors";
import type { LookupTypeIndex } from "../lookupTypeContext";
import { selectFilterFieldTypes } from "./lookupOptionsSource";

export function validateCaseOptionsSources(
	doc: BlueprintDoc,
	formUuid: Uuid,
	moduleUuid: Uuid,
	lookupTables: LookupTypeIndex,
): ValidationError[] {
	const errors: ValidationError[] = [];
	const caseTypes = effectiveCaseTypes(doc);
	const scope = formRecordScope(doc, formUuid);
	const walk = (parent: Uuid) => {
		for (const uuid of orderedFieldUuids(doc, parent)) {
			const field = doc.fields[uuid];
			if (doc.fieldOrder[uuid]) walk(uuid);
			if (
				(field.kind !== "single_select" && field.kind !== "multi_select") ||
				field.optionsSource.kind !== "cases"
			)
				continue;
			const source = field.optionsSource;
			const finding = (code: ValidationErrorCode, message: string) =>
				errors.push(
					validationError(code, "field", message, {
						moduleUuid,
						formUuid,
						fieldUuid: uuid,
						fieldId: field.id,
						field: "optionsSource",
					}),
				);
			const type = caseTypes.find((type) => type.name === source.caseType);
			if (
				!type?.properties.some(
					(property) => property.name === source.labelProperty,
				)
			)
				finding(
					"CASE_SELECT_SOURCE_INVALID",
					`Choices for "${field.id}" need a declared record type and label property.`,
				);
			if (!source.filter) continue;
			const context: TypeContext = {
				caseTypes: [...caseTypes],
				currentCaseType: source.caseType,
				formCaseTypes: scope.caseTypes,
				knownInputs: [],
				formFields: selectFilterFieldTypes(doc, formUuid, uuid),
				lookupTables,
				organizationLevels: doc.organizationLevels,
				userPropertySlugs: new Map(
					Object.values(doc.userProperties ?? {}).map((p) => [p.uuid, p.slug]),
				),
			};
			const checked = checkPredicate(source.filter, context);
			for (const error of checked.ok ? [] : checked.errors)
				finding(
					"CASE_SELECT_FILTER_INVALID",
					`Choices for "${field.id}": ${error.message} Form answers must precede this question and belong to its current or enclosing repeat.`,
				);
			if (findOnDeviceDateAddIssueInPredicate(source.filter, context))
				finding(
					"CASE_SELECT_FILTER_NOT_ON_DEVICE",
					`Choices for "${field.id}" use a date calculation unavailable on device.`,
				);
			if (checked.ok) {
				try {
					caseOptionsNodeset(source, caseTypes, {
						formFields: new Map(
							[...(context.formFields?.keys() ?? [])].map((uuid) => [
								uuid,
								"/data/answer",
							]),
						),
						formCaseProperty: () => "'selected-case'",
						userPropertySlugs: context.userPropertySlugs,
						organizationLevels: doc.organizationLevels,
						lookup: { naming: inertLookupWireNaming(), instanceScope: "xform" },
					});
				} catch (error) {
					finding(
						"CASE_SELECT_FILTER_NOT_ON_DEVICE",
						`Choices for "${field.id}" cannot run on device: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			walkPredicateNodes(source.filter, (predicate) => {
				if (
					predicate.kind === "match" &&
					!matchModeRunsOnDevice(predicate.mode)
				)
					finding(
						"CASE_SELECT_FILTER_NOT_ON_DEVICE",
						`Choices for "${field.id}" use a search matching mode unavailable on device.`,
					);
			});
		}
	};
	walk(formUuid);
	return errors;
}
