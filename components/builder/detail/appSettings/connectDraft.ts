import {
	connectIdValidity,
	DEFAULT_ASSESSMENT_USER_SCORE,
	DEFAULT_DELIVER_ENTITY_ID,
	DEFAULT_DELIVER_ENTITY_NAME,
	deriveConnectId,
	projectDraftConnectId,
} from "@/lib/doc/connectConfig";
import {
	type AppConnectId,
	connectIdsExcept,
} from "@/lib/doc/hooks/useAppConnectIds";
import {
	asUuid,
	type ConnectConfig,
	type ConnectDeliverConfig,
	type ConnectLearnConfig,
	type ConnectType,
	type XPathExpression,
} from "@/lib/domain";
/** One form's editable block. Every field is a string buffer (typed as-is,
 *  parsed on commit) so the same draft drives both the per-form dialog and
 *  the app-wide manager. Ids autofill when blank; the XPath buffers fall
 *  back to their wire defaults when blank. The kind of each sub-config is
 *  carried by its `*On` flag, not by which fields are filled. */
export interface BlockDraft {
	learnOn: boolean;
	learnName: string;
	learnDescription: string;
	learnTimeEstimate: string;
	learnId: string;
	assessmentOn: boolean;
	assessmentId: string;
	userScoreText: string;
	deliverOn: boolean;
	deliverName: string;
	deliverId: string;
	entityIdText: string;
	entityNameText: string;
	taskOn: boolean;
	taskName: string;
	taskDescription: string;
	taskId: string;
}

/** Connect stores and renders this value as a positive whole-hour count. */
export const DEFAULT_LEARN_TIME_ESTIMATE_HOURS = 1;

export const EMPTY_DRAFT: BlockDraft = {
	learnOn: false,
	learnName: "",
	learnDescription: "",
	learnTimeEstimate: String(DEFAULT_LEARN_TIME_ESTIMATE_HOURS),
	learnId: "",
	assessmentOn: false,
	assessmentId: "",
	// The XPath buffers start at the ACTUAL wire default (not blank) so the
	// editor shows the user exactly what runs; a buffer left at the default is
	// dropped on commit (`draftToConfig`), so the slot stays absent and the
	// wire-emit fallback: the single source of the default, still applies.
	userScoreText: DEFAULT_ASSESSMENT_USER_SCORE,
	deliverOn: false,
	deliverName: "",
	deliverId: "",
	entityIdText: DEFAULT_DELIVER_ENTITY_ID,
	entityNameText: DEFAULT_DELIVER_ENTITY_NAME,
	taskOn: false,
	taskName: "",
	taskDescription: "",
	taskId: "",
};

/** Which sub-configs of a mode the draft has turned on. */
export type SubConfigKind =
	| "learn_module"
	| "assessment"
	| "deliver_unit"
	| "task";

/** Seed a draft from an existing block (the manager's per-form starting
 *  point). `printExpr` lowers a stored XPath AST to its text so the buffers
 *  show what's there: required so an existing `user_score` / entity
 *  expression isn't silently dropped on the next commit. */
export function configToDraft(
	config: ConnectConfig,
	printExpr: (expr: XPathExpression) => string,
): BlockDraft {
	const lm = "learn_module" in config ? config.learn_module : undefined;
	const assessment = "assessment" in config ? config.assessment : undefined;
	const du = "deliver_unit" in config ? config.deliver_unit : undefined;
	const task = "task" in config ? config.task : undefined;
	return {
		learnOn: !!lm,
		learnName: lm?.name ?? "",
		learnDescription: lm?.description ?? "",
		learnTimeEstimate: lm ? String(lm.time_estimate) : "",
		learnId: lm?.id ?? "",
		assessmentOn: !!assessment,
		assessmentId: assessment?.id ?? "",
		// Absent XPath slots show their wire default so the user sees what runs.
		userScoreText: assessment?.user_score
			? printExpr(assessment.user_score)
			: DEFAULT_ASSESSMENT_USER_SCORE,
		deliverOn: !!du,
		deliverName: du?.name ?? "",
		deliverId: du?.id ?? "",
		entityIdText: du?.entity_id
			? printExpr(du.entity_id)
			: DEFAULT_DELIVER_ENTITY_ID,
		entityNameText: du?.entity_name
			? printExpr(du.entity_name)
			: DEFAULT_DELIVER_ENTITY_NAME,
		taskOn: !!task,
		taskName: task?.name ?? "",
		taskDescription: task?.description ?? "",
		taskId: task?.id ?? "",
	};
}

/** Parse the time-estimate buffer: a positive integer (hours) or null. */
export function parseTimeEstimate(raw: string): number | null {
	const n = Number(raw.trim());
	return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/** Whether one draft PARTICIPATES: at least one sub-config is enabled. */
export function draftParticipates(
	draft: BlockDraft,
	mode: ConnectType,
): boolean {
	return mode === "learn"
		? draft.learnOn || draft.assessmentOn
		: draft.deliverOn || draft.taskOn;
}

/** Whether every ENABLED sub-config's required authored content is filled.
 * IDs are assigned during finalization and optional XPath slots use their
 * documented wire defaults; an enabled assessment is always complete. */
export function draftSectionsComplete(
	draft: BlockDraft,
	mode: ConnectType,
): boolean {
	if (mode === "learn") {
		const learnOk =
			draft.learnName.trim().length > 0 &&
			draft.learnDescription.trim().length > 0 &&
			parseTimeEstimate(draft.learnTimeEstimate) !== null;
		return !draft.learnOn || learnOk;
	}
	const unitOk = draft.deliverOn && draft.deliverName.trim().length > 0;
	const taskOk =
		draft.taskOn &&
		draft.taskName.trim().length > 0 &&
		draft.taskDescription.trim().length > 0;
	return (!draft.deliverOn || unitOk) && (!draft.taskOn || taskOk);
}

/** Validate an explicitly-typed id (format + app-wide uniqueness). A blank
 * draft buffer is valid because dialog finalization assigns the id. */
export type IdValidator = (kind: SubConfigKind, value: string) => string | null;

/** Whether every enabled sub-config's typed id is valid. Blank draft buffers
 * pass because finalization assigns them before constructing `ConnectConfig`.
 * Used alongside `draftSectionsComplete` so a bad explicit id cannot reach
 * admission. */
export function draftIdsValid(
	draft: BlockDraft,
	mode: ConnectType,
	validateId: IdValidator,
): boolean {
	const check = (kind: SubConfigKind, on: boolean, id: string) =>
		!on || validateId(kind, id) === null;
	return mode === "learn"
		? check("learn_module", draft.learnOn, draft.learnId) &&
				check("assessment", draft.assessmentOn, draft.assessmentId)
		: check("deliver_unit", draft.deliverOn, draft.deliverId) &&
				check("task", draft.taskOn, draft.taskId);
}

/** The base name `deriveConnectId` builds a slot's id from: the module name
 *  for the module-level kinds, "<module> <form>" for the per-form kinds. */
function idBaseName(
	kind: SubConfigKind,
	moduleName: string,
	formName: string,
): string {
	return kind === "assessment" || kind === "task"
		? `${moduleName} ${formName}`
		: moduleName;
}

/** Per-form id helpers: derive a blank slot's id, validate a typed one:
 *  bound to a "taken" id universe. The app-wide manager passes its
 *  DRAFT-derived universe (so sibling in-flight drafts AND the mode actually
 *  being edited are in scope); the per-form dialog passes the live-doc
 *  universe. One builder, so a typed id is judged and a blank one seeded
 *  identically wherever the editor runs. */
export function connectIdHelpers(
	ids: readonly AppConnectId[],
	formUuid: string,
	moduleName: string,
	formName: string,
): { derivedId: (kind: SubConfigKind) => string; validateId: IdValidator } {
	const takenFor = (kind: SubConfigKind) =>
		connectIdsExcept(ids, asUuid(formUuid), kind);
	return {
		derivedId: (kind) =>
			deriveConnectId(idBaseName(kind, moduleName, formName), takenFor(kind)),
		validateId: (kind, value) => {
			return value === "" ? null : connectIdValidity(value, takenFor(kind));
		},
	};
}

/** The id every participating sub-config of `mode` currently proposes,
 * accumulated via the shared `projectDraftConnectId` rule: an explicit value
 * stays byte-for-byte visible even when the adjacent guard will refuse it, and
 * only an empty value derives from the entity name. Every explicit identity is
 * reserved before any empty draft derives, so a blank earlier in document
 * order cannot steal a later explicit spelling. Built from the caller's drafts
 * so its id guard and seeding read the in-flight set, not just the live doc: two
 * blank same-base blocks disambiguate here exactly as they will at commit (no
 * display-vs-stored drift), and an explicit duplicate typed across two forms
 * is caught inline. Callers may seed the scope with committed ids outside
 * their target set; every returned entry is the complete guard universe. */
export function assignDraftConnectIds(
	forms: readonly { formUuid: string; moduleName: string; formName: string }[],
	modeDrafts: Record<string, BlockDraft>,
	mode: ConnectType,
	reservedIds: readonly AppConnectId[] = [],
): AppConnectId[] {
	const taken = new Set(reservedIds.map(({ id }) => id));
	const out: AppConnectId[] = [...reservedIds];
	const requested: Array<{
		readonly formUuid: string;
		readonly kind: SubConfigKind;
		readonly buffer: string;
		readonly base: string;
	}> = [];
	const collect = (
		formUuid: string,
		kind: SubConfigKind,
		on: boolean,
		buffer: string,
		base: string,
	) => {
		if (!on) return;
		requested.push({ formUuid, kind, buffer, base });
	};
	for (const f of forms) {
		const d = modeDrafts[f.formUuid] ?? EMPTY_DRAFT;
		const pair = `${f.moduleName} ${f.formName}`;
		if (mode === "learn") {
			collect(f.formUuid, "learn_module", d.learnOn, d.learnId, f.moduleName);
			collect(f.formUuid, "assessment", d.assessmentOn, d.assessmentId, pair);
		} else {
			collect(
				f.formUuid,
				"deliver_unit",
				d.deliverOn,
				d.deliverId,
				f.moduleName,
			);
			collect(f.formUuid, "task", d.taskOn, d.taskId, pair);
		}
	}
	for (const { buffer } of requested) {
		if (buffer !== "") taken.add(buffer);
	}
	for (const { formUuid, kind, buffer, base } of requested) {
		const id = projectDraftConnectId(
			buffer === "" ? undefined : buffer,
			base,
			taken,
		);
		out.push({ formUuid: asUuid(formUuid), kind, id });
	}
	return out;
}

/** An XPath buffer counts as an OVERRIDE only when it's non-empty AND
 *  differs from the wire default. Otherwise the slot is left absent so the
 *  single wire-emit default applies (and a blank never trips
 *  `CONNECT_EMPTY_XPATH`): the editor shows the default as a starting point
 *  the user can replace, not a value Nova pins into the doc. */
function xpathOverride(
	text: string,
	wireDefault: string,
	parseExpr: (text: string) => XPathExpression,
): XPathExpression | undefined {
	const trimmed = text.trim();
	if (!trimmed || trimmed === wireDefault) return undefined;
	return parseExpr(trimmed);
}

/** Lower a component-local draft to one complete final `ConnectConfig`.
 * Blank ids are assigned before the value leaves the dialog; an XPath buffer
 * still at its default stays absent so the wire-emit default applies. */
export function draftToConfig(
	draft: BlockDraft,
	mode: "learn",
	parseExpr: (text: string) => XPathExpression,
	derivedId: (kind: SubConfigKind) => string,
): ConnectLearnConfig;
export function draftToConfig(
	draft: BlockDraft,
	mode: "deliver",
	parseExpr: (text: string) => XPathExpression,
	derivedId: (kind: SubConfigKind) => string,
): ConnectDeliverConfig;
export function draftToConfig(
	draft: BlockDraft,
	mode: ConnectType,
	parseExpr: (text: string) => XPathExpression,
	derivedId: (kind: SubConfigKind) => string,
): ConnectConfig;
export function draftToConfig(
	draft: BlockDraft,
	mode: ConnectType,
	parseExpr: (text: string) => XPathExpression,
	derivedId: (kind: SubConfigKind) => string,
): ConnectConfig {
	if (!draftParticipates(draft, mode) || !draftSectionsComplete(draft, mode)) {
		throw new Error("Incomplete Connect draft reached finalization.");
	}
	if (mode === "learn") {
		const userScore = xpathOverride(
			draft.userScoreText,
			DEFAULT_ASSESSMENT_USER_SCORE,
			parseExpr,
		);
		return {
			...(draft.learnOn && {
				learn_module: {
					id: draft.learnId || derivedId("learn_module"),
					name: draft.learnName.trim(),
					description: draft.learnDescription.trim(),
					time_estimate: parseTimeEstimate(draft.learnTimeEstimate) as number,
				},
			}),
			...(draft.assessmentOn && {
				assessment: {
					id: draft.assessmentId || derivedId("assessment"),
					...(userScore && { user_score: userScore }),
				},
			}),
		};
	}
	const entityId = xpathOverride(
		draft.entityIdText,
		DEFAULT_DELIVER_ENTITY_ID,
		parseExpr,
	);
	const entityName = xpathOverride(
		draft.entityNameText,
		DEFAULT_DELIVER_ENTITY_NAME,
		parseExpr,
	);
	return {
		...(draft.deliverOn && {
			deliver_unit: {
				id: draft.deliverId || derivedId("deliver_unit"),
				name: draft.deliverName.trim(),
				...(entityId && { entity_id: entityId }),
				...(entityName && { entity_name: entityName }),
			},
		}),
		...(draft.taskOn && {
			task: {
				id: draft.taskId || derivedId("task"),
				name: draft.taskName.trim(),
				description: draft.taskDescription.trim(),
			},
		}),
	};
}

/** UI admission for the exact target floor. An empty app or a target with
 * every form switched off is never offered to the app-wide planner. */
export function hasDraftConnectParticipant(
	forms: readonly { readonly formUuid: string }[],
	modeDrafts: Record<string, BlockDraft>,
	mode: ConnectType,
): boolean {
	return forms.some((form) =>
		draftParticipates(modeDrafts[form.formUuid] ?? EMPTY_DRAFT, mode),
	);
}
