/**
 * Absolute multi-select soundness rules.
 *
 * A multi-select entry supplies an ordered collection of case ids. Ordinary
 * primary-case destinations and submission effects explicitly scoped to the
 * loaded session case are evaluated once per member of that collection.
 * Everything else in the form remains singular. These rules keep a shared
 * selected-case read from silently choosing one member of the collection.
 */

import { possibleFinalSessionCaseTypes } from "@/lib/doc/caseOperationOrder";
import {
	type BlueprintDoc,
	CASE_LOADING_FORM_TYPES,
	caseOperationRunsPerSelectedCase,
	caseSelectionCanFlowBetweenModules,
	caseSelectionCardinality,
	caseSelectionMaximum,
	type Form,
	fieldReferenceSlotsFor,
	formLinkSelectionIsCompatible,
	type Module,
	moduleIsBareCaseList,
	readSlotValues,
	type Uuid,
} from "@/lib/domain";
import { activeRowScope, slotContext } from "@/lib/domain/expression/context";
import { expressionContextAtPath } from "@/lib/domain/expression/typeChecker";
import {
	datumRefKey,
	type Expression,
	type ExpressionSlotRef,
} from "@/lib/domain/expression/types";
import { walkExpression } from "@/lib/domain/expression/walk";
import { expressionSlotValues } from "@/lib/domain/referenceSlots";
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
		moduleIsBareCaseList(doc, moduleUuid) &&
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

/** Only a read of the selected scalar case is ambiguous. Independent casedb
 * collections, explicit selected-case sets and their row-local reads stay distinct. */
function expressionReadsSelectedCase(
	doc: BlueprintDoc,
	slot: ExpressionSlotRef,
	expression: Expression,
): boolean {
	const context = slotContext(doc, slot, new Map());
	if (context === undefined) return false;
	const root = activeRowScope(context);
	let found = false;
	walkExpression(expression, {
		visitTerm(term, path) {
			if (term.kind === "form-case") {
				found = true;
				return;
			}
			if (
				term.kind === "session-datum" &&
				term.datum.kind === "selected-case"
			) {
				const key = datumRefKey(term.datum);
				if (
					context.supplies.refs.some(
						(supply) => datumRefKey(supply.ref) === key && !supply.scalar,
					)
				)
					found = true;
				return;
			}
			if (
				root?.kind !== "case" ||
				![
					"prop",
					"owner-location-at-level",
					"case-row-type",
					"case-index",
				].includes(term.kind)
			)
				return;
			if (
				activeRowScope(expressionContextAtPath(expression, context, path)) ===
				root
			)
				found = true;
		},
		visitRelation(_relation, path) {
			if (
				root?.kind === "case" &&
				activeRowScope(expressionContextAtPath(expression, context, path)) ===
					root
			)
				found = true;
		},
	});
	return found;
}

/**
 * Reject shared case-reading surfaces and unsafe operation shapes on one batch
 * form.
 */
export function multiSelectFormSemantics(
	doc: BlueprintDoc,
	form: Form,
	module: Module,
	ctx: MultiSelectFormContext,
): ValidationError[] {
	if (!isMultiple(module) || !isBatchConsumer(form)) return [];

	const errors: ValidationError[] = [];
	const loc = formLocation(ctx);
	const operations = form.caseOperations ?? [];
	let enteredSelectedCaseScope = false;
	for (const operation of operations) {
		// The form's own case runs once per selected case wherever its block
		// stands (its effects are independent of every other operation's), so
		// it opens no selected-case scope the operations after it must follow.
		if (operation.action === "own") continue;
		const perSelectedCase = caseOperationRunsPerSelectedCase(operation);
		if (enteredSelectedCaseScope && !perSelectedCase) {
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
		enteredSelectedCaseScope ||= perSelectedCase;

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

		// A link to the loaded case names the current selected case wherever
		// its operation runs once per selected case (a create so linked is
		// made once under each). An operation that runs once for the form has
		// no one selected case to name.
		if (perSelectedCase) continue;
		for (const link of operation.links ?? []) {
			if (link.target?.kind !== "session") continue;
			errors.push(
				validationError(
					"MULTI_SELECT_SESSION_OPERATION_LINK",
					"form",
					`Case operation "${operation.id}" runs once for the form but links to "the selected case", and this form has a set of selected cases. Point the link at one explicit operation or expression target, or make the operation work on the selected case.`,
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
			const surfaces: string[] = [];
			for (const slot of fieldReferenceSlotsFor(
				field.kind,
				field.kind === "repeat" ? field.repeat_mode : undefined,
			)) {
				if (slot.kind !== "prose") continue;
				if (
					readSlotValues(field, slot.path).some((entry) =>
						referencePartsReadCase(entry.value),
					)
				)
					surfaces.push(slot.slot);
			}
			for (const { ref, expression } of expressionSlotValues(doc, {
				entity: "field",
				uuid: field.uuid,
			})) {
				if (expressionReadsSelectedCase(doc, ref, expression))
					surfaces.push(ref.slot);
			}
			for (const surface of new Set(surfaces))
				errors.push(
					validationError(
						"MULTI_SELECT_SHARED_CASE_EXPRESSION",
						"field",
						`Field "${field.id}" reads the selected case in its ${surface.replaceAll("_", " ")}, but "${form.name}" runs once over a set of selected cases. Move that case-specific logic into a session-targeted case operation, or remove the selected-case reference.`,
						{ ...loc, fieldUuid: field.uuid, fieldId: field.id },
						{ surface },
					),
				);
			walkFields(fieldUuid);
		}
	};
	walkFields(ctx.formUuid);

	for (const { ref, expression } of expressionSlotValues(doc, {
		entity: "form",
		uuid: form.uuid,
	})) {
		if (!expressionReadsSelectedCase(doc, ref, expression)) continue;
		if ("member" in ref && "operationUuid" in ref.member) {
			const operationUuid = ref.member.operationUuid;
			const operation = operations.find(
				(candidate) => candidate.uuid === operationUuid,
			);
			if (
				operation !== undefined &&
				caseOperationRunsPerSelectedCase(operation)
			)
				continue;
			errors.push(
				validationError(
					"MULTI_SELECT_APP_OPERATION_CASE_READ",
					"form",
					`Case operation "${operation?.id ?? "unknown"}" runs once for the form, so its ${ref.slot.replaceAll("_", " ")} cannot read one selected case from a set. Target the loaded session case, or link a new case to it, to run the operation once per selected case, or remove that case read.`,
					loc,
					{
						surface: ref.slot,
						...(operation === undefined
							? {}
							: { operationUuid: operation.uuid, operationId: operation.id }),
					},
				),
			);
			continue;
		}
		errors.push(
			validationError(
				"MULTI_SELECT_SHARED_CASE_EXPRESSION",
				"form",
				`"${form.name}" reads the selected case in its ${ref.slot.replaceAll("_", " ")}, but the form runs once over a set of selected cases. Remove that selected-case reference or move the logic into a session-targeted case operation.`,
				loc,
				{
					surface: ref.slot,
					...("member" in ref && "linkUuid" in ref.member
						? { linkUuid: ref.member.linkUuid }
						: {}),
				},
			),
		);
	}

	return errors;
}

/** Direct form links can carry a selection only when its full shape fits. */
export function formLinkSelectionCardinality(
	doc: BlueprintDoc,
	form: Form,
	module: Module,
	ctx: MultiSelectFormContext,
): ValidationError[] {
	if (!isBatchConsumer(form) || form.formLinks === undefined) return [];

	const sourceCardinality = caseSelectionCardinality(module);
	const sourceMaximum = caseSelectionMaximum(module);
	const finalSessionCaseTypes = possibleFinalSessionCaseTypes(
		doc,
		ctx.formUuid,
	);
	const errors: ValidationError[] = [];
	const loc = formLocation(ctx);
	for (const link of form.formLinks) {
		if (link.target.type !== "form") continue;
		const targetModule = doc.modules[link.target.moduleUuid];
		const targetForm = doc.forms[link.target.formUuid];
		if (targetModule === undefined || !isBatchConsumer(targetForm)) continue;
		const targetCardinality = caseSelectionCardinality(targetModule);
		const targetMaximum = caseSelectionMaximum(targetModule);
		const compatible = formLinkSelectionIsCompatible({
			sourceModule: module,
			targetModule,
			sourceLoadsCase: true,
			targetLoadsCase: true,
			hasAuthoredDatums: link.datums !== undefined,
		});
		if (compatible) {
			const expectedCaseType = targetModule.caseType;
			const incompatibleFinalCaseTypes = [...finalSessionCaseTypes].filter(
				(caseType) => caseType !== expectedCaseType,
			);
			if (
				sourceCardinality === "multiple" &&
				expectedCaseType !== undefined &&
				incompatibleFinalCaseTypes.length > 0
			) {
				errors.push(
					validationError(
						"FORM_LINK_SELECTION_CASE_TYPE_CHANGED",
						"form",
						`"${form.name}" can change selected cases to ${incompatibleFinalCaseTypes.map((caseType) => `"${caseType}"`).join(" or ")} before linking to "${targetForm.name}", which opens only "${expectedCaseType}" cases. Link to the destination module so the next cases can be chosen there, or keep every selected case as "${expectedCaseType}".`,
						loc,
						{
							linkUuid: link.uuid,
							expectedCaseType,
							possibleFinalCaseTypes: [...finalSessionCaseTypes].join(", "),
						},
					),
				);
			}
			continue;
		}

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
