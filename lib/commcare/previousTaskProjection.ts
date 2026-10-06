/** Native-neutral bridge from the wire owner's exact preceding-task frame. */
import {
	type BlueprintDoc,
	deriveCaseWriteInventory,
	moduleParent,
	moduleUuidOfForm,
	type Uuid,
} from "@/lib/domain";
import { caseWriteAdmissionIssues } from "./caseWriteAdmission";
import { emissionPlan } from "./emissionPlan";
import {
	entryFrameDatums,
	formLinkProjectionContext,
	moduleCaseTypeForActions,
	moduleFrameChildren,
	previousEntryFrameChildren,
	selectedCaseDatumId,
} from "./formLinkProjection";

export interface PreviousTaskSelection {
	readonly moduleUuid: Uuid;
	readonly caseType: string;
	readonly maximum: number;
	readonly cardinality: "one" | "multiple";
	readonly source: "form-records" | "menu-records";
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

/** Private assembly permits creating an empty form before adding its name
 * writer. Such a neighbor participates in the common entry prefix, but has
 * no compilable entry yet. Qualify the read; runtime/export stay strict. */
export function readPreviousTaskProjection(
	doc: BlueprintDoc,
	formUuid: Uuid,
):
	| { readonly kind: "resolved"; readonly projection: PreviousTaskProjection }
	| { readonly kind: "incomplete"; readonly reason: string } {
	doc = emissionPlan(doc).doc;
	let moduleUuid = moduleUuidOfForm(doc, formUuid);
	const visited = new Set<Uuid>();
	while (moduleUuid !== undefined && !visited.has(moduleUuid)) {
		visited.add(moduleUuid);
		const caseType = moduleCaseTypeForActions(doc, moduleUuid);
		for (const uuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[uuid];
			if (
				caseWriteAdmissionIssues(
					deriveCaseWriteInventory(doc, uuid, { caseType }, form.type),
				).some((issue) => issue.kind === "create-name-missing")
			)
				return {
					kind: "incomplete",
					reason:
						"A form in this task's menu path still needs a record name before its next task can be resolved.",
				};
		}
		moduleUuid = moduleParent(doc, moduleUuid) ?? undefined;
	}
	return { kind: "resolved", projection: projectPreviousTask(doc, formUuid) };
}

/** Computed frame values count as present, but are not selected records.
 * The final command and missing selections use owner provenance, never IDs
 * reverse-engineered from a command spelling or a case type. */
export function projectPreviousTask(
	sourceDoc: BlueprintDoc,
	formUuid: Uuid,
): PreviousTaskProjection {
	const doc = emissionPlan(sourceDoc).doc;
	const moduleUuid = moduleUuidOfForm(doc, formUuid);
	if (!moduleUuid || !doc.forms[formUuid])
		throw new Error("The preceding task's form is unavailable.");
	const context = formLinkProjectionContext(doc, { entryMetadataOnly: true });
	const children = previousEntryFrameChildren(
		doc,
		context,
		moduleUuid,
		formUuid,
	);
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
			return [
				{
					moduleUuid: datum.selectionSourceModuleUuid,
					caseType: datum.caseType,
					maximum: datum.maximum ?? 1,
					cardinality: datum.maximum === undefined ? "one" : "multiple",
					source: datum.id === ownSelectionId ? "form-records" : "menu-records",
				},
			];
		},
	);
	const command = [...children]
		.reverse()
		.find((child) => child.type === "command");
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
