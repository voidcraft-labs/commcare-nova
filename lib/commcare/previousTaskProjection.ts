/** Native-neutral bridge from the wire owner's exact preceding-task frame. */
import {
	type BlueprintDoc,
	moduleHasCaseListMenuItem,
	moduleParent,
	moduleUuidOfForm,
	type NavigationReadFinding,
	type Uuid,
} from "@/lib/domain";
import { emissionPlan } from "./emissionPlan";
import {
	commonPrefixById,
	entryFrameDatums,
	type FormLinkProjectionContext,
	type FrameChild,
	type FrameDatum,
	formLinkProjectionContext,
	moduleCaseTypeForActions,
	moduleFrameChildren,
	previousEntryFrameChildren,
	selectedCaseDatumId,
} from "./formLinkProjection";
import {
	caseCreateNameMissingMessage,
	ownCaseOperationFindings,
} from "./ownCaseOperationFindings";

export interface PreviousTaskSelection {
	readonly moduleUuid: Uuid;
	readonly caseType: string;
	readonly maximum: number;
	readonly cardinality: "one" | "multiple";
	readonly source: "form-records" | "menu-records";
	/** Other selectors that ask for this exact datum after Android returns to Home. */
	readonly alsoSupplies?: readonly Uuid[];
}

export interface PreviousTaskProjection {
	readonly destination:
		| { readonly kind: "home" }
		| { readonly kind: "menu"; readonly moduleUuid: Uuid }
		| {
				readonly kind: "record-selection";
				readonly moduleUuid: Uuid;
				readonly formUuid: Uuid;
				/** Selectors are in the source entry's exact order. */
				readonly selectingModuleUuids: readonly Uuid[];
		  };
	readonly retainedSelections: readonly PreviousTaskSelection[];
}

/** A module destination keeps its projected ancestor selections. Its own
 * command contributes no record slot unless an ancestor entry actually owns
 * one there. Expose those identities without publishing wire names. */
export function projectModuleTaskSelectionUuids(
	sourceDoc: BlueprintDoc,
	moduleUuid: Uuid,
): readonly Uuid[] {
	const doc = emissionPlan(sourceDoc).doc;
	if (!doc.modules[moduleUuid])
		throw new Error("The next task's menu is unavailable.");
	return moduleFrameChildren(
		doc,
		formLinkProjectionContext(doc, { entryMetadataOnly: true }),
		moduleUuid,
	).flatMap((child) => {
		if (
			child.type !== "datum" ||
			!child.datum.requiresSelection ||
			child.datum.query
		)
			return [];
		if (!child.datum.selectionSourceModuleUuid)
			throw new Error("The next task's record selection is unavailable.");
		return [child.datum.selectionSourceModuleUuid];
	});
}

/** A command chosen on its menu starts its actual entry selection sequence.
 * External frames can prepend structural prerequisites that this entry does
 * not select; those remain the separate entry-point projection's contract. */
export function projectTaskFormSelections(
	sourceDoc: BlueprintDoc,
	formUuid: Uuid,
): readonly Omit<PreviousTaskSelection, "source">[] {
	const doc = emissionPlan(sourceDoc).doc;
	const moduleUuid = moduleUuidOfForm(doc, formUuid);
	if (!moduleUuid) throw new Error("The next task's form is unavailable.");
	return entryFrameDatums(
		doc,
		formLinkProjectionContext(doc, { entryMetadataOnly: true }),
		moduleUuid,
		formUuid,
	).flatMap((datum) => {
		if (!datum.requiresSelection || datum.query) return [];
		if (!datum.selectionSourceModuleUuid || !datum.caseType)
			throw new Error("The next task's record selection is unavailable.");
		return [
			{
				moduleUuid: datum.selectionSourceModuleUuid,
				caseType: datum.caseType,
				maximum: datum.maximum ?? 1,
				cardinality:
					datum.maximum === undefined
						? ("one" as const)
						: ("multiple" as const),
			},
		];
	});
}

/** Private forms can lack a buildable own case while their author repairs
 * them. Every neighboring form contributes to the common entry prefix, so
 * qualify the same menu path before lowering it. Runtime/export stay strict. */
export function readPreviousTaskProjection(
	doc: BlueprintDoc,
	formUuid: Uuid,
):
	| { readonly kind: "resolved"; readonly projection: PreviousTaskProjection }
	| {
			readonly kind: "incomplete";
			readonly reason: string;
			readonly findings: readonly NavigationReadFinding[];
	  } {
	doc = emissionPlan(doc).doc;
	const findings: NavigationReadFinding[] = [];
	let moduleUuid = moduleUuidOfForm(doc, formUuid);
	const visited = new Set<Uuid>();
	while (moduleUuid !== undefined && !visited.has(moduleUuid)) {
		visited.add(moduleUuid);
		const caseType = moduleCaseTypeForActions(doc, moduleUuid);
		for (const uuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[uuid];
			for (const issue of ownCaseOperationFindings({
				form,
				formUuid: uuid,
				moduleUuid,
				moduleName: doc.modules[moduleUuid].name,
				caseType,
			})) {
				findings.push({
					code: issue.code,
					message: issue.message,
					moduleUuid,
					formUuid: uuid,
					...(issue.location.fieldUuid && {
						fieldUuid: issue.location.fieldUuid,
					}),
				});
			}
			// A registration's case actions name the case it creates.
			if (
				form.type === "registration" &&
				caseType !== "" &&
				form.caseOperations?.find((operation) => operation.action === "own")
					?.name === undefined
			)
				findings.push({
					code: "CASE_CREATE_NAME_MISSING",
					message: caseCreateNameMissingMessage(form.name),
					moduleUuid,
					formUuid: uuid,
				});
		}
		moduleUuid = moduleParent(doc, moduleUuid) ?? undefined;
	}
	if (findings.length > 0)
		return { kind: "incomplete", reason: findings[0].message, findings };
	return { kind: "resolved", projection: projectPreviousTask(doc, formUuid) };
}

/** The submitting entry's preceding frame before matching, with the context
 * it was built under, so a reader lands it as every frame lands
 * (Preview's `screenOfFrame`). */
export function previousTaskFrame(
	sourceDoc: BlueprintDoc,
	formUuid: Uuid,
): {
	readonly context: FormLinkProjectionContext;
	readonly children: readonly FrameChild[];
} {
	const doc = emissionPlan(sourceDoc).doc;
	const moduleUuid = moduleUuidOfForm(doc, formUuid);
	if (!moduleUuid || !doc.forms[formUuid])
		throw new Error("The preceding task's form is unavailable.");
	const context = formLinkProjectionContext(doc, { entryMetadataOnly: true });
	return {
		context,
		children: previousEntryFrameChildren(doc, context, moduleUuid, formUuid),
	};
}

const formChoicesById = new WeakMap<
	FormLinkProjectionContext,
	Map<string, FrameDatum[]>
>();

function choicesWithId(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
): ReadonlyMap<string, FrameDatum[]> {
	const cached = formChoicesById.get(ctx);
	if (cached) return cached;
	const choices = new Map<string, FrameDatum[]>();
	for (const menu of ctx.moduleOrder) {
		const entries: (Uuid | undefined)[] = [...(ctx.formOrder[menu] ?? [])];
		if (moduleHasCaseListMenuItem(doc.modules[menu])) entries.push(undefined);
		for (const form of entries) {
			for (const datum of entryFrameDatums(doc, ctx, menu, form)) {
				if (
					!datum.requiresSelection ||
					datum.query ||
					!datum.selectionSourceModuleUuid
				)
					continue;
				const list = choices.get(datum.id);
				if (list) list.push(datum);
				else choices.set(datum.id, [datum]);
			}
		}
	}
	formChoicesById.set(ctx, choices);
	return choices;
}

interface HomeSelectionConsumers {
	readonly modules: ReadonlySet<Uuid>;
	readonly destinationModules: ReadonlySet<Uuid>;
	readonly conflict: boolean;
	readonly destinationConflict: boolean;
}

/** Android keeps the physical selections before the first command across
 * Back to Home. Web Apps rebuilds only the chosen destination. A datum
 * shared with a different case type or multiplicity cannot be carried. */
export function homeSelectionConsumers(
	doc: BlueprintDoc,
	context: FormLinkProjectionContext,
	children: readonly FrameChild[],
): ReadonlyMap<FrameDatum, HomeSelectionConsumers> {
	const consumers = new Map<FrameDatum, HomeSelectionConsumers>();
	const targetCommand = children.findLast((child) => child.type === "command");
	const target = targetCommand && context.commandTargets.get(targetCommand);
	let destination: readonly FrameDatum[] | undefined;
	for (const child of children) {
		if (child.type === "command") break;
		const root = child.datum;
		if (!root.requiresSelection || root.query) continue;
		destination ??= !target
			? []
			: target.formUuid !== undefined
				? entryFrameDatums(doc, context, target.moduleUuid, target.formUuid)
				: commonPrefixById(
						(context.formOrder[target.moduleUuid] ?? []).map((form) =>
							entryFrameDatums(doc, context, target.moduleUuid, form),
						),
					);
		const owners = (choices: readonly FrameDatum[]) => {
			const modules = new Set<Uuid>();
			let conflict = false;
			for (const choice of choices) {
				if (!choice.requiresSelection || choice.query || choice.id !== root.id)
					continue;
				if (
					choice.caseType !== root.caseType ||
					choice.maximum !== root.maximum
				)
					conflict = true;
				else if (
					choice.selectionSourceModuleUuid &&
					choice.selectionSourceModuleUuid !== root.selectionSourceModuleUuid
				)
					modules.add(choice.selectionSourceModuleUuid);
			}
			return { modules, conflict };
		};
		const reached = owners(destination);
		consumers.set(root, {
			...owners(choicesWithId(doc, context).get(root.id) ?? []),
			destinationModules: reached.modules,
			destinationConflict: reached.conflict,
		});
	}
	return consumers;
}

/** Computed frame values count as present, but are not selected records.
 * The final command and missing selections use owner provenance, never IDs
 * reverse-engineered from a command spelling or a case type. */
export function projectPreviousTask(
	sourceDoc: BlueprintDoc,
	formUuid: Uuid,
): PreviousTaskProjection {
	const { context, children } = previousTaskFrame(sourceDoc, formUuid);
	const doc = context.expressionDoc;
	const moduleUuid = moduleUuidOfForm(doc, formUuid);
	if (!moduleUuid) throw new Error("The preceding task's form is unavailable.");
	const ownSelectionId = selectedCaseDatumId(
		doc,
		context,
		moduleUuid,
		formUuid,
	);
	const present = new Set(
		children.flatMap((child) =>
			child.type === "datum" ? [child.datum.id] : [],
		),
	);
	const command = [...children]
		.reverse()
		.find((child) => child.type === "command");
	const homeConsumers = command
		? undefined
		: homeSelectionConsumers(doc, context, children);
	const retainedSelections = children.flatMap(
		(child): PreviousTaskSelection[] => {
			if (
				child.type !== "datum" ||
				!child.datum.requiresSelection ||
				child.datum.query
			)
				return [];
			const datum = child.datum;
			if (!datum.selectionSourceModuleUuid || !datum.caseType)
				throw new Error(
					"The preceding task's record selection is unavailable.",
				);
			const alsoSupplies = [...(homeConsumers?.get(datum)?.modules ?? [])];
			return [
				{
					moduleUuid: datum.selectionSourceModuleUuid,
					caseType: datum.caseType,
					maximum: datum.maximum ?? 1,
					cardinality: datum.maximum === undefined ? "one" : "multiple",
					source: datum.id === ownSelectionId ? "form-records" : "menu-records",
					...(alsoSupplies.length > 0 && { alsoSupplies }),
				},
			];
		},
	);
	if (!command) return { destination: { kind: "home" }, retainedSelections };
	const target = context.commandTargets.get(command);
	if (!target)
		throw new Error("The preceding task's destination is unavailable.");
	if (!target.formUuid)
		return {
			destination: { kind: "menu", moduleUuid: target.moduleUuid },
			retainedSelections,
		};
	const selectingModuleUuids = entryFrameDatums(
		doc,
		context,
		target.moduleUuid,
		target.formUuid,
	).flatMap((datum) => {
		if (!datum.requiresSelection || datum.query || present.has(datum.id))
			return [];
		if (!datum.selectionSourceModuleUuid)
			throw new Error("The preceding task's record selector is unavailable.");
		return [datum.selectionSourceModuleUuid];
	});
	if (selectingModuleUuids.length === 0)
		throw new Error("The preceding task has no record selector to reopen.");
	return {
		destination: {
			kind: "record-selection",
			moduleUuid: target.moduleUuid,
			formUuid: target.formUuid,
			selectingModuleUuids,
		},
		retainedSelections,
	};
}
