/**
 * Absolute multi-select soundness rules.
 *
 * A multi-select entry supplies an ordered collection of case ids. Only
 * submission effects explicitly scoped to the loaded session case are
 * evaluated once per member of that collection. Everything else in the form
 * remains singular. These rules keep a scalar selected-case read or write from
 * silently choosing one member of the collection.
 */

import {
	type BlueprintDoc,
	CASE_LOADING_FORM_TYPES,
	type CaseWriteInventory,
	caseSelectionCanFlowBetweenModules,
	caseSelectionCardinality,
	caseSelectionMaximum,
	FORM_REFERENCE_SLOTS,
	type Form,
	fieldReferenceSlotsFor,
	formLinkSelectionIsCompatible,
	type Module,
	readSlotValues,
	type Uuid,
} from "@/lib/domain";
import {
	expressionReadsCaseData,
	type ValueExpression,
} from "@/lib/domain/predicate";
import {
	entryFrameDatums,
	entrySessionDatums,
	formLinkActionsBuildable,
	formLinkProjectionContext,
	formLinksProjectable,
	projectFormLinkSessionExpression,
} from "../../formLinkProjection";
import { sessionDataAccessInXPath } from "../bindingResolutionOracle";
import type { ValidationError } from "../errors";
import { validationError } from "../errors";

interface MultiSelectFormContext {
	readonly moduleUuid: Uuid;
	readonly moduleName: string;
	readonly formUuid: Uuid;
	readonly formName: string;
}

function formLocation(ctx: MultiSelectFormContext) {
	return {
		moduleUuid: ctx.moduleUuid,
		moduleName: ctx.moduleName,
		formUuid: ctx.formUuid,
		formName: ctx.formName,
	};
}

function isMultiple(module: Module | undefined): boolean {
	return module?.caseListConfig?.selection?.kind === "multiple";
}

function isBatchConsumer(form: Form | undefined): boolean {
	return form !== undefined && CASE_LOADING_FORM_TYPES.has(form.type);
}

function fannedChildCaseTypes(
	inventory: CaseWriteInventory,
): ReadonlySet<string> {
	return new Set(
		inventory.buckets.flatMap((bucket) =>
			bucket.kind === "child" && bucket.repeatUuid === undefined
				? [bucket.caseType]
				: [],
		),
	);
}

/** Refuse the exact scalar child datums HQ allocates for a multi-parent
 * fanout whenever an authored link expression tries to observe one. */
function fanoutChildDatumExpressionConsumers(
	doc: BlueprintDoc,
	form: Form,
	ctx: MultiSelectFormContext,
	inventory: CaseWriteInventory,
): ValidationError[] {
	const childTypes = fannedChildCaseTypes(inventory);
	const links = form.formLinks;
	if (
		childTypes.size === 0 ||
		links === undefined ||
		!formLinksProjectable(doc, links) ||
		!formLinkActionsBuildable(doc, ctx.formUuid, links)
	) {
		return [];
	}

	const projectionContext = formLinkProjectionContext(doc);
	const sessionDatums = entrySessionDatums(
		doc,
		projectionContext,
		ctx.moduleUuid,
		ctx.formUuid,
	);
	const scalarChildDatumIds = new Set(
		sessionDatums.flatMap((datum) =>
			datum.function === "uuid()" &&
			datum.caseType !== undefined &&
			childTypes.has(datum.caseType)
				? [datum.id]
				: [],
		),
	);
	if (scalarChildDatumIds.size === 0) return [];

	const sourceDatums = entryFrameDatums(
		doc,
		projectionContext,
		ctx.moduleUuid,
		ctx.formUuid,
	);
	const errors: ValidationError[] = [];
	const flag = (
		linkUuid: Uuid,
		surface: "condition" | "carried value",
		expression: Parameters<typeof projectFormLinkSessionExpression>[4],
	): void => {
		const projected = projectFormLinkSessionExpression(
			doc,
			ctx.moduleUuid,
			form.type,
			sourceDatums,
			expression,
		);
		const access = sessionDataAccessInXPath(projected);
		const datumId = [...access.exactDatumIds].find((id) =>
			scalarChildDatumIds.has(id),
		);
		if (datumId === undefined && !access.broad) return;
		errors.push(
			validationError(
				"MULTI_SELECT_FANOUT_CHILD_DATUM",
				"form",
				access.broad
					? `"${form.name}" reads the complete session data in a form-link ${surface}. That data includes one unused child id even though this form creates a separate child for every selected parent, so Nova and CommCare would evaluate the expression differently. Read one specific, unrelated session value instead.`
					: `"${form.name}" reads one generated child case in a form-link ${surface}, but this form creates a separate child for every selected parent. There is no single child value to read. Remove that child-case reference from the link.`,
				formLocation(ctx),
				{
					linkUuid,
					surface,
					access: access.broad ? "broad" : "exact",
					...(datumId !== undefined && { datumId }),
				},
			),
		);
	};

	for (const link of links) {
		if (link.condition !== undefined) {
			flag(link.uuid, "condition", link.condition);
		}
		for (const datum of link.datums ?? []) {
			flag(link.uuid, "carried value", datum.xpath);
		}
	}
	return errors;
}

/** A multiple-selection list must lead to at least one form that consumes it. */
export function multiSelectTopology(
	module: Module,
	moduleUuid: Uuid,
	doc: BlueprintDoc,
): ValidationError[] {
	if (!isMultiple(module)) return [];

	const errors: ValidationError[] = [];
	if (module.caseListConfig?.tile?.persistOnForms === true) {
		errors.push(
			validationError(
				"MULTI_SELECT_PERSISTENT_TILE",
				"module",
				`Module "${module.name}" lets people choose several cases, but its case tile is also set to stay above forms. That form header can show only one selected case. Turn off "Keep tile visible on forms" before enabling multiple selection.`,
				{ moduleUuid, moduleName: module.name },
			),
		);
	}

	const ownConsumer = (doc.formOrder[moduleUuid] ?? []).some((formUuid) =>
		isBatchConsumer(doc.forms[formUuid]),
	);
	const compatibleChildConsumer =
		module.caseListOnly === true &&
		doc.moduleOrder.some((childUuid) => {
			const child = doc.modules[childUuid];
			if (
				child?.parentModuleUuid !== moduleUuid ||
				!caseSelectionCanFlowBetweenModules(module, child)
			) {
				return false;
			}
			return (doc.formOrder[childUuid] ?? []).some((formUuid) =>
				isBatchConsumer(doc.forms[formUuid]),
			);
		});
	if (!ownConsumer && !compatibleChildConsumer) {
		errors.push(
			validationError(
				"MULTI_SELECT_NO_BATCH_CONSUMER",
				"module",
				`Module "${module.name}" lets people choose several cases but has no follow-up or close form that can use the complete selection, and no compatible child workflow can receive it. Add a follow-up or close form, carry the same case selection into a child that has one, or return this module to one-case selection.`,
				{ moduleUuid, moduleName: module.name },
			),
		);
	}

	return errors;
}

function referencePartsReadCase(value: unknown): boolean {
	if (
		typeof value !== "object" ||
		value === null ||
		!("parts" in value) ||
		!Array.isArray(value.parts)
	) {
		return false;
	}
	return value.parts.some(
		(part) =>
			typeof part === "object" &&
			part !== null &&
			"kind" in part &&
			part.kind === "case-ref",
	);
}

function predicateAstReadsCase(value: unknown): boolean {
	if (typeof value !== "object" || value === null || !("kind" in value)) {
		return false;
	}
	return expressionReadsCaseData(value as ValueExpression);
}

function expressionSurfaceReadsCase(
	kind: "xpath-ast" | "prose" | "predicate-ast",
	value: unknown,
): boolean {
	return kind === "predicate-ast"
		? predicateAstReadsCase(value)
		: referencePartsReadCase(value);
}

/**
 * Reject singular form surfaces and unsafe operation shapes on one batch form.
 */
export function multiSelectFormSemantics(
	doc: BlueprintDoc,
	form: Form,
	module: Module,
	ctx: MultiSelectFormContext,
	inventory: CaseWriteInventory,
): ValidationError[] {
	if (!isMultiple(module) || !isBatchConsumer(form)) return [];

	const errors: ValidationError[] = [];
	const loc = formLocation(ctx);
	const primary = inventory.buckets.find((bucket) => bucket.kind === "primary");
	for (const writer of primary?.writers ?? []) {
		errors.push(
			validationError(
				"MULTI_SELECT_PRIMARY_CASE_WRITE",
				"field",
				`Field "${writer.fieldId}" in "${form.name}" saves to the selected ${writer.caseType} case, but this form runs over several selected cases. One shared answer cannot be preloaded from or saved to the complete selection. Remove this case-data binding or use an explicit session-targeted case operation.`,
				{
					...loc,
					fieldUuid: writer.fieldUuid,
					fieldId: writer.fieldId,
				},
				{ caseType: writer.caseType, property: writer.property },
			),
		);
	}

	const operations = form.caseOperations ?? [];
	let enteredSelectedCaseScope = false;
	for (const operation of operations) {
		const sessionTargeted = operation.target.kind === "session";
		if (enteredSelectedCaseScope && !sessionTargeted) {
			errors.push(
				validationError(
					"MULTI_SELECT_OPERATION_ORDER",
					"form",
					`Case operation "${operation.id}" runs once for the form but comes after an operation that runs once per selected case. Move form-level operations before selected-case operations so CommCare can preserve the authored order.`,
					loc,
					{ operationUuid: operation.uuid, operationId: operation.id },
				),
			);
		}
		enteredSelectedCaseScope ||= sessionTargeted;

		if (
			operation.action === "create" &&
			operation.target.kind === "new" &&
			operation.target.idFrom !== undefined
		) {
			errors.push(
				validationError(
					"MULTI_SELECT_AUTHORED_KEY_CREATE",
					"form",
					`Create operation "${operation.id}" derives its case id from one shared form answer. On a form that runs over several selected cases, that would reuse the same derived id across the selected-case execution. Use a generated case id instead.`,
					loc,
					{ operationUuid: operation.uuid, operationId: operation.id },
				),
			);
		}

		for (const link of operation.links ?? []) {
			if (link.target?.kind !== "session") continue;
			errors.push(
				validationError(
					"MULTI_SELECT_SESSION_OPERATION_LINK",
					"form",
					`Case operation "${operation.id}" links to "the selected case", but this form has a set of selected cases. Point the link at one explicit operation or expression target instead.`,
					loc,
					{
						operationUuid: operation.uuid,
						operationId: operation.id,
						linkIdentifier: link.identifier,
					},
				),
			);
		}
	}

	const walkFields = (parentUuid: Uuid): void => {
		for (const fieldUuid of doc.fieldOrder[parentUuid] ?? []) {
			const field = doc.fields[fieldUuid];
			if (field === undefined) continue;
			for (const slot of fieldReferenceSlotsFor(
				field.kind,
				field.kind === "repeat" ? field.repeat_mode : undefined,
			)) {
				if (
					slot.kind !== "xpath-ast" &&
					slot.kind !== "prose" &&
					slot.kind !== "predicate-ast"
				) {
					continue;
				}
				for (const entry of readSlotValues(field, slot.path)) {
					if (!expressionSurfaceReadsCase(slot.kind, entry.value)) continue;
					errors.push(
						validationError(
							"MULTI_SELECT_SHARED_CASE_EXPRESSION",
							"field",
							`Field "${field.id}" reads the selected case in its ${slot.slot.replaceAll("_", " ")}, but "${form.name}" runs once over a set of selected cases. Move that case-specific logic into a session-targeted case operation, or remove the selected-case reference.`,
							{
								...loc,
								fieldUuid: field.uuid,
								fieldId: field.id,
							},
							{ surface: slot.slot },
						),
					);
				}
			}
			walkFields(fieldUuid);
		}
	};
	walkFields(ctx.formUuid);
	errors.push(
		...fanoutChildDatumExpressionConsumers(doc, form, ctx, inventory),
	);

	for (const slot of FORM_REFERENCE_SLOTS) {
		if (slot.kind !== "xpath-ast" && slot.kind !== "predicate-ast") {
			continue;
		}
		for (const entry of readSlotValues(form, slot.path)) {
			if (!expressionSurfaceReadsCase(slot.kind, entry.value)) continue;
			const operationIndex = entry.indices[0];
			if (slot.slot.startsWith("case_operation_")) {
				const operation =
					operationIndex === undefined ? undefined : operations[operationIndex];
				if (operation?.target.kind === "session") continue;
				errors.push(
					validationError(
						"MULTI_SELECT_APP_OPERATION_CASE_READ",
						"form",
						`Case operation "${operation?.id ?? "unknown"}" runs once for the form, so its ${slot.slot.replaceAll("_", " ")} cannot read one selected case from a set. Target the loaded session case to run the operation once per selected case, or remove that case read.`,
						loc,
						{
							surface: slot.slot,
							...(operation !== undefined && {
								operationUuid: operation.uuid,
								operationId: operation.id,
							}),
						},
					),
				);
				continue;
			}
			errors.push(
				validationError(
					"MULTI_SELECT_SHARED_CASE_EXPRESSION",
					"form",
					`"${form.name}" reads the selected case in its ${slot.slot.replaceAll("_", " ")}, but the form runs once over a set of selected cases. Remove that selected-case reference or move the logic into a session-targeted case operation.`,
					loc,
					{ surface: slot.slot },
				),
			);
		}
	}

	return errors;
}

/** Direct form links can carry a selection only when its full shape fits. */
export function formLinkSelectionCardinality(
	doc: BlueprintDoc,
	form: Form,
	module: Module,
	ctx: MultiSelectFormContext,
	inventory: CaseWriteInventory,
): ValidationError[] {
	if (!isBatchConsumer(form) || form.formLinks === undefined) return [];

	const sourceCardinality = caseSelectionCardinality(module);
	const sourceMaximum = caseSelectionMaximum(module);
	const fanoutTypes = fannedChildCaseTypes(inventory);
	const errors: ValidationError[] = [];
	const loc = formLocation(ctx);
	for (const link of form.formLinks) {
		if (link.target.type !== "form") continue;
		const targetModule = doc.modules[link.target.moduleUuid];
		const targetForm = doc.forms[link.target.formUuid];
		if (targetModule === undefined || !isBatchConsumer(targetForm)) continue;
		if (
			targetModule.caseType !== undefined &&
			fanoutTypes.has(targetModule.caseType)
		) {
			errors.push(
				validationError(
					"MULTI_SELECT_FANOUT_CHILD_DATUM",
					"form",
					`"${form.name}" creates one ${targetModule.caseType} case for every selected ${module.caseType ?? "case"}, so there is no single new case to carry directly into "${targetForm.name}". Link to the destination module instead so the next case can be chosen there.`,
					loc,
					{
						linkUuid: link.uuid,
						childCaseType: targetModule.caseType,
					},
				),
			);
			continue;
		}

		const targetCardinality = caseSelectionCardinality(targetModule);
		const targetMaximum = caseSelectionMaximum(targetModule);
		const compatible = formLinkSelectionIsCompatible({
			sourceModule: module,
			targetModule,
			sourceLoadsCase: true,
			targetLoadsCase: true,
			hasAuthoredDatums: link.datums !== undefined,
		});
		if (compatible) continue;

		errors.push(
			validationError(
				"FORM_LINK_SELECTION_CARDINALITY",
				"form",
				`"${form.name}" links directly to "${targetForm.name}", but the destination cannot receive the complete case selection. Direct form links need the same case type and selection mode, and a multiple-selection destination needs a limit of at least ${sourceMaximum}. Link to the destination module instead so the person can make a new selection.`,
				loc,
				{
					linkUuid: link.uuid,
					sourceCardinality,
					targetCardinality,
					sourceMaximum: String(sourceMaximum),
					targetMaximum: String(targetMaximum),
				},
			),
		);
	}
	return errors;
}
