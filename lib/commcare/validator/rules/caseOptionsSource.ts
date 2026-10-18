import { caseOptionsNodeset } from "@/lib/commcare/caseOptions";
import { findOnDeviceDateAddIssueInPredicate } from "@/lib/commcare/expression/onDeviceCompatibility";
import { inertLookupWireNaming } from "@/lib/commcare/lookup/naming";
import { matchModeRunsOnDevice } from "@/lib/commcare/predicate/matchModes";
import { formNodeProjection } from "@/lib/commcare/xpath/formNodeProjection";
import { w } from "@/lib/commcare/xpath/wire/builders";
import { orderedFieldUuids } from "@/lib/doc/fieldWalk";
import { type BlueprintDoc, effectiveCaseTypes, type Uuid } from "@/lib/domain";
import { checkExpression, walkConditionArms } from "@/lib/domain/expression";
import { slotContext } from "@/lib/domain/expression/context";
import {
	type ValidationError,
	type ValidationErrorCode,
	validationError,
} from "../errors";
import {
	checkErrorDetails,
	type LookupTypeIndex,
	semanticCheckErrors,
} from "../lookupTypeContext";

export function validateCaseOptionsSources(
	doc: BlueprintDoc,
	formUuid: Uuid,
	moduleUuid: Uuid,
	lookupTables: LookupTypeIndex,
): ValidationError[] {
	const errors: ValidationError[] = [];
	const caseTypes = effectiveCaseTypes(doc);
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
			const finding = (
				code: ValidationErrorCode,
				message: string,
				details?: Record<string, string>,
			) =>
				errors.push(
					validationError(
						code,
						"field",
						message,
						{
							moduleUuid,
							formUuid,
							fieldUuid: uuid,
							fieldId: field.id,
							field: "optionsSource",
						},
						details,
					),
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
			const context = slotContext(
				doc,
				{ entity: "field", uuid, slot: "lookup_options_source" },
				lookupTables,
			);
			if (context === undefined || context.form === undefined)
				throw new Error("A saved case choice filter has no owning slot.");
			const checked = checkExpression(source.filter, context);
			for (const error of semanticCheckErrors(checked))
				finding(
					"CASE_SELECT_FILTER_INVALID",
					`Choices for "${field.id}": ${error.message}`,
					checkErrorDetails(error),
				);
			if (findOnDeviceDateAddIssueInPredicate(source.filter, context))
				finding(
					"CASE_SELECT_FILTER_NOT_ON_DEVICE",
					`Choices for "${field.id}" use a date calculation unavailable on device.`,
				);
			if (checked.errors.length === 0) {
				try {
					caseOptionsNodeset(
						source,
						context,
						{
							formFields: new Map(
								[...(context.form.fields.keys() ?? [])].map((uuid) => [
									uuid,
									w.form(["answer"]),
								]),
							),
							formCaseProperty: () => w.str("selected-case"),
							userPropertySlugs: context.facts.userPropertySlugs,
							organizationLevels: doc.organizationLevels,
							lookup: {
								naming: inertLookupWireNaming(),
								instanceScope: "xform",
							},
						},
						formNodeProjection(doc, context.form),
					);
				} catch (error) {
					finding(
						"CASE_SELECT_FILTER_NOT_ON_DEVICE",
						`Choices for "${field.id}" cannot run on device: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			walkConditionArms(source.filter, (predicate) => {
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
