/**
 * Bringing an app in from CommCare HQ, as data: what the page holds, the
 * events that change it, the screen it shows (`screenOf`) and the one request
 * it makes next (`nextAct`). The components draw `screenOf(model)` and
 * dispatch events; `useBringIn` does what `nextAct(model)` says and
 * dispatches what came back. Beside them are the pure functions each screen
 * reads: the review's answers, a stop's actions, the account's groups and
 * its copied text, the lines under the platform choice, a create's lead, and
 * the review's tables, files and what Bring it in does when pressed.
 *
 * Pure and client-safe: no React, nothing of `lib/commcare`. Types come from
 * `@/lib/deployment`; the values it needs of a bring-in are imported from
 * their client-safe files by path.
 */

import type {
	AccountAnswer,
	BringInInput,
	CreateAnswer,
	HqAppPicker,
	LookupTableChoice,
	ReadingAnswer,
	ReadingDeclarationChoice,
	ReadingKey,
	ReadingRefusal,
	ReadingReview,
	ReadingStage,
	ReviewTable,
} from "@/lib/deployment";
import { accountOfOne } from "@/lib/deployment/reading/answers";
import {
	bringInInputSchema,
	keptTableChoices,
} from "@/lib/deployment/reading/types";
import {
	PLATFORM_DECLARATION_LABELS,
	PLATFORM_DECLARATION_LINES,
	type Platform,
} from "@/lib/domain/platforms";
import {
	ACCOUNT_MEDIA_GROUP_HEADING,
	accountCountPart,
	accountHeadingLine,
	accountTextFirstLine,
	BRING_IN_ACTIONS,
	type BringInAnswerSource,
	NAMED_IN_HQ_LEAD,
	openAppAction,
	platformOutBlock,
	REVIEW_CHANGE_LATER,
	REVIEW_CHOICE_MISSING,
	REVIEW_NO_CHOICE_OPEN,
	REVIEW_RUNS_ON_WHY,
	REVIEW_WEB_APPS_ASKS_OFF,
	REVIEW_WEB_APPS_ASKS_ON,
	reviewCountsLine,
	splitDatetimeLine,
} from "@/lib/publish/bringInCopy";
import {
	ACCOUNT_CHECK_AGAIN_LINE,
	type CircumstanceContext,
	circumstanceBlock,
	FINDING_LABELS,
	findingLine,
	placeLine,
} from "@/lib/publish/hqFindingCopy";
import {
	type CircumstanceFinding,
	type Finding,
	type FindingStanding,
	type HqPlace,
	NOVA_FAULT_CIRCUMSTANCES,
	type ReadCircumstance,
	type StopCircumstance,
} from "@/lib/publish/hqFindings";
import {
	CREATE_ANSWER_LEADS,
	moreFindingsLine,
} from "@/lib/publish/hqReadingCopy";
import {
	CHOICE_OTHER_PROJECT,
	choiceNotOffered,
	columnsBecomeText,
	HQ_TABLE_ANSWER,
	hqTableAnswerConsequence,
	hqTableAnswerGoneColumns,
	MEDIA_CHECKED_LATER,
	projectTableAnswer,
	projectTableAnswerConsequence,
	reviewChoiceBody,
	reviewChoiceTitle,
	reviewManagedPlaces,
	reviewManagedTables,
	reviewMediaAdded,
	reviewMediaLeftOut,
	reviewSameEqualTable,
} from "@/lib/publish/managedData";
import {
	addressSearchReviewLine,
	adoptionRecordedFeaturesLine,
	PLAN_FEATURES,
} from "@/lib/publish/planFeatures";
import type { BringInLocation } from "@/lib/routing/bringInLocation";

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** A request to one of the two bring-in routes. At most one is in flight. */
export type BringInCall = "read" | "create";

/** A read's answer that is a review. */
export type ReviewAnswer = Extract<ReadingAnswer, { readonly kind: "review" }>;

export interface ReviewAnswers {
	/** The digest of the review these answer. */
	readonly reviewDigest: string;
	readonly appName: string;
	readonly runsOnlyOn: Platform | null;
	readonly splitDatetime: boolean;
	readonly tableChoices: Readonly<Record<string, LookupTableChoice>>;
}

export interface PickerModel {
	/** The Project chosen under "Add it to", or null where the person can add to none. */
	readonly projectId: string | null;
	/** The project spaces the connection reaches, by name. Empty where there is no connection. */
	readonly domains: readonly string[];
	readonly domain: string | null;
	/** `idle` before a project space is chosen; `loading` is what makes the hook list its apps. */
	readonly apps:
		| { readonly kind: "idle" }
		| { readonly kind: "loading" }
		| { readonly kind: "loaded"; readonly picker: HqAppPicker }
		| { readonly kind: "failed" };
	readonly remoteAppId: string | null;
	readonly filter: string;
}

/**
 * Which lead of `CREATE_ANSWER_LEADS` stands above what a create's answer
 * shows: one for each answer that did not create and is no refusal, with
 * `changed` told apart by what it carries.
 */
export type CreateLead =
	| "changed-review"
	| "changed-account"
	| "changed-stop"
	| "changed-already-in-nova"
	| "read-again"
	| "check-failed"
	| "held";

export interface BringInModel {
	readonly location: BringInLocation;
	readonly picker: PickerModel;
	/**
	 * False at an app's address until the hook has looked at the tab's key for
	 * a create to send again. Nothing is requested before it is true.
	 */
	readonly resumeChecked: boolean;
	/** What the app's last read answered, or what a create said the app is now. Null before one. */
	readonly answer: ReadingAnswer | null;
	/** When `answer` arrived, for the date of a copied account. */
	readonly answeredAt: number | null;
	readonly call: BringInCall | null;
	/** The last stage the request in flight named, and its last count of files. */
	readonly stage: ReadingStage | null;
	readonly files: { readonly done: number; readonly total: number } | null;
	/** When the wait on screen began, for the reassurance at twenty seconds. */
	readonly waitingSince: number | null;
	/** How many requests in a row ended with no last line. Any request that answers makes it 0. */
	readonly lost: number;
	/** The request whose stream ended in a `failed` line. Its screen stands until Try again. */
	readonly failed: BringInCall | null;
	readonly answers: ReviewAnswers | null;
	/**
	 * The answers a person held when a create answered `read-again`, with the
	 * review they answered, waiting for the review the next read answers.
	 */
	readonly carried: {
		readonly answers: ReviewAnswers;
		readonly review: ReadingReview;
	} | null;
	/**
	 * The input of a create that has begun and not ended. Set by
	 * `create-asked`, kept through a lost request and a `failed` line, cleared
	 * when the create ends any other way. While it is set the screen is
	 * `creating` or the failed screen, never the review.
	 */
	readonly pendingCreate: BringInInput | null;
	/**
	 * The input of a create the person left while its request is still open:
	 * `call` stays `create` until it ends. A stream's lines name no request,
	 * so nothing else is sent until then, and the reading screen of the app
	 * the person went to says which app it waits for. Going back to that
	 * create's own app puts it on screen again.
	 */
	readonly leftCreate: BringInInput | null;
	/** The finding of a create answered `held`. */
	readonly held: CircumstanceFinding | null;
	/** The lead of the last create that did not create, and whether a choice could not be kept. */
	readonly lead: {
		readonly kind: CreateLead;
		readonly dropped: boolean;
	} | null;
	readonly refusal: ReadingRefusal | null;
	/** How the landing of a created app ended, and that app's id. */
	readonly landing: {
		readonly answer: "landed" | "leaving" | "unverified";
		readonly appId: string;
	} | null;
	/** The tag of the table choice focus was last sent to, with a counter so a second press moves it again. */
	readonly needsChoice: { readonly tag: string; readonly nonce: number } | null;
	/**
	 * A route answered 401: the session ended. Every request of the page would
	 * answer the same until it is loaded again, so it holds until then,
	 * wherever the address goes.
	 */
	readonly signedOut: boolean;
}

export type BringInEvent =
	| { readonly type: "location"; readonly location: BringInLocation }
	/** What the tab's key held for the app the location now names: a create to send again, or null. */
	| { readonly type: "resume"; readonly input: BringInInput | null }
	/** The connection as the context holds it now: dispatched at mount and whenever it changes. */
	| { readonly type: "connection"; readonly domains: readonly string[] }
	| { readonly type: "picker-project"; readonly projectId: string }
	| { readonly type: "picker-domain"; readonly domain: string }
	| {
			readonly type: "picker-apps";
			readonly domain: string;
			readonly picker: HqAppPicker | null;
	  }
	/** "Try again" after a list that failed, and "Check again" on a stop met while choosing. */
	| { readonly type: "picker-reload" }
	| { readonly type: "picker-app"; readonly remoteAppId: string }
	| { readonly type: "picker-filter"; readonly filter: string }
	/** Check again, on a stop, an account or a refusal: the app is read afresh. */
	| { readonly type: "read-asked" }
	/** Bring it in, pressed with every answer given: the input becomes `pendingCreate`. */
	| { readonly type: "create-asked"; readonly input: BringInInput }
	| { readonly type: "call"; readonly call: BringInCall; readonly at: number }
	/** Lines of the request's stream. */
	| { readonly type: "stage"; readonly stage: ReadingStage }
	| { readonly type: "files"; readonly done: number; readonly total: number }
	| {
			readonly type: "read-done";
			readonly answer: ReadingAnswer;
			readonly at: number;
	  }
	| {
			readonly type: "create-done";
			readonly answer: CreateAnswer;
			readonly at: number;
	  }
	/** The stream's last line was `failed`: Nova's own fault, logged on the server. */
	| { readonly type: "failed"; readonly call: BringInCall }
	/** The response ended with no last line, or was no stream and held no `code`. */
	| { readonly type: "lost"; readonly call: BringInCall }
	/** A route refused with a `code` before it opened its stream. */
	| {
			readonly type: "refused";
			readonly call: BringInCall;
			readonly refusal: ReadingRefusal;
	  }
	/** Any request of the page, a list, a read or a create, answered 401. */
	| { readonly type: "signed-out" }
	/** "Try again" after a `failed` line or two lost requests: the person asks for the same act. */
	| { readonly type: "retry" }
	| { readonly type: "answers"; readonly answers: ReviewAnswers }
	| { readonly type: "choice-needed"; readonly tag: string }
	| {
			readonly type: "landed";
			readonly answer: "landed" | "leaving" | "unverified";
			readonly appId: string;
	  };

/** The refusals no screen but the `refused` one can show: nothing else is left to draw. */
const SCREEN_REFUSALS: ReadonlySet<ReadingRefusal> = new Set<ReadingRefusal>([
	"no_project_access",
	"invalid_input",
	"app_unavailable",
]);

/** The refusals an answer of the person's review clears: the person has answered again. */
const ANSWER_REFUSALS: ReadonlySet<ReadingRefusal> = new Set<ReadingRefusal>([
	"name_missing",
	"choice_missing",
	"choice_not_offered",
]);

/** The stages whose stream counts files. */
const COUNTED_STAGES: ReadonlySet<ReadingStage> = new Set<ReadingStage>([
	"checking-media",
	"bringing-in-media",
]);

/** How long the page waits before it sends a lost request once more. */
const LOST_RETRY_MS = 3000;

function sameKey(a: ReadingKey, b: ReadingKey): boolean {
	return (
		a.projectId === b.projectId &&
		a.server === b.server &&
		a.domain === b.domain &&
		a.remoteAppId === b.remoteAppId
	);
}

/**
 * Everything the model held of the app, cleared: `answer`, `answeredAt`,
 * `answers`, `carried`, `held`, `lead`, `refusal`, `failed`, `needsChoice`,
 * `stage`, `files` and `waitingSince`, with `lost` 0.
 */
function withoutTheApp(model: BringInModel): BringInModel {
	return {
		...model,
		answer: null,
		answeredAt: null,
		answers: null,
		carried: null,
		held: null,
		lead: null,
		refusal: null,
		failed: null,
		needsChoice: null,
		stage: null,
		files: null,
		waitingSince: null,
		lost: 0,
	};
}

/**
 * Whether a `stage` or `files` line belongs to the screen on display: the
 * read's, or the create's while its creating screen stands. A create the
 * person left (its `pendingCreate` cleared by a `location` event, its `call`
 * kept) names lines of another app than the one on screen.
 */
function linesAreOnScreen(model: BringInModel): boolean {
	return (
		model.call === "read" ||
		(model.call === "create" && model.pendingCreate !== null)
	);
}

/** The request ended: nothing of it is in flight or waited on. */
function callEnded(model: BringInModel): BringInModel {
	return { ...model, call: null, stage: null, files: null, waitingSince: null };
}

/** `projectId` is the Project to preselect: the tab's where the seed lists it, else the first, else null. */
export function initialBringInModel(
	location: BringInLocation,
	projectId: string | null,
): BringInModel {
	return {
		location,
		picker: {
			projectId,
			domains: [],
			domain: null,
			apps: { kind: "idle" },
			remoteAppId: null,
			filter: "",
		},
		resumeChecked: location.kind !== "app",
		answer: null,
		answeredAt: null,
		call: null,
		stage: null,
		files: null,
		waitingSince: null,
		lost: 0,
		failed: null,
		answers: null,
		carried: null,
		pendingCreate: null,
		leftCreate: null,
		held: null,
		lead: null,
		refusal: null,
		landing: null,
		needsChoice: null,
		signedOut: false,
	};
}

/** Whether a loaded list holds a row of `remoteAppId` a person can choose: one no Nova app holds. */
function isChoosable(picker: HqAppPicker, remoteAppId: string): boolean {
	return (
		picker.kind === "apps" &&
		picker.apps.some(
			(row) => row.remoteAppId === remoteAppId && row.claim === null,
		)
	);
}

function chooseDomain(picker: PickerModel, domain: string): PickerModel {
	return {
		...picker,
		domain,
		apps: { kind: "loading" },
		remoteAppId: null,
		filter: "",
	};
}

function reduceConnection(
	picker: PickerModel,
	domains: readonly string[],
): PickerModel {
	let next: PickerModel = { ...picker, domains };
	if (next.domain !== null && !domains.includes(next.domain)) {
		next = { ...next, domain: null, apps: { kind: "idle" }, remoteAppId: null };
	} else if (
		next.domain !== null &&
		next.apps.kind === "loaded" &&
		next.apps.picker.kind === "not-connected"
	) {
		// The list found no key, and the connection now reaches its project
		// space: the key came back, so the list is read again. Nothing else
		// would ever read it, since the connection aside hides the fields.
		next = { ...next, apps: { kind: "loading" } };
	}
	const only = domains.length === 1 ? domains[0] : undefined;
	if (only !== undefined && next.domain === null && next.projectId !== null) {
		next = chooseDomain(next, only);
	}
	return next;
}

function reduceLocation(
	model: BringInModel,
	location: BringInLocation,
): BringInModel {
	const held = model.location.kind === "app" ? model.location.key : null;
	if (location.kind === "app" && held !== null && sameKey(held, location.key)) {
		return { ...model, location };
	}
	// A read belongs to the app it reads, and the hook aborts it when the
	// location leaves that app, dispatching nothing; a create runs to its end
	// and keeps its call.
	const call = model.call === "read" ? null : model.call;
	const left =
		call === "create" ? (model.pendingCreate ?? model.leftCreate) : null;
	const cleared = {
		...withoutTheApp(model),
		location,
		call,
		pendingCreate: null,
		leftCreate: left,
	};
	if (location.kind !== "app") return cleared;
	const moved = { ...cleared, landing: null, resumeChecked: false };
	// Back at the app of the create still running: its creating screen again,
	// whatever the tab's key still holds.
	return left !== null && sameKey(left, location.key)
		? { ...moved, pendingCreate: left, leftCreate: null }
		: moved;
}

/**
 * The review a person's answers were given against, and those answers: the
 * ones they changed, or the review's defaults they saw and sent. Null where
 * the model holds no review.
 */
function heldReview(
	model: BringInModel,
): { readonly answers: ReviewAnswers; readonly review: ReadingReview } | null {
	if (model.answer?.kind !== "review") return null;
	return {
		answers: model.answers ?? initialAnswers(model.answer),
		review: model.answer.review,
	};
}

function leadOfChanged(now: ReadingAnswer): CreateLead {
	switch (now.kind) {
		case "review":
			return "changed-review";
		case "account":
			return "changed-account";
		case "stop":
			return now.finding.code === "already-in-nova"
				? "changed-already-in-nova"
				: "changed-stop";
	}
}

function reduceCreateDone(
	model: BringInModel,
	answer: CreateAnswer,
	at: number,
): BringInModel {
	// The hook lands the receipt and dispatches `landed`.
	if (answer.kind === "created") return model;
	// A create the person left: its answer ends the call and says nothing of
	// the app now on screen.
	if (model.pendingCreate === null)
		return { ...model, call: null, leftCreate: null };
	const ended: BringInModel = {
		...callEnded(model),
		pendingCreate: null,
		lost: 0,
		carried: null,
	};
	switch (answer.kind) {
		case "changed": {
			const now = answer.now;
			const held = heldReview(model);
			const carried =
				now.kind === "review" && held !== null
					? carryAnswers(
							held.answers,
							held.review,
							now.review,
							now.reviewDigest,
						)
					: null;
			return {
				...ended,
				answer: now,
				answeredAt: at,
				answers: carried?.answers ?? null,
				lead: { kind: leadOfChanged(now), dropped: carried?.dropped ?? false },
				held: null,
				refusal: null,
			};
		}
		case "read-again":
			return {
				...ended,
				carried: heldReview(model),
				answer: null,
				answeredAt: null,
				answers: null,
				lead: { kind: "read-again", dropped: false },
				held: null,
				refusal: null,
			};
		case "check-failed":
			return {
				...ended,
				answer: accountOfOne(answer.finding, knownAppName(model)),
				answeredAt: at,
				answers: null,
				lead: { kind: "check-failed", dropped: false },
				held: null,
				refusal: null,
			};
		case "held":
			return {
				...ended,
				held: answer.finding,
				lead: { kind: "held", dropped: false },
				refusal: null,
			};
		case "refused":
			return { ...ended, refusal: answer.refusal };
	}
}

function reduceReadDone(
	model: BringInModel,
	answer: ReadingAnswer,
	at: number,
): BringInModel {
	const answered: BringInModel = {
		...callEnded(model),
		answer,
		answeredAt: at,
		lost: 0,
		carried: null,
		answers: null,
	};
	if (answer.kind !== "review" || model.carried === null) return answered;
	const kept = carryAnswers(
		model.carried.answers,
		model.carried.review,
		answer.review,
		answer.reviewDigest,
	);
	return {
		...answered,
		answers: kept.answers,
		lead: model.lead === null ? null : { ...model.lead, dropped: kept.dropped },
	};
}

export function reduceBringIn(
	model: BringInModel,
	event: BringInEvent,
): BringInModel {
	switch (event.type) {
		case "location":
			return reduceLocation(model, event.location);
		case "resume":
			if (event.input === null) return { ...model, resumeChecked: true };
			return {
				...reduceBringIn(model, { type: "create-asked", input: event.input }),
				resumeChecked: true,
			};
		case "connection":
			return {
				...model,
				picker: reduceConnection(model.picker, event.domains),
			};
		case "picker-project":
			return {
				...model,
				picker: { ...model.picker, projectId: event.projectId },
			};
		case "picker-domain":
			return { ...model, picker: chooseDomain(model.picker, event.domain) };
		case "picker-reload":
			return model.picker.domain === null
				? model
				: { ...model, picker: { ...model.picker, apps: { kind: "loading" } } };
		case "picker-apps": {
			const { picker } = model;
			if (picker.apps.kind !== "loading" || picker.domain !== event.domain)
				return model;
			if (event.picker === null)
				return { ...model, picker: { ...picker, apps: { kind: "failed" } } };
			const remoteAppId =
				picker.remoteAppId !== null &&
				isChoosable(event.picker, picker.remoteAppId)
					? picker.remoteAppId
					: null;
			return {
				...model,
				picker: {
					...picker,
					apps: { kind: "loaded", picker: event.picker },
					remoteAppId,
				},
			};
		}
		case "picker-app": {
			const { apps } = model.picker;
			if (
				apps.kind !== "loaded" ||
				!isChoosable(apps.picker, event.remoteAppId)
			)
				return model;
			return {
				...model,
				picker: { ...model.picker, remoteAppId: event.remoteAppId },
			};
		}
		case "picker-filter":
			return { ...model, picker: { ...model.picker, filter: event.filter } };
		case "read-asked":
			return withoutTheApp(model);
		case "create-asked":
			return {
				...model,
				pendingCreate: event.input,
				leftCreate: null,
				held: null,
				lead: null,
				refusal: null,
				failed: null,
				needsChoice: null,
				lost: 0,
			};
		case "call":
			return {
				...model,
				call: event.call,
				stage: null,
				files: null,
				waitingSince: model.waitingSince ?? event.at,
			};
		case "stage":
			if (!linesAreOnScreen(model)) return model;
			return {
				...model,
				stage: event.stage,
				files:
					COUNTED_STAGES.has(event.stage) && event.stage === model.stage
						? model.files
						: null,
			};
		case "files":
			if (!linesAreOnScreen(model)) return model;
			return { ...model, files: { done: event.done, total: event.total } };
		case "read-done":
			if (model.call !== "read") return model;
			return reduceReadDone(model, event.answer, event.at);
		case "create-done":
			if (model.call !== "create") return model;
			return reduceCreateDone(model, event.answer, event.at);
		case "failed":
		case "lost":
		case "refused": {
			if (model.call !== event.call) return model;
			if (event.call === "create" && model.pendingCreate === null)
				return { ...model, call: null, leftCreate: null };
			if (event.type === "lost")
				return { ...model, lost: model.lost + 1, call: null };
			if (event.type === "failed")
				return { ...callEnded(model), failed: event.call, lost: 0 };
			return {
				...callEnded(model),
				refusal: event.refusal,
				pendingCreate: null,
				lost: 0,
			};
		}
		case "signed-out":
			return {
				...callEnded(model),
				signedOut: true,
				pendingCreate: null,
				leftCreate: null,
			};
		case "retry":
			return { ...model, lost: 0, failed: null };
		case "answers": {
			if (
				model.answer?.kind !== "review" ||
				model.answer.reviewDigest !== event.answers.reviewDigest
			)
				return model;
			const needsChoice =
				model.needsChoice !== null &&
				Object.hasOwn(event.answers.tableChoices, model.needsChoice.tag)
					? null
					: model.needsChoice;
			const refusal =
				model.refusal !== null && ANSWER_REFUSALS.has(model.refusal)
					? null
					: model.refusal;
			return { ...model, answers: event.answers, needsChoice, refusal };
		}
		case "choice-needed":
			return {
				...model,
				needsChoice: {
					tag: event.tag,
					nonce: (model.needsChoice?.nonce ?? 0) + 1,
				},
			};
		case "landed":
			return {
				...model,
				landing: { answer: event.answer, appId: event.appId },
				call: null,
				pendingCreate: null,
				leftCreate: null,
			};
	}
}

// ---------------------------------------------------------------------------
// The screen, and the next act
// ---------------------------------------------------------------------------

export type BringInScreen =
	| { readonly kind: "none" }
	| { readonly kind: "choose" }
	/** A request answered 401: only a reload, which signs the person in again, can go on. */
	| { readonly kind: "signed-out" }
	/** `lost`: two requests in a row ended with no last line, and the screen offers Try again. */
	| { readonly kind: "reading"; readonly lost: boolean }
	/** Nova's own fault, in a read or in a create. */
	| { readonly kind: "failed"; readonly operation: BringInCall }
	/** A refusal that leaves nothing else to show. */
	| { readonly kind: "refused"; readonly refusal: ReadingRefusal }
	| { readonly kind: "stopped"; readonly finding: CircumstanceFinding }
	| { readonly kind: "account"; readonly answer: AccountAnswer }
	| {
			readonly kind: "review";
			readonly answer: ReviewAnswer;
			readonly answers: ReviewAnswers;
	  }
	| { readonly kind: "creating"; readonly lost: boolean }
	/** The app exists and this tab could not open it. */
	| { readonly kind: "unopened"; readonly appId: string };

export function screenOf(model: BringInModel): BringInScreen {
	const { location, landing } = model;
	if (location.kind === "none") return { kind: "none" };
	if (model.signedOut) return { kind: "signed-out" };
	if (location.kind === "choose") return { kind: "choose" };
	if (landing?.answer === "unverified")
		return { kind: "unopened", appId: landing.appId };
	if (model.failed !== null) return { kind: "failed", operation: model.failed };
	if (model.pendingCreate !== null || landing !== null)
		return { kind: "creating", lost: model.lost >= 2 };
	if (model.refusal !== null && SCREEN_REFUSALS.has(model.refusal))
		return { kind: "refused", refusal: model.refusal };
	const { answer } = model;
	if (answer === null) return { kind: "reading", lost: model.lost >= 2 };
	switch (answer.kind) {
		case "stop":
			return { kind: "stopped", finding: answer.finding };
		case "account":
			return { kind: "account", answer };
		case "review":
			return {
				kind: "review",
				answer,
				answers: model.answers ?? initialAnswers(answer),
			};
	}
}

export type BringInAct =
	| { readonly kind: "none" }
	| { readonly kind: "list-apps"; readonly domain: string }
	| {
			readonly kind: "read";
			readonly key: ReadingKey;
			readonly afterMs: number;
	  }
	| {
			readonly kind: "create";
			readonly input: BringInInput;
			readonly afterMs: number;
	  };

const NO_ACT: BringInAct = Object.freeze({ kind: "none" });

/** A function of the model alone: nothing it answers depends on which event came last. */
export function nextAct(model: BringInModel): BringInAct {
	const { location, picker } = model;
	if (location.kind === "none") return NO_ACT;
	if (model.signedOut) return NO_ACT;
	if (location.kind === "choose") {
		return picker.apps.kind === "loading" && picker.domain !== null
			? { kind: "list-apps", domain: picker.domain }
			: NO_ACT;
	}
	if (!model.resumeChecked) return NO_ACT;
	if (model.landing !== null) return NO_ACT;
	// One request at a time, a create the person left included: the lines of a
	// stream name no request. The reading screen of the app the person went
	// to says what it waits for (`leftCreate`).
	if (model.call !== null) return NO_ACT;
	if (model.failed !== null) return NO_ACT;
	if (model.lost >= 2) return NO_ACT;
	const afterMs = model.lost === 1 ? LOST_RETRY_MS : 0;
	if (model.pendingCreate !== null)
		return { kind: "create", input: model.pendingCreate, afterMs };
	if (model.refusal !== null && SCREEN_REFUSALS.has(model.refusal))
		return NO_ACT;
	if (model.answer === null)
		return { kind: "read", key: location.key, afterMs };
	return NO_ACT;
}

// ---------------------------------------------------------------------------
// The review's answers
// ---------------------------------------------------------------------------

function preselectedOf(review: ReadingReview): ReadingDeclarationChoice {
	const choice =
		review.runsOn.find((entry) => entry.preselected) ?? review.runsOn[0];
	if (choice === undefined) {
		throw new Error(
			"The review offers no way to run the app at all. A review offers at least one, exactly one of them preselected. Look at lib/deployment/reading/gather.ts::gatherReading, where the choices are computed.",
		);
	}
	return choice;
}

function sameDeclaration(
	choice: ReadingDeclarationChoice,
	held: {
		readonly runsOnlyOn: Platform | null;
		readonly splitDatetime: boolean;
	},
): boolean {
	return (
		choice.runsOnlyOn === held.runsOnlyOn &&
		choice.splitDatetime === held.splitDatetime
	);
}

/** The review's defaults: HQ's name, the preselected choice, and no table answered. */
export function initialAnswers(answer: ReviewAnswer): ReviewAnswers {
	const preselected = preselectedOf(answer.review);
	return {
		reviewDigest: answer.reviewDigest,
		appName: answer.review.appName,
		runsOnlyOn: preselected.runsOnlyOn,
		splitDatetime: preselected.splitDatetime,
		tableChoices: {},
	};
}

/** The tags whose review entry asks a choice and has no answer, in tag order. */
export function unansweredChoices(
	review: ReadingReview,
	answers: ReviewAnswers,
): readonly string[] {
	return review.tables
		.filter(
			(table) =>
				table.choice !== null &&
				!Object.hasOwn(answers.tableChoices, table.tag),
		)
		.map((table) => table.tag);
}

/** The create body: the key, the reading's id, the digest and the answers, name trimmed. */
export function bringInInputOf(
	key: ReadingKey,
	answer: ReviewAnswer,
	answers: ReviewAnswers,
): BringInInput {
	return {
		projectId: key.projectId,
		server: key.server,
		domain: key.domain,
		remoteAppId: key.remoteAppId,
		readingId: answer.readingId,
		reviewDigest: answer.reviewDigest,
		appName: answers.appName.trim(),
		runsOnlyOn: answers.runsOnlyOn,
		splitDatetime: answers.splitDatetime,
		tableChoices: { ...answers.tableChoices },
	};
}

/**
 * The `review.runsOn` entry whose `runsOnlyOn` and `splitDatetime` the
 * answers hold. `initialAnswers`, `carryAnswers` and every `answers` event
 * take both from one entry, so there is always exactly one.
 */
export function chosenDeclaration(
	review: ReadingReview,
	answers: ReviewAnswers,
): ReadingDeclarationChoice {
	const choice = review.runsOn.find((entry) => sameDeclaration(entry, answers));
	if (choice === undefined) {
		throw new Error(
			`The review offers no way to run that matches the answers held (runsOnlyOn ${answers.runsOnlyOn}, splitDatetime ${answers.splitDatetime}). Answers are taken from one entry of review.runsOn at a time. Look at components/bring-in/bringInModel.ts::reduceBringIn, the answers event, and carryAnswers.`,
		);
	}
	return choice;
}

/**
 * What of a person's answers still applies to a review that came back. The
 * name is kept where the person had changed it from `before.appName`, and is
 * `now.appName` otherwise. The pair `(runsOnlyOn, splitDatetime)` is kept
 * where it is still a member of `now.runsOn`, and is the preselected entry's
 * otherwise. Each table answer is kept only where the table's entry in
 * `now.tables` is the entry it was given against in `before.tables` and still
 * offers that answer (`keptTableChoices`), so a table whose consequences
 * moved (another app reading it, other columns going empty) is asked again;
 * the tag is left unanswered otherwise. `dropped` is true where a declaration
 * or a table answer could not be kept.
 */
export function carryAnswers(
	previous: ReviewAnswers,
	before: ReadingReview,
	now: ReadingReview,
	digest: string,
): { readonly answers: ReviewAnswers; readonly dropped: boolean } {
	const kept = now.runsOn.find((entry) => sameDeclaration(entry, previous));
	let dropped = kept === undefined;
	const declaration = kept ?? preselectedOf(now);
	const tables = keptTableChoices(
		before.tables,
		now.tables,
		previous.tableChoices,
	);
	if (tables.dropped) dropped = true;
	const tableChoices = { ...tables.choices };
	return {
		answers: {
			reviewDigest: digest,
			appName:
				previous.appName !== before.appName ? previous.appName : now.appName,
			runsOnlyOn: declaration.runsOnlyOn,
			splitDatetime: declaration.splitDatetime,
			tableChoices,
		},
		dropped,
	};
}

/** A name CommCare HQ holds, or null where it holds an empty one. */
function hqName(name: string | null): string | null {
	return name === null || name.trim() === "" ? null : name;
}

/**
 * CommCare HQ's name for the app, where the page knows one: the review's, the
 * account's, or the chosen row's in a loaded picker. Null otherwise, as on an
 * address opened afresh before its read answers.
 */
export function knownAppName(model: BringInModel): string | null {
	const { answer, carried, picker, location } = model;
	if (answer?.kind === "review") return hqName(answer.review.appName);
	if (answer?.kind === "account" && hqName(answer.appName) !== null)
		return answer.appName;
	if (carried !== null) return hqName(carried.review.appName);
	if (picker.apps.kind !== "loaded" || picker.apps.picker.kind !== "apps")
		return null;
	const list = picker.apps.picker;
	let remoteAppId = picker.remoteAppId;
	if (location.kind === "app") {
		if (
			list.server !== location.key.server ||
			list.domain !== location.key.domain
		)
			return null;
		remoteAppId = location.key.remoteAppId;
	}
	const row = list.apps.find((entry) => entry.remoteAppId === remoteAppId);
	return row === undefined ? null : hqName(row.name);
}

/** The context `circumstanceBlock` fills a block from: the server, the project space, the app. */
export function circumstanceContextOf(
	model: BringInModel,
	serverLabel: string,
	formatDate: (iso: string) => string,
): CircumstanceContext {
	const { location, picker } = model;
	return {
		server: serverLabel,
		space:
			location.kind === "app" ? location.key.domain : (picker.domain ?? ""),
		app: knownAppName(model),
		formatDate,
	};
}

/** How long after the press a create kept in the tab is still sent again: one hour. */
export const BRING_IN_RESUME_WINDOW_MS = 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The create to send again for `key`, from the tab's stored text: its input
 * where the text parses, the input passes `bringInInputSchema`, its four key
 * fields are `key`'s, and it was written less than
 * `BRING_IN_RESUME_WINDOW_MS` before `now`. Null otherwise.
 */
export function resumableCreate(
	raw: string | null,
	key: ReadingKey,
	now: number,
): BringInInput | null {
	if (raw === null) return null;
	let stored: unknown;
	try {
		stored = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(stored)) return null;
	const { at } = stored;
	if (typeof at !== "number" || !Number.isFinite(at)) return null;
	const age = now - at;
	if (age < 0 || age >= BRING_IN_RESUME_WINDOW_MS) return null;
	const parsed = bringInInputSchema.safeParse(stored.input);
	if (!parsed.success || !sameKey(parsed.data, key)) return null;
	return parsed.data;
}

// ---------------------------------------------------------------------------
// A stop's actions
// ---------------------------------------------------------------------------

/** One action a stop offers. Its label is the shared action with that meaning (`stopActionLabel`). */
export type StopAction =
	/** **Open Settings**: a link to `/settings` in a new tab. */
	| { readonly kind: "open-settings" }
	/** **Check again**. */
	| { readonly kind: "check-again" }
	/** **Choose another app**. */
	| { readonly kind: "choose-another-app" }
	/** **Go to your apps**: a link to `/`. */
	| { readonly kind: "go-to-apps" }
	/** **Open {appName}**: a link to `/build/<appId>`. */
	| {
			readonly kind: "open-app";
			readonly appId: string;
			readonly appName: string;
	  };

const OPEN_SETTINGS: StopAction = { kind: "open-settings" };
const CHECK_AGAIN: StopAction = { kind: "check-again" };
const CHOOSE_ANOTHER_APP: StopAction = { kind: "choose-another-app" };
const GO_TO_APPS: StopAction = { kind: "go-to-apps" };

const settingsFirst = (): readonly StopAction[] => [OPEN_SETTINGS, CHECK_AGAIN];
const checkThenChoose = (): readonly StopAction[] => [
	CHECK_AGAIN,
	CHOOSE_ANOTHER_APP,
];
const checkThenApps = (): readonly StopAction[] => [CHECK_AGAIN, GO_TO_APPS];
const chooseThenApps = (): readonly StopAction[] => [
	CHOOSE_ANOTHER_APP,
	GO_TO_APPS,
];

/** The actions of each stop, in order, the first one primary. */
export const STOP_ACTIONS = {
	"not-connected": settingsFirst,
	"key-not-accepted": settingsFirst,
	"key-cannot-reach-space": settingsFirst,
	"plan-lacks-api-access": checkThenChoose,
	"not-a-member": checkThenChoose,
	"cannot-edit-apps": checkThenChoose,
	"cannot-access-apis": checkThenChoose,
	"api-cut-off": checkThenChoose,
	"browser-only": checkThenChoose,
	"cannot-read-organization": checkThenChoose,
	"rate-limited": checkThenApps,
	"hq-unavailable": checkThenApps,
	"hq-gateway-refused": checkThenApps,
	"changed-while-reading": checkThenApps,
	"nova-busy": checkThenApps,
	"app-gone": chooseThenApps,
	"linked-app": chooseThenApps,
	"remote-app": chooseThenApps,
	"app-deleted": checkThenChoose,
	"already-in-nova": (finding: CircumstanceFinding): readonly StopAction[] => {
		const claim = finding.detail.claim;
		return claim?.kind === "open"
			? [
					{ kind: "open-app", appId: claim.appId, appName: claim.appName },
					CHOOSE_ANOTHER_APP,
				]
			: [CHOOSE_ANOTHER_APP, CHECK_AGAIN];
	},
} as const satisfies Record<
	StopCircumstance,
	(finding: CircumstanceFinding) => readonly StopAction[]
>;

/** The actions a stop offers: its row of `STOP_ACTIONS`. */
export function stopActions(
	finding: CircumstanceFinding,
): readonly StopAction[] {
	const code: ReadCircumstance = finding.code;
	if (!isStopCode(code)) {
		throw new Error(
			`The circumstance "${code}" was drawn as a stop, and it is one an account holds, which offers no stop's actions. A stop is answered only as a read's stop or a create's held or changed answer. Look at the caller of stopActions.`,
		);
	}
	return STOP_ACTIONS[code](finding);
}

function isStopCode(code: ReadCircumstance): code is StopCircumstance {
	return Object.hasOwn(STOP_ACTIONS, code);
}

/**
 * The actions of a stop met while choosing: the row's, less Choose another
 * app, which has nothing to act on while no app is read.
 */
export function pickerStopActions(
	finding: CircumstanceFinding,
): readonly StopAction[] {
	return stopActions(finding).filter(
		(action) => action.kind !== "choose-another-app",
	);
}

/** The label a stop's action reads: the shared action of that meaning. */
export function stopActionLabel(action: StopAction): string {
	switch (action.kind) {
		case "open-settings":
			return BRING_IN_ACTIONS.openSettings;
		case "check-again":
			return BRING_IN_ACTIONS.checkAgain;
		case "choose-another-app":
			return BRING_IN_ACTIONS.chooseAnotherApp;
		case "go-to-apps":
			return BRING_IN_ACTIONS.goToYourApps;
		case "open-app":
			return openAppAction(action.appName);
	}
}

// ---------------------------------------------------------------------------
// The account
// ---------------------------------------------------------------------------

const STANDING_ORDER: readonly FindingStanding[] = [
	"not-yet",
	"never",
	"fix-in-hq",
];

function countsByStanding(
	counts: AccountAnswer["counts"],
): Readonly<Record<FindingStanding, number>> {
	return {
		"not-yet": counts.notYet,
		never: counts.never,
		"fix-in-hq": counts.fixInHq,
	};
}

/** Each standing's count that is not zero, as `accountCountPart` says it, joined by " · ". Empty where all three are zero. */
export function countLine(counts: AccountAnswer["counts"]): string {
	const of = countsByStanding(counts);
	return STANDING_ORDER.filter((standing) => of[standing] > 0)
		.map((standing) => accountCountPart(standing, of[standing]))
		.join(" · ");
}

/**
 * The standings whose label the account defines, once each: those it holds a
 * finding of, past the listed limit too, in the labels' order.
 */
export function accountStandings(
	counts: AccountAnswer["counts"],
): readonly FindingStanding[] {
	const of = countsByStanding(counts);
	return STANDING_ORDER.filter((standing) => of[standing] > 0);
}

const NOVA_FAULTS: ReadonlySet<ReadCircumstance> = new Set<ReadCircumstance>(
	NOVA_FAULT_CIRCUMSTANCES,
);

/**
 * `this-time` where every finding is a circumstance of
 * `NOVA_FAULT_CIRCUMSTANCES`, so the heading and lead say "this time"; `yet`
 * for any other list, the empty one included, since a limit Nova has is no
 * fault a second read gets past.
 */
export function accountHeading(
	findings: readonly Finding[],
): "yet" | "this-time" {
	return findings.length > 0 &&
		findings.every(
			(finding) => finding.subject === null && NOVA_FAULTS.has(finding.code),
		)
		? "this-time"
		: "yet";
}

/** The key two places share exactly where they sit under one heading. */
export function placeGroupKey(place: HqPlace): string {
	switch (place.kind) {
		case "app":
		case "app-settings":
		case "languages":
		case "organization":
		case "media":
			return place.kind;
		case "menu":
		case "case-list":
		case "case-detail":
		case "search":
			return `${place.kind}:${place.menu}`;
		case "form":
		case "question":
			return `form:${place.menu}:${place.form}`;
		case "lookup-table":
			return `lookup-table:${place.tag}`;
	}
}

export type AccountItem =
	/** `prefix` is the question's path or the file's path the line begins with, else null. */
	| {
			readonly kind: "finding";
			readonly finding: Finding;
			readonly prefix: string | null;
	  }
	/**
	 * More than twenty findings about questions of one group, of one sentence,
	 * one standing and one name in CommCare HQ, said once.
	 */
	| {
			readonly kind: "fold";
			readonly sentence: string;
			readonly standing: FindingStanding;
			readonly findings: readonly Finding[];
	  };

export interface AccountGroup {
	readonly key: string;
	/** The group's heading. */
	readonly heading: string;
	/** What `hqPlaceUrl` is asked for: the first finding's place, a question's as its form. */
	readonly place: HqPlace;
	readonly items: readonly AccountItem[];
}

/** A run of one sentence folds where a group holds more than this many. */
const FOLD_OVER = 20;

/** The place a group is headed by: a question's form, any other place itself. */
function groupPlace(place: HqPlace): HqPlace {
	if (place.kind !== "question") return place;
	return {
		kind: "form",
		menu: place.menu,
		form: place.form,
		menuName: place.menuName,
		name: place.formName,
	};
}

function prefixOf(place: HqPlace): string | null {
	return place.kind === "question" || place.kind === "media"
		? place.path
		: null;
}

/** What a finding about a question folds by, or null where it never folds. */
function foldKeyOf(finding: Finding): string | null {
	if (finding.subject === null || finding.place.kind !== "question")
		return null;
	const { sentence, named } = findingLine(finding);
	return JSON.stringify([sentence, finding.standing, named]);
}

function itemsOf(findings: readonly Finding[]): readonly AccountItem[] {
	const runs = new Map<string, Finding[]>();
	for (const finding of findings) {
		const key = foldKeyOf(finding);
		if (key === null) continue;
		const run = runs.get(key);
		if (run === undefined) runs.set(key, [finding]);
		else run.push(finding);
	}
	const items: AccountItem[] = [];
	const said = new Set<string>();
	for (const finding of findings) {
		const key = foldKeyOf(finding);
		const run = key === null ? undefined : runs.get(key);
		if (key === null || run === undefined || run.length <= FOLD_OVER) {
			items.push({ kind: "finding", finding, prefix: prefixOf(finding.place) });
			continue;
		}
		if (said.has(key)) continue;
		said.add(key);
		items.push({
			kind: "fold",
			sentence: findingLine(finding).sentence,
			standing: finding.standing as FindingStanding,
			findings: run,
		});
	}
	return items;
}

/**
 * One group for each distinct `placeGroupKey`, in the order each key first
 * appears in `findings`, each keeping the answer's order within it, and each
 * run of more than twenty findings of one sentence about its questions
 * folded into one item.
 */
export function accountGroups(
	findings: readonly Finding[],
): readonly AccountGroup[] {
	const groups = new Map<
		string,
		{ readonly place: HqPlace; readonly findings: Finding[] }
	>();
	for (const finding of findings) {
		const key = placeGroupKey(finding.place);
		const group = groups.get(key);
		if (group === undefined)
			groups.set(key, {
				place: groupPlace(finding.place),
				findings: [finding],
			});
		else group.findings.push(finding);
	}
	return Array.from(groups, ([key, group]) => ({
		key,
		heading:
			group.place.kind === "media"
				? ACCOUNT_MEDIA_GROUP_HEADING
				: placeLine(group.place),
		place: group.place,
		items: itemsOf(group.findings),
	}));
}

/** One finding of the copied list, as its lines. */
function findingText(
	finding: Finding,
	context: CircumstanceContext,
): readonly string[] {
	const prefix = prefixOf(finding.place);
	const label =
		FINDING_LABELS[finding.standing as FindingStanding] +
		(prefix === null ? "" : ` (${prefix})`);
	const { sentence, named } = findingLine(finding);
	if (finding.subject !== null) {
		return [
			`- ${label}: ${sentence}${named === null ? "" : ` ${NAMED_IN_HQ_LEAD} ${named}.`}`,
		];
	}
	const block = circumstanceBlock(finding, context);
	return [
		`- ${label}: ${block.title}`,
		`  ${block.body}`,
		...(named === null ? [] : [`  ${NAMED_IN_HQ_LEAD} ${named}`]),
		`  ${block.next}`,
	];
}

/**
 * The whole account as plain text. `context` is the one the screen's blocks
 * are built from, and `date` the day the read answered, already in the
 * reader's locale. Every finding is written, folded on screen or not, and the
 * text ends with `ACCOUNT_CHECK_AGAIN_LINE`, so no copied list reads as
 * complete.
 */
export function accountAsText(
	answer: AccountAnswer,
	context: CircumstanceContext,
	date: string,
): string {
	const heading = accountHeadingLine(
		accountHeading(answer.findings),
		answer.appName,
	);
	const lines: string[] = [accountTextFirstLine(heading, context.space, date)];
	const counts = countLine(answer.counts);
	if (counts !== "") lines.push(counts);
	for (const group of accountGroups(answer.findings)) {
		lines.push("", group.heading);
		for (const item of group.items) {
			const findings = item.kind === "fold" ? item.findings : [item.finding];
			for (const finding of findings)
				lines.push(...findingText(finding, context));
		}
	}
	lines.push("");
	if (answer.more > 0) lines.push(moreFindingsLine(answer.more));
	if (!answer.mediaChecked) lines.push(MEDIA_CHECKED_LATER);
	lines.push(ACCOUNT_CHECK_AGAIN_LINE);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Where workers use this app
// ---------------------------------------------------------------------------

export interface DeclarationRow {
	readonly choice: ReadingDeclarationChoice;
	/** `PLATFORM_DECLARATION_LABELS[choice.runsOnlyOn ?? "both"]`. */
	readonly label: string;
	/** `PLATFORM_DECLARATION_LINES[choice.runsOnlyOn ?? "both"]`. */
	readonly line: string;
	/** `splitDatetimeLine` over `review.datetimeQuestions` where the choice splits, else null. */
	readonly splitLine: string | null;
}

/** One row for each entry of `review.runsOn`, in its order. */
export function declarationRows(
	review: ReadingReview,
): readonly DeclarationRow[] {
	return review.runsOn.map((choice) => ({
		choice,
		label: PLATFORM_DECLARATION_LABELS[choice.runsOnlyOn ?? "both"],
		line: PLATFORM_DECLARATION_LINES[choice.runsOnlyOn ?? "both"],
		splitLine: choice.splitDatetime
			? splitDatetimeLine(review.datetimeQuestions)
			: null,
	}));
}

export interface DeclarationWhy {
	/** Why Nova chose the preselected row, by `review.runsOnWhy`. */
	readonly why: string;
	/** That the first publish asks before changing Web Apps, where the chosen row differs from CommCare HQ's setting; else null. */
	readonly firstPublishAsks: string | null;
	/** `platformOutBlock` of each entry of `review.platformsOut`, in its order. */
	readonly cannotRun: readonly ReturnType<typeof platformOutBlock>[];
	/** That the choice can change later in App settings. */
	readonly later: string;
}

/** The lines under the platform choice, for the declaration the answers hold. */
export function declarationWhy(
	review: ReadingReview,
	answers: ReviewAnswers,
): DeclarationWhy {
	const chosen = chosenDeclaration(review, answers);
	const runsInWebApps = chosen.runsOnlyOn !== "android";
	const firstPublishAsks =
		!runsInWebApps && review.webAppsOnInHq
			? REVIEW_WEB_APPS_ASKS_OFF
			: runsInWebApps && !review.webAppsOnInHq
				? REVIEW_WEB_APPS_ASKS_ON
				: null;
	return {
		why: REVIEW_RUNS_ON_WHY[review.runsOnWhy],
		firstPublishAsks,
		cannotRun: review.platformsOut.map(platformOutBlock),
		later: REVIEW_CHANGE_LATER,
	};
}

// ---------------------------------------------------------------------------
// What a create that did not create says above its screen
// ---------------------------------------------------------------------------

/**
 * Where the answer on screen came from: a create that did not create where
 * the model holds its lead, the read a `read-again` asks for included, since
 * the lead stands above what that read answers; a read otherwise. A screen
 * drawn from a create says "No app was created" where a read's says "Nothing
 * was created".
 */
export function answerSourceOf(model: BringInModel): BringInAnswerSource {
	return model.lead === null ? "read" : "create";
}

const CREATE_LEAD_LINES: Readonly<Record<CreateLead, string>> = {
	"changed-review": CREATE_ANSWER_LEADS.changed.review,
	"changed-account": CREATE_ANSWER_LEADS.changed.account,
	"changed-stop": CREATE_ANSWER_LEADS.changed.stop,
	"changed-already-in-nova": CREATE_ANSWER_LEADS.changed["already-in-nova"],
	"read-again": CREATE_ANSWER_LEADS["read-again"],
	"check-failed": CREATE_ANSWER_LEADS["check-failed"],
	held: CREATE_ANSWER_LEADS.held,
};

/**
 * The sentence above what a create that did not create carries, followed by
 * the one that says some choices were made again where an answer could not
 * be kept.
 */
export function createLeadLine(
	lead: NonNullable<BringInModel["lead"]>,
): string {
	const line = CREATE_LEAD_LINES[lead.kind];
	return lead.dropped ? `${line} ${CREATE_ANSWER_LEADS.choicesDropped}` : line;
}

// ---------------------------------------------------------------------------
// The review: the name, the Project, the tables, the files, Bring it in
// ---------------------------------------------------------------------------

/** The most characters an app's name holds once trimmed, as the create checks it. */
export const APP_NAME_MAX_LENGTH = 255;

/**
 * The Project an app's address adds it to, from the Projects the page was
 * handed. Null where the page's list does not hold it: a role granted after
 * the page loaded, which a reload hands down.
 */
export function reviewProjectOf<
	Project extends { readonly id: string; readonly name: string },
>(projects: readonly Project[], key: ReadingKey): Project | null {
	return projects.find((project) => project.id === key.projectId) ?? null;
}

/** The counts of what comes in: menus, forms, questions and languages. */
export function reviewCounts(review: ReadingReview): string {
	return reviewCountsLine({
		menus: review.creates.menus,
		forms: review.creates.forms,
		questions: review.creates.questions,
		languages: review.creates.languages.length,
	});
}

/** One piece of a sentence that sets names apart: its text, and whether it is a name. */
export interface SentencePart {
	readonly text: string;
	readonly mono: boolean;
}

/* Marks a sentence's names by position while the sentence is built, so the
 * names are found again without reading the sentence's words. Private-use
 * characters, which no copy holds. */
const NAME_OPEN = "";
const NAME_CLOSE = "";

/**
 * `sentence` over `names`, cut into the words around each name and the names
 * themselves, so a screen can set each name in monospace. The parts joined
 * are exactly `sentence(names)`.
 */
export function sentenceWithNames(
	sentence: (names: readonly string[]) => string,
	names: readonly string[],
): readonly SentencePart[] {
	const marked = sentence(
		names.map((_, index) => `${NAME_OPEN}${index}${NAME_CLOSE}`),
	);
	const changed = () =>
		new Error(
			"A sentence that sets names apart changed a name's mark while it was built. The sentence function has to place each name it is given, once and as it is given. Look at the caller of sentenceWithNames.",
		);
	const words = (text: string): SentencePart => {
		if (text.includes(NAME_OPEN) || text.includes(NAME_CLOSE)) throw changed();
		return { text, mono: false };
	};
	const parts: SentencePart[] = [];
	const placed = new Set<number>();
	let rest = marked;
	while (rest.length > 0) {
		const open = rest.indexOf(NAME_OPEN);
		if (open === -1) {
			parts.push(words(rest));
			break;
		}
		if (open > 0) parts.push(words(rest.slice(0, open)));
		const close = rest.indexOf(NAME_CLOSE, open);
		const index = close === -1 ? -1 : Number(rest.slice(open + 1, close));
		const name = names[index];
		if (name === undefined || placed.has(index)) throw changed();
		parts.push({ text: name, mono: true });
		placed.add(index);
		rest = rest.slice(close + 1);
	}
	if (placed.size !== names.length) throw changed();
	return parts;
}

export interface ReviewTablesView {
	/**
	 * The line naming the tables that come in managed in CommCare HQ, each tag
	 * set apart; null where there are none.
	 */
	readonly managed: readonly SentencePart[] | null;
	/** One line for each table already in the Project with the same columns and rows. */
	readonly sameEqual: readonly string[];
	/** The tables that ask the person to choose, in the review's order. */
	readonly choices: readonly ReviewTable[];
}

/** The lookup tables' section, or null where the app reads none and the section is not drawn. */
export function reviewTablesView(
	review: ReadingReview,
	project: string,
	domain: string,
): ReviewTablesView | null {
	if (review.tables.length === 0) return null;
	const managedTags = review.tables
		.filter(
			(table) => table.standing === "new" || table.standing === "same-managed",
		)
		.map((table) => table.tag);
	return {
		managed:
			managedTags.length === 0
				? null
				: sentenceWithNames(
						(tags) => reviewManagedTables(tags, domain),
						managedTags,
					),
		sameEqual: review.tables
			.filter((table) => table.standing === "same-equal")
			.map((table) => reviewSameEqualTable(table.tag, project, domain)),
		choices: review.tables.filter((table) => table.standing === "choice"),
	};
}

export interface TableChoiceRow {
	readonly choice: LookupTableChoice;
	readonly label: string;
	/** What the answer does, each a line of the row. */
	readonly lines: readonly string[];
	/** Why the answer cannot be chosen; null where it can. */
	readonly unavailableReason: string | null;
}

export interface TableChoiceView {
	readonly tag: string;
	readonly legend: string;
	readonly body: string;
	/** CommCare HQ's table, then the Project's. */
	readonly rows: readonly TableChoiceRow[];
	/**
	 * The line Bring it in found this table unanswered with: that it needs a
	 * choice, or, where neither answer can be chosen, that neither is open.
	 * Null while the table is not the one named.
	 */
	readonly alert: string | null;
	/**
	 * The line beside the action to choose another Project: the alternative to
	 * the choice where an answer can be chosen, or that neither is open where
	 * none can and the alert does not already say so. Null where it does.
	 */
	readonly otherProject: string | null;
}

/**
 * One table whose tag meets a Project table, as its group draws it. Neither
 * answer is chosen for the person. `unanswered` is true where Bring it in
 * found this table without an answer.
 */
export function tableChoiceView(
	table: ReviewTable,
	project: string,
	domain: string,
	unanswered: boolean,
): TableChoiceView {
	const { choice } = table;
	if (choice === null) {
		throw new Error(
			`The lookup table ${table.tag} was drawn as a choice, and its review entry asks none. Only a table whose standing is "choice" carries one. Look at the caller of tableChoiceView.`,
		);
	}
	const fromHq = choice.options["use-commcare-hq"];
	const own = choice.options["use-project"];
	const hqLines = [
		hqTableAnswerConsequence(project, table.tag, choice.apps),
		...(fromHq.offered
			? [
					columnsBecomeText(fromHq.retypedColumns),
					hqTableAnswerGoneColumns(choice.apps, fromHq.goneColumns),
				]
			: []),
	].filter((line): line is string => line !== null);
	const open = fromHq.offered || own.offered;
	return {
		tag: table.tag,
		legend: reviewChoiceTitle(table.tag, project, choice),
		body: reviewChoiceBody(table.tag, project, domain, choice),
		rows: [
			{
				choice: "use-commcare-hq",
				label: HQ_TABLE_ANSWER,
				lines: hqLines,
				unavailableReason: fromHq.offered
					? null
					: choiceNotOffered(fromHq, project),
			},
			{
				choice: "use-project",
				label: projectTableAnswer(project),
				lines: [projectTableAnswerConsequence(project, domain)],
				unavailableReason: own.offered ? null : choiceNotOffered(own, project),
			},
		],
		alert: !unanswered
			? null
			: open
				? REVIEW_CHOICE_MISSING
				: REVIEW_NO_CHOICE_OPEN,
		otherProject: open
			? CHOICE_OTHER_PROJECT
			: unanswered
				? null
				: REVIEW_NO_CHOICE_OPEN,
	};
}

/** The places' line, or null where the app's logic reads no place and the section is not drawn. */
export function reviewPlacesLine(
	review: ReadingReview,
	domain: string,
): string | null {
	return review.places === null
		? null
		: reviewManagedPlaces(review.places.count, domain);
}

/**
 * The pictures and sounds' lines: the files added to the Project, then the
 * references left out, each where it counts one. Empty where there are
 * neither, and the section is not drawn.
 */
export function reviewMediaLines(
	review: ReadingReview,
	project: string,
): readonly string[] {
	return [
		...(review.creates.mediaFiles > 0
			? [reviewMediaAdded(review.creates.mediaFiles, project)]
			: []),
		...(review.mediaLeftOut > 0
			? [reviewMediaLeftOut(review.mediaLeftOut)]
			: []),
	];
}

/**
 * The line naming the plan features Nova records as already in use under the
 * chosen declaration, or null where it records none.
 */
export function recordedFeaturesLine(
	choice: ReadingDeclarationChoice,
	domain: string,
): string | null {
	const labels = choice.recordedFeatures.flatMap((key) =>
		key.kind === "plan-feature" ? [PLAN_FEATURES[key.subject].label] : [],
	);
	return labels.length === 0
		? null
		: adoptionRecordedFeaturesLine(labels, domain);
}

/**
 * The line naming what address search in Web Apps needs of the project
 * space under the chosen declaration, or null where no question searches.
 */
export function addressSearchLine(
	choice: ReadingDeclarationChoice,
	domain: string,
): string | null {
	return choice.addressSearch?.length ? addressSearchReviewLine(domain) : null;
}

/** Where the review shows a create's refusal: under the name, above the footer, or not at all. */
const REVIEW_REFUSAL_AT = {
	name_missing: "name",
	choice_not_offered: "footer",
	choice_missing: "footer",
	project_changed: "footer",
	no_project_access: null,
	invalid_input: null,
	app_unavailable: null,
	publish_in_flight: "footer",
} as const satisfies Record<ReadingRefusal, "name" | "footer" | null>;

/**
 * Where the review shows the refusal the model holds: the name field's
 * error, a line above the footer, or nowhere, for a refusal the `refused`
 * screen shows in the review's place.
 */
export function reviewRefusalAt(
	refusal: ReadingRefusal | null,
): "name" | "footer" | null {
	return refusal === null ? null : REVIEW_REFUSAL_AT[refusal];
}

/** What pressing Bring it in does. */
export type ReviewPress =
	/** The name is empty once trimmed, or longer than a name holds: the field says so. Nothing is sent. */
	| { readonly kind: "name" }
	/** The first table whose choice has no answer: its group says so. Nothing is sent. */
	| { readonly kind: "choice"; readonly tag: string }
	/** Every answer is given: the create to send. */
	| { readonly kind: "create"; readonly input: BringInInput };

/**
 * Bring it in, checked in the browser in the order the create checks it, so
 * nobody waits on a round trip to learn what the screen already knows: the
 * name, then each table's choice, then the create's body.
 */
export function reviewPress(
	key: ReadingKey,
	answer: ReviewAnswer,
	answers: ReviewAnswers,
): ReviewPress {
	const name = answers.appName.trim();
	if (name.length === 0 || name.length > APP_NAME_MAX_LENGTH)
		return { kind: "name" };
	const [tag] = unansweredChoices(answer.review, answers);
	if (tag !== undefined) return { kind: "choice", tag };
	return { kind: "create", input: bringInInputOf(key, answer, answers) };
}
