/** HQ EndpointsHelper projection. Computed datums remain runtime-owned. */
import {
	type BlueprintDoc,
	type EntryPointTarget,
	isNoMatchesForm,
	type Uuid,
} from "@/lib/domain";
import { emissionPlan } from "./emissionPlan";
import {
	commonPrefixById,
	entryFrameDatums,
	type FormLinkProjectionContext,
	type FrameChild,
	formFrameChildren,
	formLinkProjectionContext,
	moduleFrameChildren,
} from "./formLinkProjection";

export interface EntryPointRequiredSelection {
	readonly moduleUuid: Uuid;
	readonly caseType: string;
	readonly cardinality: "one" | "multiple";
	readonly maximum: number;
	readonly argumentId: string;
}
export interface EntryPointProjection {
	readonly target: EntryPointTarget;
	readonly requiredSelections: readonly EntryPointRequiredSelection[];
	readonly frame: readonly FrameChild[];
}
/** One synchronous projection batch shares lowering and cached form actions.
 * Create a fresh projector for each document read; no cross-mutation cache. */
export function createEntryPointProjector(doc: BlueprintDoc) {
	let prepared:
		| { doc: BlueprintDoc; context: FormLinkProjectionContext }
		| undefined;
	return (target: EntryPointTarget): EntryPointProjection => {
		if (prepared === undefined) {
			const lowered = emissionPlan(doc).doc;
			prepared = { doc: lowered, context: formLinkProjectionContext(lowered) };
		}
		return projectEntryPoint(prepared.doc, target, prepared.context);
	};
}

export function projectEntryPoint(
	doc: BlueprintDoc,
	target: EntryPointTarget,
	ctx?: FormLinkProjectionContext,
): EntryPointProjection {
	if (
		target.kind === "form" &&
		doc.forms[target.formUuid] &&
		isNoMatchesForm(doc.forms[target.formUuid])
	)
		throw new Error(
			"Registration after an empty search cannot be opened through a deep link.",
		);
	if (ctx === undefined) {
		doc = emissionPlan(doc).doc;
		ctx = formLinkProjectionContext(doc);
	}
	const context = ctx;
	const mod = doc.modules[target.moduleUuid];
	if (!mod) throw new Error("The entry point destination is missing.");
	let frame: FrameChild[];
	if (target.kind === "form") {
		if (
			doc.forms[target.formUuid] &&
			isNoMatchesForm(doc.forms[target.formUuid])
		)
			throw new Error(
				"Registration after an empty search cannot be opened through a deep link.",
			);
		if (
			!doc.forms[target.formUuid] ||
			!doc.formOrder[target.moduleUuid]?.includes(target.formUuid)
		)
			throw new Error("The entry point form is missing.");
		frame = formFrameChildren(doc, context, target.moduleUuid, target.formUuid);
	} else {
		const prefix = moduleFrameChildren(doc, context, target.moduleUuid);
		const preceding = new Set(
			prefix.flatMap((c) => (c.type === "datum" ? [c.datum.id] : [])),
		);
		const common = commonPrefixById(
			(context.formOrder[target.moduleUuid] ?? []).map((uuid) =>
				entryFrameDatums(doc, context, target.moduleUuid, uuid),
			),
		);
		frame = [
			...prefix,
			...common
				.filter((d) => !preceding.has(d.id))
				.map((datum) => ({ type: "datum" as const, datum })),
		];
		if (target.kind === "case-list") {
			const last = frame.at(-1);
			if (
				last?.type !== "datum" ||
				!last.datum.requiresSelection ||
				last.datum.query
			)
				throw new Error(
					"This destination opens a module menu. Choose a module entry point.",
				);
			frame = frame.slice(0, -1);
		}
	}
	const requiredSelections = frame.flatMap((child) => {
		if (
			child.type !== "datum" ||
			!child.datum.requiresSelection ||
			child.datum.query
		)
			return [];
		const d = child.datum;
		if (!d.selectionSourceModuleUuid || !d.caseType)
			throw new Error("The entry point has an unresolved case selection.");
		return [
			{
				moduleUuid: d.selectionSourceModuleUuid,
				caseType: d.caseType,
				argumentId: d.id,
				cardinality:
					d.maximum === undefined ? ("one" as const) : ("multiple" as const),
				maximum: d.maximum ?? 1,
			},
		];
	});
	for (const child of frame) {
		if (child.type !== "datum" || !child.datum.query) continue;
		const query = child.datum.query;
		// Current HQ to_stack_datum(is_endpoint=True) binds every scalar query to
		// $case_id, while collections use their next datum's instance identity.
		if (!query.nextDatumIsCollection && query.nextDatumId !== "case_id")
			throw new Error(
				"This nested search cannot bind the required parent case reliably. Choose a destination without an ancestor search.",
			);
		const argumentId = query.nextDatumIsCollection
			? query.nextDatumId
			: "case_id";
		if (!requiredSelections.some((s) => s.argumentId === argumentId))
			throw new Error(
				"This search destination needs an unbound case selection. Choose a form that selects a case.",
			);
	}
	if (
		new Set(requiredSelections.map((s) => s.moduleUuid)).size !==
		requiredSelections.length
	)
		throw new Error(
			"This entry point requires conflicting selections from the same module.",
		);
	return { target, requiredSelections, frame };
}
export function entryPointProjectionIssue(
	doc: BlueprintDoc,
	target: EntryPointTarget,
): string | undefined {
	try {
		projectEntryPoint(doc, target);
		return undefined;
	} catch (error) {
		return error instanceof Error
			? error.message
			: "This entry point cannot be projected.";
	}
}
