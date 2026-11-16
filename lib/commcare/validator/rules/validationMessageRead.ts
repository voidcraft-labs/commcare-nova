/**
 * A read of a question's validation message the form does not hold.
 *
 * `jr:itext` reads the text a form's translation block holds. The XForm writes
 * a question's validation message only where its bind carries a constraint
 * (`xform/validationMessage.ts::constraintCarryingQuestions`), because no
 * runtime shows a message no constraint can fail. Where it writes none, Core's
 * handler answers the read with `[itext:<id>]` (commcare-core
 * `FormDef.java::initEvalContext`), so the form would show or save that
 * placeholder in place of the message the document holds. The checker admits
 * the read, since whether the constraint is there depends on where the form's
 * case change is kept, which is the wire's fact; this rule refuses it at the
 * read, for every expression slot of the form and every calculated value of
 * its text. A read of a message the form does not hold at all (a question of
 * another form, a question gone, a question with no message) is the checker's
 * `unknown-form-field` refusal (`typeChecker.ts::formTextAdmission`), and this
 * rule says nothing of it: giving that question a condition would not clear it.
 */

import {
	descendantFieldUuids,
	formExpressionSlotValues,
} from "@/lib/doc/fieldWalk";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { expressionSlotLabel } from "@/lib/domain/expression/slotLabels";
import { walkExpressionNodes } from "@/lib/domain/expression/walk";
import type { Field } from "@/lib/domain/fields";
import { ownRecordValue } from "@/lib/domain/records";
import type { Uuid } from "@/lib/domain/uuid";
import { constraintCarryingQuestions } from "../../xform/validationMessage";
import { type ValidationError, validationError } from "../errors";

export function unwrittenValidationMessageReads(
	doc: BlueprintDoc,
	location: {
		readonly moduleUuid: Uuid;
		readonly moduleName: string;
		readonly formUuid: Uuid;
		readonly formName: string;
	},
): ValidationError[] {
	const errors: ValidationError[] = [];
	let carriers: ReadonlySet<Uuid> | undefined;
	let formFields: ReadonlySet<Uuid> | undefined;
	/** The question whose message the form holds, as the checker reads it
	 * present: a field of this form with a validation message. */
	const messageHolder = (uuid: Uuid): Field | undefined => {
		formFields ??= descendantFieldUuids(doc, location.formUuid);
		if (!formFields.has(uuid)) return undefined;
		const field = ownRecordValue(doc.fields, uuid);
		return field !== undefined &&
			"validate_msg" in field &&
			field.validate_msg !== undefined
			? field
			: undefined;
	};
	for (const { ref, expression } of formExpressionSlotValues(
		doc,
		location.formUuid,
	)) {
		const read = new Map<Uuid, Field>();
		walkExpressionNodes(expression, (node) => {
			if (node.kind !== "itext") return;
			if (node.unit.role !== "field-validation-message") return;
			const holder = messageHolder(node.unit.field);
			if (holder === undefined) return;
			carriers ??= constraintCarryingQuestions(doc, location.formUuid);
			if (!carriers.has(holder.uuid)) read.set(holder.uuid, holder);
		});
		for (const [questionUuid, holder] of read) {
			const question = holder.id;
			const owner = ref.entity === "field" ? doc.fields[ref.uuid] : undefined;
			const label = expressionSlotLabel(ref.slot);
			const subject =
				owner === undefined ? `This ${label}` : `"${owner.id}"'s ${label}`;
			errors.push(
				validationError(
					"INVALID_REF",
					ref.entity === "field" ? "field" : "form",
					`${subject} reads the validation message of "${question}", which the form holds only while "${question}" has a validation condition, because no message is shown where no condition can fail. A device would read a placeholder there in place of the message. You can give "${question}" a validation condition, or read other wording.`,
					{
						...location,
						...(owner === undefined
							? {}
							: { fieldUuid: owner.uuid, fieldId: owner.id }),
						field: ref.slot,
					},
					{
						identity: "validation-message",
						questionUuid,
						questionId: question,
					},
				),
			);
		}
	}
	return errors;
}
