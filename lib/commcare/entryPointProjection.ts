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
	type FrameBuilder,
	type FrameChild,
	formFrameChildren,
	formLinkProjectionContext,
	moduleFrameChildren,
} from "./formLinkProjection";
import { homeSelectionConsumers } from "./previousTaskProjection";
import { moduleUsesInlineSearch } from "./suite/case-search/inlineSearch";
import { rethrowWorkStop } from "./workMeter";

export interface EntryPointRequiredSelection {
	readonly moduleUuid: Uuid;
	readonly caseType: string;
	readonly cardinality: "one" | "multiple";
	readonly maximum: number;
	readonly argumentId: string;
	/** Menus consuming this argument after Android Back returns to the first menu. */
	readonly firstMenuConsumers?: readonly Uuid[];
	/** Other owners of this same datum in the actual destination entry. */
	readonly destinationConsumers?: readonly Uuid[];
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
	frame = formFrameChildren(
		doc,
		ctx,
		target.moduleUuid,
		target.formUuid,
		"endpoint",
	),
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
	/**
	 * The frame Android keeps on Home after Back, read up to its first
	 * command. HQ claims every selection the endpoint binds, each in its own
	 * push ahead of the navigation (`EndpointsHelper._make_session_endpoint`),
	 * so the first claimed case precedes every command. Back pops the
	 * navigation, then each posted claim with the cases claimed after the
	 * first, since a claim already posted needs nothing more
	 * (`CommCareSession.stepBack`, `getNeededData`), and stops on Home with
	 * that first case still collected, whatever menu the destination is in.
	 * It is that case, then the endpoint frame's commands. With inline search
	 * nothing is claimed, so it is `frame` itself.
	 */
	readonly homeFrame: readonly FrameChild[];
	/**
	 * The frame the first-menu rules read: the workflow frame where claims are
	 * posted, else `frame`. It leads with a selection exactly where the
	 * destination opens with the case the first menu's forms share.
	 */
	readonly firstMenuFrame: readonly FrameChild[];
	/** Whether a selection this entry point binds is the first menu's shared
	 *  case, read from `firstMenuFrame`. */
	readonly opensWithFirstMenuCase: boolean;
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
	if (
		target.kind === "form" &&
		(!doc.forms[target.formUuid] ||
			!context.formOrder[target.moduleUuid]?.includes(target.formUuid))
	)
		throw new Error("The entry point form is missing.");
	const frame = entryPointFrame(doc, context, target, "endpoint");
	const claims = !moduleUsesInlineSearch(doc.modules[target.moduleUuid]);
	const firstClaim = claims
		? frame.find(
				(child) =>
					child.type === "datum" &&
					child.datum.requiresSelection &&
					!child.datum.query,
			)
		: undefined;
	const homeFrame = firstClaim
		? [firstClaim, ...frame.filter((child) => child.type === "command")]
		: frame;
	const firstMenuFrame = claims
		? entryPointFrame(doc, context, target, "workflow")
		: frame;
	const homeCases = new Map(
		[...homeSelectionConsumers(doc, context, homeFrame)].map(
			([datum, consumers]) => [datum.id, consumers],
		),
	);
	// The workflow frame is built apart, so its datums are matched by id.
	const firstMenuCaseIds = new Set(
		[...homeSelectionConsumers(doc, context, firstMenuFrame).keys()].map(
			(datum) => datum.id,
		),
	);
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
		const home = homeCases.get(d.id);
		const destinationConsumers = home && [...home.destinationModules];
		return [
			{
				moduleUuid: d.selectionSourceModuleUuid,
				...(home && {
					firstMenuConsumers: [d.selectionSourceModuleUuid, ...home.modules],
				}),
				...(destinationConsumers?.length && { destinationConsumers }),
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
		homeFrame,
		firstMenuFrame,
		opensWithFirstMenuCase: requiredSelections.some((selection) =>
			firstMenuCaseIds.has(selection.argumentId),
		),
	};
}

/** HQ's `EndpointsHelper.get_frame_children` for the target, as `builder`'s
 *  `WorkflowHelper` builds it. */
function entryPointFrame(
	doc: BlueprintDoc,
	context: FormLinkProjectionContext,
	target: EntryPointTarget,
	builder: FrameBuilder,
): FrameChild[] {
	if (target.kind === "form")
		return formFrameChildren(
			doc,
			context,
			target.moduleUuid,
			target.formUuid,
			builder,
		);
	const prefix = moduleFrameChildren(doc, context, target.moduleUuid, builder);
	const preceding = new Set(
		prefix.flatMap((c) => (c.type === "datum" ? [c.datum.id] : [])),
	);
	// A menu listing another menu's forms takes the common prefix of its
	// source's own entries, every form of the source including the ones it
	// leaves out (`get_frame_children`: `form is None and module_type ==
	// "shadow"` reads `get_module_datums(source)`).
	const listsModule =
		doc.modules[target.moduleUuid]?.formsFromMenu?.menuUuid ??
		target.moduleUuid;
	const common = commonPrefixById(
		(context.formOrder[listsModule] ?? []).map((uuid) =>
			entryFrameDatums(doc, context, listsModule, uuid),
		),
	);
	const frame = [
		...prefix,
		...common
			.filter((d) => !preceding.has(d.id))
			.map((datum) => ({ type: "datum" as const, datum })),
	];
	if (target.kind !== "case-list") return frame;
	const last = frame.at(-1);
	if (
		last?.type !== "datum" ||
		!last.datum.requiresSelection ||
		last.datum.query
	)
		throw new Error(
			"This destination opens a module menu. Choose a module entry point.",
		);
	return frame.slice(0, -1);
}
export function entryPointProjectionIssue(
	doc: BlueprintDoc,
	target: EntryPointTarget,
): string | undefined {
	try {
		projectEntryPoint(doc, target);
		return undefined;
	} catch (error) {
		rethrowWorkStop(error);
		return error instanceof Error
			? error.message
			: "This entry point cannot be projected.";
	}
}
