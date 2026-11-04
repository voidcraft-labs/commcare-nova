/**
 * Rule: a whole-number question's starting value is never a decimal number,
 * which stops the form as it opens (`lib/domain/startingValueFit.ts` holds
 * the CommCare fact). An `int` question whose `default_value` types as
 * `decimal` in its slot is `WHOLE_NUMBER_STARTS_ON_DECIMAL`: a read of a
 * property that holds decimal numbers, a decimal calculation, or a decimal
 * question's answer. A value nothing types holds no opinion.
 *
 * App-scoped because the property's type comes from writers in every form:
 * a decimal writer in one form refuses the starting value of an integer
 * question in another, so the rule runs on every validation, scoped or not,
 * and its code is scope-exempt.
 */

import { descendantFieldUuids } from "@/lib/doc/fieldWalk";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { fieldPreload } from "@/lib/domain/casePreload";
import { slotContext } from "@/lib/domain/expression/context";
import { scalarDataType, typeOf } from "@/lib/domain/expression/typeChecker";
import { wholeNumberStartsOnDecimal } from "@/lib/domain/startingValueFit";
import { type ValidationError, validationError } from "../errors";

export function wholeNumberStartRule(doc: BlueprintDoc): ValidationError[] {
	const errors: ValidationError[] = [];
	for (const moduleUuid of doc.moduleOrder) {
		const module = doc.modules[moduleUuid];
		if (module === undefined) continue;
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid];
			if (form === undefined) continue;
			for (const uuid of descendantFieldUuids(doc, formUuid)) {
				const field = doc.fields[uuid];
				if (field?.kind !== "int" || field.default_value === undefined)
					continue;
				const ctx = slotContext(
					doc,
					{ entity: "field", uuid, slot: "default_value" },
					new Map(),
				);
				if (ctx === undefined) continue;
				if (
					!wholeNumberStartsOnDecimal(
						field,
						scalarDataType(typeOf(field.default_value, ctx)?.data),
					)
				)
					continue;
				const preload = fieldPreload(field);
				const what =
					preload === undefined
						? "a value that can be a decimal number"
						: `"${preload.property}" from the case, which holds decimal numbers`;
				const remedy =
					preload === undefined
						? "wrap its starting value in int(...) to keep the whole part"
						: `start it on the whole part, int(#${preload.caseType}/${preload.property})`;
				errors.push(
					validationError(
						"WHOLE_NUMBER_STARTS_ON_DECIMAL",
						"field",
						`Question "${field.id}" in "${form.name}" starts on ${what}, and CommCare stops a form when a whole-number question opens on a decimal number. You can make "${field.id}" a decimal question, or ${remedy}.`,
						{
							moduleUuid,
							moduleName: module.name,
							formUuid,
							formName: form.name,
							fieldUuid: uuid,
							fieldId: field.id,
							field: "default_value",
						},
						preload === undefined
							? {}
							: { caseType: preload.caseType, property: preload.property },
					),
				);
			}
		}
	}
	return errors;
}
