/** Canonical case-write diagnostics shared by validation and private authoring reads. */
import type { CaseWriteInventory, Uuid } from "@/lib/domain";
import { caseWriteAdmissionIssues } from "./caseWriteAdmission";
import { type ValidationError, validationError } from "./validator/errors";

interface FormContext {
	formUuid: Uuid;
	moduleUuid: Uuid;
	formName: string;
	moduleName: string;
}

function baseLocation(ctx: FormContext) {
	return {
		moduleUuid: ctx.moduleUuid,
		moduleName: ctx.moduleName,
		formUuid: ctx.formUuid,
		formName: ctx.formName,
	};
}

export function caseWriteAdmissionFindings(
	ctx: FormContext,
	inventory: CaseWriteInventory,
): ValidationError[] {
	const errors: ValidationError[] = [];
	const bucketScope = (
		bucket: CaseWriteInventory["buckets"][number],
	): string =>
		bucket.kind === "primary"
			? `the primary ${bucket.caseType} case`
			: bucket.repeatId
				? `the ${bucket.caseType} child case inside repeat "${bucket.repeatId}"`
				: `the ${bucket.caseType} child case`;

	for (const issue of caseWriteAdmissionIssues(inventory)) {
		if (issue.kind === "no-case-action") {
			const { writer } = issue;
			errors.push(
				validationError(
					"CASE_WRITE_NO_CASE_ACTION",
					"form",
					`"${ctx.formName}" gives field "${writer.fieldId}" a case destination (${writer.caseType}.${writer.property}), but this form emits no case action. Remove the case destination, or move the field to a registration, followup, or close form in a module with a case type.`,
					{
						...baseLocation(ctx),
						fieldUuid: writer.fieldUuid,
						fieldId: writer.fieldId,
					},
					{ caseType: writer.caseType, property: writer.property },
				),
			);
			continue;
		}
		if (
			issue.kind === "destination-type-unknown" ||
			issue.kind === "destination-not-direct-child"
		) {
			const { writer } = issue;
			const unknown = issue.kind === "destination-type-unknown";
			errors.push(
				validationError(
					unknown ? "CASE_WRITE_UNKNOWN_TYPE" : "CASE_WRITE_NOT_DIRECT_CHILD",
					"form",
					unknown
						? `"${ctx.formName}" gives field "${writer.fieldId}" a case destination on unknown type "${writer.caseType}". Add that case type, or point the field at the module's own case type or one of its exact direct child types.`
						: `"${ctx.formName}" gives field "${writer.fieldId}" a case destination on "${writer.caseType}", but a field can save only to the module's own case type or one of its exact direct child types. Choose an eligible destination or clear the case destination.`,
					{
						...baseLocation(ctx),
						fieldUuid: writer.fieldUuid,
						fieldId: writer.fieldId,
					},
					{ caseType: writer.caseType, property: writer.property },
				),
			);
			continue;
		}
		if (
			issue.kind === "usercase-property-undeclared" ||
			issue.kind === "usercase-property-managed"
		) {
			const { writer } = issue;
			const undeclared = issue.kind === "usercase-property-undeclared";
			errors.push(
				validationError(
					undeclared
						? "USERCASE_WRITE_UNDECLARED_PROPERTY"
						: "USERCASE_WRITE_MANAGED_PROPERTY",
					"form",
					undeclared
						? `"${ctx.formName}" saves field "${writer.fieldId}" to "${writer.property}" on the worker's own record, but no worker detail by that name exists. Add it under Worker information in App setup, or point the field at one that is already there.`
						: `"${ctx.formName}" saves field "${writer.fieldId}" to "${writer.property}" on the worker's own record. Nova keeps that one in step with the worker's profile, so an answer saved there is replaced the next time that worker changes. Save to a worker detail you added under Worker information instead.`,
					{
						...baseLocation(ctx),
						fieldUuid: writer.fieldUuid,
						fieldId: writer.fieldId,
					},
					{ caseType: writer.caseType, property: writer.property },
				),
			);
			continue;
		}
		if (issue.kind === "usercase-writer-in-repeat") {
			const { writer } = issue;
			errors.push(
				validationError(
					"USERCASE_FIELD_IN_REPEAT",
					"form",
					`"${ctx.formName}" has field "${writer.fieldId}" inside repeat "${writer.repeatId}" saving to the worker's own record. One form writes one worker record, so every iteration would compete for the same slot. Move the field out of the repeat.`,
					{
						...baseLocation(ctx),
						fieldUuid: writer.fieldUuid,
						fieldId: writer.fieldId,
					},
					{ property: writer.property, repeatId: writer.repeatId ?? "" },
				),
			);
			continue;
		}
		if (issue.kind === "reserved-property") {
			const { writer } = issue;
			errors.push(
				validationError(
					"RESERVED_CASE_PROPERTY",
					"form",
					`"${ctx.formName}" saves field "${writer.fieldId}" to case property "${writer.property}", which is reserved for case mechanics. Use Nova's "case_name" for the display name, or choose a custom property.`,
					{
						...baseLocation(ctx),
						fieldUuid: writer.fieldUuid,
						fieldId: writer.fieldId,
					},
					{ reservedName: writer.property },
				),
			);
			continue;
		}
		if (issue.kind === "capture-standard-property") {
			const { writer } = issue;
			errors.push(
				validationError(
					"CAPTURE_CASE_WRITE_STANDARD_PROPERTY",
					"form",
					`"${ctx.formName}" saves the ${writer.fieldKind} field "${writer.fieldId}" to "${writer.property}", which CommCare keeps as the case's own ${writer.property === "case_name" ? "name" : "external id"}. Save the attachment to a property of its own instead.`,
					{
						...baseLocation(ctx),
						fieldUuid: writer.fieldUuid,
						fieldId: writer.fieldId,
					},
					{ property: writer.property, questionId: writer.fieldId },
				),
			);
			continue;
		}
		if (issue.kind === "primary-writer-in-repeat") {
			const { writer, bucket } = issue;
			errors.push(
				validationError(
					"PRIMARY_CASE_FIELD_IN_REPEAT",
					"form",
					`"${ctx.formName}" has field "${writer.fieldId}" inside repeat "${writer.repeatId}" saving to the module's own case type "${bucket.caseType}". A form creates or updates one primary case, so move the field out of the repeat or save it to an exact direct child case type.`,
					{
						...baseLocation(ctx),
						fieldUuid: writer.fieldUuid,
						fieldId: writer.fieldId,
					},
					{
						fieldId: writer.fieldId,
						repeatId: writer.repeatId ?? "",
						caseType: bucket.caseType,
					},
				),
			);
			continue;
		}
		if (issue.kind === "duplicate-property") {
			const fieldIds = issue.writers.map((writer) => writer.fieldId);
			errors.push(
				validationError(
					"CASE_WRITE_DUPLICATE_PROPERTY",
					"form",
					`"${ctx.formName}" has ${fieldIds.length} fields (${fieldIds.map((id) => `"${id}"`).join(", ")}) all saving property "${issue.property}" on ${bucketScope(issue.bucket)}. One emitted case action can have exactly one ordinary field writer per property. Change or clear the extra case destinations.`,
					{
						...baseLocation(ctx),
						fieldUuid: issue.writers[1]?.fieldUuid,
						fieldId: issue.writers[1]?.fieldId,
					},
					{
						caseType: issue.bucket.caseType,
						property: issue.property,
						fieldIds: fieldIds.join(","),
						...(issue.bucket.repeatId
							? { repeatId: issue.bucket.repeatId }
							: {}),
					},
				),
			);
			continue;
		}
		const duplicate = issue.kind === "create-name-duplicate";
		const names = duplicate ? issue.writers : [];
		errors.push(
			validationError(
				duplicate ? "CASE_CREATE_NAME_DUPLICATE" : "CASE_CREATE_NAME_MISSING",
				"form",
				duplicate
					? `"${ctx.formName}" creates ${bucketScope(issue.bucket)}, but ${names.length} fields (${names.map((writer) => `"${writer.fieldId}"`).join(", ")}) write its "case_name". Every case-create action needs exactly one name writer. Keep one destination and change or clear the others.`
					: `"${ctx.formName}" creates ${bucketScope(issue.bucket)}, but no field writes its "case_name". Every case-create action needs exactly one name writer. Set one field's case destination to type "${issue.bucket.caseType}", property "case_name".`,
				{
					...baseLocation(ctx),
					fieldUuid: names[1]?.fieldUuid,
					fieldId: names[1]?.fieldId,
				},
				{
					caseType: issue.bucket.caseType,
					writerCount: String(names.length),
					...(issue.bucket.repeatId ? { repeatId: issue.bucket.repeatId } : {}),
				},
			),
		);
	}

	return errors;
}
