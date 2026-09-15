import { z } from "zod";
import type { ModuleHandleBinding } from "@/lib/agent/build/acceptedModulePlacement";
import {
	blueprintFormHandle,
	blueprintInputHandle,
	blueprintModuleHandle,
	formCompositionInputs,
	type SliceExecutionBrief,
} from "@/lib/agent/build/executionBrief";
import { findContainingForm } from "@/lib/doc/mutations/helpers";
import {
	type BlueprintDoc,
	caseDataTypeForFieldKind,
	effectiveCaseTypes,
	effectiveDataType,
	isCaptureFieldKind,
	moduleUuidOfForm,
} from "@/lib/domain";
import { deriveCaseWriteInventory } from "@/lib/domain/caseWriteInventory";
import { type FactDataShape, factDataShapeCarriers } from "./contract";
import { designIdSchema } from "./ids";
import {
	type ImplementationCoordinate,
	implementationCoordinateSchema,
} from "./projection/coordinates";

export const CONFORMANCE_RULE_VERSION = 1;

export const conformanceFindingSchema = z
	.object({
		code: z.enum([
			"WORKFLOW_FORM_MISSING",
			"WORKFLOW_FORM_HOST_MISMATCH",
			"WORKFLOW_INPUT_MISSING",
			"WORKFLOW_INPUT_TYPE_MISMATCH",
			"RECORD_PROPERTY_TYPE_MISMATCH",
			"RECORD_EFFECT_MISSING",
			"RECORD_WRITE_MISSING",
		]),
		severity: z.literal("critical"),
		workflowId: designIdSchema,
		formCompositionId: designIdSchema,
		message: z.string().min(1),
		coordinates: z.array(implementationCoordinateSchema),
	})
	.strict();
export type ConformanceFinding = z.infer<typeof conformanceFindingSchema>;

/** These rules prove absence or incompatible structure. A matching structure
 * does not prove a condition's meaning, an expression's value, reachability,
 * access policy, or a usable workflow. Completion requires those later checks. */
export function assessAcceptedWorkflow(args: {
	doc: BlueprintDoc;
	brief: SliceExecutionBrief;
	bindings: readonly ModuleHandleBinding[];
}): ConformanceFinding[] {
	const { doc, brief } = args;
	const bindings = new Map<string, ModuleHandleBinding>();
	for (const binding of args.bindings) {
		const prior = bindings.get(binding.handle);
		if (
			prior &&
			(prior.uuid !== binding.uuid || prior.entityKind !== binding.entityKind)
		)
			throw new Error(`Conflicting implementation binding ${binding.handle}.`);
		bindings.set(binding.handle, binding);
	}
	function bound(handle: string, kind: string): string | undefined {
		const binding = bindings.get(handle);
		return binding?.entityKind === kind ? binding.uuid : undefined;
	}
	const propertyById = new Map(
		brief.records.flatMap((record) => {
			const caseType = brief.recordRealizations.find(
				(item) => item.recordId === record.id,
			)?.blueprintCaseType;
			return record.properties.map(
				(property) => [property.id, { ...property, caseType }] as const,
			);
		}),
	);
	const catalog = effectiveCaseTypes(doc);
	const findings: ConformanceFinding[] = [];
	for (const realization of brief.formRealizations) {
		function finding(
			code: ConformanceFinding["code"],
			message: string,
			coordinates: ImplementationCoordinate[] = [],
		) {
			findings.push({
				code,
				severity: "critical",
				workflowId: brief.workflow.id,
				formCompositionId: realization.compositionId,
				message,
				coordinates,
			});
		}
		const formId = bound(
			blueprintFormHandle(realization.compositionId),
			"form",
		);
		const form = formId === undefined ? undefined : doc.forms[formId];
		if (!form) {
			finding(
				"WORKFLOW_FORM_MISSING",
				`${realization.name} has no bound form in the current app.`,
			);
			continue;
		}
		const formCoordinate = { kind: "form", uuid: form.uuid } as const;
		const moduleId = moduleUuidOfForm(doc, form.uuid);
		const expectedModuleId = bound(
			blueprintModuleHandle(realization.moduleCompositionId),
			"module",
		);
		if (moduleId === undefined || moduleId !== expectedModuleId) {
			finding(
				"WORKFLOW_FORM_HOST_MISMATCH",
				`${form.name} is outside its accepted module.`,
				[formCoordinate],
			);
			continue;
		}
		const module = doc.modules[moduleId];
		for (const expected of formCompositionInputs(realization)) {
			const input = brief.workflow.inputs.find(
				(item) => item.handle === expected.inputHandle,
			);
			if (!input)
				throw new Error(
					`Accepted composition has no input ${expected.inputHandle}.`,
				);
			const fieldId = bound(
				blueprintInputHandle(expected.compositionItemId),
				"field",
			);
			const field = fieldId === undefined ? undefined : doc.fields[fieldId];
			if (!field || findContainingForm(doc, field.uuid) !== form.uuid) {
				finding(
					"WORKFLOW_INPUT_MISSING",
					`${form.name} does not capture ${input.name} at its accepted field identity.`,
					[formCoordinate],
				);
				continue;
			}
			const property =
				input.propertyId === undefined
					? undefined
					: propertyById.get(input.propertyId);
			const shape: FactDataShape | undefined =
				property?.dataShape ?? input.dataShape;
			if (shape === undefined || shape === "unknown")
				throw new Error(
					`Accepted input ${input.handle} has no concrete answer type.`,
				);
			const compatible =
				shape === "attachment"
					? isCaptureFieldKind(field.kind)
					: factDataShapeCarriers[shape].caseDataShapes.some(
							(type) => type === caseDataTypeForFieldKind(field.kind),
						);
			if (!compatible)
				finding(
					"WORKFLOW_INPUT_TYPE_MISMATCH",
					`${input.name} needs ${shape} answers; its field is ${field.kind}.`,
					[{ kind: "field", uuid: field.uuid }],
				);
		}

		const inventory = deriveCaseWriteInventory(
			doc,
			form.uuid,
			module,
			form.type,
		);
		const effects: Array<{
			caseType: string;
			kind: "create" | "update" | "close";
			properties: ReadonlySet<string>;
		}> = inventory.buckets
			.filter(
				(bucket) => bucket.action === "create" || bucket.writers.length > 0,
			)
			.map((bucket) => ({
				caseType: bucket.caseType,
				kind: bucket.action,
				properties: new Set(bucket.writers.map((writer) => writer.property)),
			}));
		if (form.type === "close" && module.caseType)
			effects.push({
				caseType: module.caseType,
				kind: "close",
				properties: new Set(),
			});
		for (const operation of form.caseOperations ?? []) {
			const properties = new Set(
				(operation.writes ?? []).map((write) => write.property),
			);
			if (operation.action === "create" || operation.rename !== undefined)
				properties.add("case_name");
			effects.push({
				caseType: operation.caseType,
				kind: operation.action,
				properties,
			});
			// A stable authored key merges subsequent submissions into the
			// existing record. A generated-ID create cannot supply that update.
			if (
				operation.action === "create" &&
				operation.target.kind === "new" &&
				operation.target.idFrom !== undefined
			)
				effects.push({
					caseType: operation.caseType,
					kind: "update",
					properties,
				});
		}
		for (const expected of brief.workflow.recordEffects) {
			// Link and owner semantics need target-aware comparison. No absence
			// claim is made by this initial action/write inventory.
			if (expected.kind === "link" || expected.kind === "reassign") continue;
			const caseType = brief.recordRealizations.find(
				(item) => item.recordId === expected.recordId,
			)?.blueprintCaseType;
			if (!caseType)
				throw new Error(
					`Accepted effect ${expected.handle} has no record mapping.`,
				);
			// Retyping can carry values written under a different catalog into
			// this record. This inventory does not trace that value flow, so it
			// cannot prove an action or write absent for either affected type.
			if (
				form.caseOperations?.some(
					(operation) =>
						operation.retype !== undefined &&
						(operation.caseType === caseType || operation.retype === caseType),
				)
			)
				continue;
			const candidates = effects.filter(
				(effect) =>
					effect.caseType === caseType &&
					(effect.kind === expected.kind ||
						(expected.kind === "update" &&
							effect.kind === "close" &&
							effect.properties.size > 0)),
			);
			if (candidates.length === 0) {
				finding(
					"RECORD_EFFECT_MISSING",
					`${form.name} has no ${expected.kind} effect for ${caseType}.`,
					[formCoordinate],
				);
				continue;
			}
			for (const write of expected.writes) {
				const property = propertyById.get(write.propertyId);
				if (!property)
					throw new Error(
						`Accepted write has no property ${write.propertyId}.`,
					);
				const coordinate = {
					kind: "case-property",
					caseType,
					property: property.blueprintProperty,
				} as const;
				if (
					// A create followed by an update can implement one accepted
					// effect. Absence is provable across the form; attributing the
					// write to the correct instance needs target-aware review.
					!effects.some(
						(effect) =>
							effect.caseType === caseType &&
							effect.properties.has(property.blueprintProperty),
					)
				)
					finding(
						"RECORD_WRITE_MISSING",
						`${form.name} has no write to ${caseType}.${property.blueprintProperty} (${property.name}).`,
						[formCoordinate, coordinate],
					);
				const actualProperty = catalog
					.find((record) => record.name === caseType)
					?.properties.find((item) => item.name === property.blueprintProperty);
				const shape = property.dataShape;
				if (
					!actualProperty ||
					shape === "unknown" ||
					shape === "attachment" ||
					!factDataShapeCarriers[shape].caseDataShapes.some(
						(type) => type === effectiveDataType(actualProperty),
					)
				)
					finding(
						"RECORD_PROPERTY_TYPE_MISMATCH",
						`${property.name} has no compatible ${shape} property in ${caseType}.`,
						[coordinate],
					);
			}
		}
	}
	return findings;
}
