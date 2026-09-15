import { AuthoringInputError } from "@/lib/agent/authoring/errors";
import type { ChangeSetHandle } from "@/lib/agent/change-set/schemas";
import type { StageHandleAllocation } from "@/lib/agent/change-set/store";
import type { DesignId } from "@/lib/agent/design/ids";
import {
	authoredBlueprintIdentities,
	type BlueprintDoc,
	type Uuid,
	uuidSchema,
} from "@/lib/domain";
import type { ModuleHandleBinding } from "./acceptedModulePlacement";
import {
	blueprintFormHandle,
	blueprintInputHandle,
	formCompositionInputs,
	type SliceExecutionBrief,
} from "./executionBrief";

/** An explicit one-to-one implementation binding. Design identities retain
 * their separate type; only accepted composition entities bind here. */
export interface AcceptedConstructionIdentity {
	readonly compositionId: DesignId;
	readonly kind: "module" | "form" | "field";
	readonly uuid: Uuid;
	/** Internal lineage key, never an authoring argument. */
	readonly bindingKey: ChangeSetHandle;
	readonly exists: boolean;
}

/** Allocate exact composition identities before asking the model to fill in
 * authored content. A verified existing binding wins; new one-to-one entities
 * use their accepted composition's UUID bytes through this explicit binding.
 * Names and positions never identify an existing implementation. */
export function acceptedConstructionIdentities(args: {
	brief: SliceExecutionBrief;
	doc: BlueprintDoc;
	bindings: readonly ModuleHandleBinding[];
}): readonly AcceptedConstructionIdentity[] {
	const { brief, doc, bindings } = args;
	const occupied = new Set(
		authoredBlueprintIdentities(doc).map((item) => item.uuid),
	);
	const planned = new Set<string>();
	const result: AcceptedConstructionIdentity[] = [];
	function bind(
		compositionId: DesignId,
		kind: AcceptedConstructionIdentity["kind"],
		bindingKey: ChangeSetHandle,
	) {
		const existing = bindings.find((item) => item.handle === bindingKey);
		const uuid = uuidSchema.parse(existing?.uuid ?? compositionId);
		if (planned.has(uuid))
			throw new Error(
				`Accepted compositions share implementation identity ${uuid}.`,
			);
		planned.add(uuid);
		if (existing) {
			const entity =
				kind === "module"
					? doc.modules[uuid]
					: kind === "form"
						? doc.forms[uuid]
						: doc.fields[uuid];
			if (existing.entityKind !== kind || !entity)
				throw new Error(
					`The accepted ${kind} binding ${compositionId} no longer identifies that entity.`,
				);
		} else {
			if (occupied.has(uuid))
				throw new Error(
					`The planned ${kind} identity ${uuid} is already occupied without an implementation binding.`,
				);
		}
		result.push({
			compositionId,
			kind,
			uuid,
			bindingKey,
			exists: existing !== undefined,
		});
	}
	for (const module of brief.moduleRealizations)
		bind(module.compositionId, "module", module.blueprintModuleHandle);
	for (const form of brief.formRealizations) {
		bind(form.compositionId, "form", blueprintFormHandle(form.compositionId));
		for (const input of formCompositionInputs(form))
			bind(
				input.compositionItemId,
				"field",
				blueprintInputHandle(input.compositionItemId),
			);
	}
	return result;
}

type Input = Record<string, unknown>;

/** Supply decisions already fixed by the accepted composition. The caller
 * writes the form's content; Nova owns its identity, type, home, and host. */
export function prepareAcceptedConstruction(args: {
	toolName: string;
	input: Input;
	brief: SliceExecutionBrief;
	doc: BlueprintDoc;
	bindings: readonly ModuleHandleBinding[];
}): { input: Input; bindings: readonly StageHandleAllocation[] } {
	const { toolName, brief, doc } = args;
	const input = structuredClone(args.input);
	if (
		toolName !== "createModule" &&
		toolName !== "createForm" &&
		toolName !== "addFields"
	)
		return { input, bindings: [] };
	const identities = acceptedConstructionIdentities(args);
	const bindings: StageHandleAllocation[] = [];
	const declared = new Set<DesignId>();
	const identity = (id: DesignId) => {
		const found = identities.find((item) => item.compositionId === id);
		if (!found) throw new Error(`Missing construction identity ${id}.`);
		return found;
	};
	function declare(id: DesignId) {
		const found = identity(id);
		if (found.exists)
			throw new AuthoringInputError(
				`This ${found.kind} already exists. Edit it instead.`,
			);
		if (declared.has(id))
			throw new AuthoringInputError(
				`This accepted ${found.kind} appears more than once in the request.`,
			);
		declared.add(id);
		bindings.push({
			handle: found.bindingKey,
			uuid: found.uuid,
			entityKind: found.kind,
		});
		return found.uuid;
	}
	function unique<T>(items: readonly T[], noun: string): T {
		if (items.length !== 1)
			throw new AuthoringInputError(
				items.length === 0
					? `No accepted ${noun} matches this request.`
					: `Several accepted ${noun}s have this name. Supply the composition ID to select one.`,
			);
		return items[0];
	}
	function prepareFields(
		form: Input,
		realization?: SliceExecutionBrief["formRealizations"][number],
	) {
		const inputs = realization ? formCompositionInputs(realization) : [];
		for (const field of (form.fields ?? []) as Input[]) {
			const matches = inputs.filter(
				(item) =>
					item.fieldId === field.id ||
					identity(item.compositionItemId).uuid === field.fieldUuid,
			);
			if (matches.length === 0) {
				if (identities.some((item) => item.uuid === field.fieldUuid))
					throw new AuthoringInputError(
						"That identity belongs to another accepted element.",
					);
				continue;
			}
			if (matches.length !== 1)
				throw new AuthoringInputError(
					"The field name and identity refer to different accepted inputs.",
				);
			const accepted = matches[0];
			const expected = identity(accepted.compositionItemId);
			if (field.fieldUuid !== undefined && field.fieldUuid !== expected.uuid)
				throw new AuthoringInputError(
					`Input ${accepted.inputHandle} has a different accepted identity. Omit fieldUuid when creating it.`,
				);
			field.fieldUuid = declare(accepted.compositionItemId);
		}
	}
	function prepareForm(form: Input, moduleId?: DesignId) {
		const realization = unique(
			brief.formRealizations.filter(
				(item) =>
					(moduleId === undefined || item.moduleCompositionId === moduleId) &&
					item.name === form.name &&
					(form.formUuid === undefined ||
						identity(item.compositionId).uuid === form.formUuid),
			),
			"form",
		);
		form.formUuid = declare(realization.compositionId);
		form.type = realization.blueprintFormType;
		prepareFields(form, realization);
		return realization;
	}
	if (toolName === "createModule") {
		const realization = unique(
			brief.moduleRealizations.filter(
				(item) =>
					item.action === "create" &&
					brief.moduleCompositions.some(
						(composition) =>
							composition.id === item.compositionId &&
							composition.name === input.name,
					) &&
					(input.moduleUuid === undefined ||
						identity(item.compositionId).uuid === input.moduleUuid),
			),
			"module",
		);
		input.moduleUuid = declare(realization.compositionId);
		input.case_type = realization.hostRecord?.blueprintCaseType ?? null;
		input.case_list_only =
			realization.role === "queue-only" ||
			(realization.role === "form-and-queue" &&
				realization.formCompositionIds.length === 0);
		input.selection =
			realization.selectionRealization?.action === "create-with-module"
				? realization.selectionRealization.selection
				: null;
		if (realization.parentModuleCompositionId !== null) {
			const parent = identity(realization.parentModuleCompositionId);
			// A parent in this same slice may still need its meaningful first
			// workflow. Finalization enforces placement once both exist.
			if (parent.exists) input.parentModuleUuid = parent.uuid;
		}
		if (
			input.case_list_columns == null &&
			realization.requiredInitialResultsColumn
		)
			input.case_list_columns = [realization.requiredInitialResultsColumn];
		const forms = (input.forms ?? []) as Input[];
		if (realization.role === "queue-only" && forms.length)
			throw new AuthoringInputError(
				"This accepted module contains a case list only.",
			);
		for (const form of forms) prepareForm(form, realization.compositionId);
	} else if (toolName === "createForm") {
		const moduleMatches = brief.moduleRealizations.filter((item) => {
			const implementation = identity(item.compositionId);
			return (
				implementation.exists &&
				(input.moduleUuid === implementation.uuid ||
					doc.modules[implementation.uuid]?.name === input.moduleUuid)
			);
		});
		const module = unique(moduleMatches, "module");
		const form = prepareForm(input, module.compositionId);
		input.moduleUuid = identity(form.moduleCompositionId).uuid;
	} else {
		bindToolAddress(toolName, input, doc);
		const realization = brief.formRealizations.find(
			(item) =>
				identity(item.compositionId).exists &&
				identity(item.compositionId).uuid === input.formUuid,
		);
		prepareFields(input, realization);
	}
	return { input, bindings };
}

import { bindToolAddress } from "@/lib/agent/authoring/addresses";
