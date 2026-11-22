/** HQ EndpointsHelper projection, shared by build, Preview, link creation and read-back. */
import {
	afterEmptySearchRegistrationFormOf,
	type BlueprintDoc,
	type EntryPointTarget,
	listedFormLinkPause,
	type Uuid,
} from "@/lib/domain";
import { emissionPlan } from "./emissionPlan";
import {
	commonPrefixById,
	entryDatumIds,
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
export interface EntryPointCaseCreationArgument {
	readonly operationUuid: Uuid;
	readonly caseType: string;
	readonly argumentId: string;
	readonly cardinality: "one";
}

/** Case creations can be exposed through this route only if the navigation frame carries
 * their actual computed datum. The XForm may use a root-aligned placeholder for the ID. */
export function availableEntryCaseCreations(
	doc: BlueprintDoc,
	target: Extract<EntryPointTarget, { kind: "form" }>,
	ctx: FormLinkProjectionContext,
	frame = formFrameChildren(doc, ctx, target.moduleUuid, target.formUuid),
): readonly EntryPointCaseCreationArgument[] {
	const identities = new Map(
		entryDatumIds(doc, ctx, target.moduleUuid, target.formUuid).map((row) => [
			row.id,
			row.caseCreationOperationUuid,
		]),
	);
	const cases = new Map(
		ctx
			.newCaseDatums(target.formUuid)
			.map((row) => [row.operationUuid, row.caseType]),
	);
	return frame.flatMap((child) => {
		if (
			child.type !== "datum" ||
			child.datum.requiresSelection ||
			!child.datum.function ||
			child.datum.query
		)
			return [];
		const operationUuid = identities.get(child.datum.id);
		if (operationUuid === undefined) return [];
		const caseType = cases.get(operationUuid);
		return caseType === undefined
			? []
			: [
					{
						operationUuid,
						caseType,
						argumentId: child.datum.id,
						cardinality: "one" as const,
					},
				];
	});
}

export function exposedEntryCaseCreations(
	doc: BlueprintDoc,
	target: Extract<EntryPointTarget, { kind: "form" }>,
	ctx: FormLinkProjectionContext,
	frame?: FrameChild[],
): readonly EntryPointCaseCreationArgument[] {
	const chosen = doc.forms[target.formUuid]?.entryCaseCreations ?? [];
	if (chosen.length === 0) return [];
	const available = availableEntryCaseCreations(doc, target, ctx, frame);
	const exposed = available.filter((item) =>
		chosen.includes(item.operationUuid),
	);
	if (exposed.length !== new Set(chosen).size)
		throw new Error(
			"A case ID supplied by this deep link no longer has a case creation on the form’s route. Remove that argument or choose an available case creation.",
		);
	return exposed;
}

export interface EntryPointProjection {
	readonly target: EntryPointTarget;
	readonly requiredSelections: readonly EntryPointRequiredSelection[];
	readonly availableCreations: readonly EntryPointCaseCreationArgument[];
	readonly requiredCreations: readonly EntryPointCaseCreationArgument[];
	readonly orderedArguments: readonly (
		| EntryPointRequiredSelection
		| EntryPointCaseCreationArgument
	)[];
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
	const paused = listedFormLinkPause(doc, target);
	if (paused) throw new Error(paused);
	if (
		target.kind === "form" &&
		afterEmptySearchRegistrationFormOf(doc, target.moduleUuid) ===
			target.formUuid
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
			!doc.forms[target.formUuid] ||
			!context.formOrder[target.moduleUuid]?.includes(target.formUuid)
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
	const requiredCreations =
		target.kind === "form"
			? exposedEntryCaseCreations(doc, target, ctx, frame)
			: [];
	const byId = new Map(
		[...requiredSelections, ...requiredCreations].map((arg) => [
			arg.argumentId,
			arg,
		]),
	);
	const orderedArguments = frame.flatMap((child) => {
		if (child.type !== "datum") return [];
		const argument = byId.get(child.datum.id);
		return argument === undefined ? [] : [argument];
	});
	if (orderedArguments.length !== byId.size)
		throw new Error(
			"Two values on this deep link need the same argument ID. Choose a different case creation.",
		);
	const availableCreations =
		target.kind === "form"
			? availableEntryCaseCreations(doc, target, ctx, frame)
			: [];
	return {
		target,
		requiredSelections,
		requiredCreations,
		availableCreations,
		orderedArguments,
		frame,
	};
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
