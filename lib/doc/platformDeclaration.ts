/**
 * The declaration a document's content allows: the one planner that gives an
 * app the platforms its content other than media runs on, splitting each
 * date-and-time question where that is the only way the app runs anywhere.
 *
 * It reads every platform feature use (`lib/domain/platformUses.ts`) and the
 * table's readings (`lib/domain/platforms.ts`): with W the features whose uses
 * Web Apps can't run and A those Android can't,
 *
 *   - a document that already declares is left as it is;
 *   - W and A empty is both, the absent key;
 *   - W alone is Android only, A alone Web Apps only;
 *   - both, where W is exactly the date-and-time question, is Web Apps only
 *     with every date-and-time question split (`datetimeSplit.ts`), since the
 *     split's two questions run on both;
 *   - both otherwise runs on neither, which only the author can resolve.
 *
 * A Connect app's `connect-app` is in W, so a Connect app is declared Android
 * only and its date-and-time questions are never split.
 *
 * The planner returns mutations and never runs the validator: each caller
 * gates the candidate. The fuzz mapping and test fixtures reach it through
 * `declaredForContent`, which applies a `declared` plan and throws on any
 * other.
 */
import { Immer, produce } from "immer";
import {
	type BlueprintDoc,
	PLATFORM_FEATURE_IDS,
	PLATFORM_FEATURES,
	PLATFORMS,
	type Platform,
	type PlatformFeatureId,
	type PlatformFeatureUse,
	type Uuid,
	unavailablePlatform,
	unavailableUses,
} from "@/lib/domain";
import { type DatetimeSplit, planDatetimeSplits } from "./datetimeSplit";
import { applyMutations } from "./mutations";
import type { Mutation } from "./types";

export type ContentDeclarationPlan =
	| {
			readonly kind: "declared";
			/** The declaration the content allows; undefined is Web Apps and Android. */
			readonly runsOnlyOn: Platform | undefined;
			/** The feature ids of the uses the other platform can't run, for the notice. */
			readonly causes: readonly PlatformFeatureId[];
			/** `setAppSettings` first where the declaration changes, then every split's mutations. */
			readonly mutations: readonly Mutation[];
			/** One entry per split question: its uuid, the two new uuids and ids. */
			readonly splits: readonly DatetimeSplit[];
	  }
	| {
			readonly kind: "runs-on-neither";
			readonly webAppsUnavailable: readonly PlatformFeatureId[];
			readonly androidUnavailable: readonly PlatformFeatureId[];
	  }
	| {
			readonly kind: "split-refused";
			readonly fieldUuid: Uuid;
			readonly reason: "self-read-through-a-filter";
	  };

/** The feature ids among `used` that read `unavailable` on `platform`, in
 * `PLATFORM_FEATURE_IDS` order. */
function unavailableOn(
	used: ReadonlySet<PlatformFeatureId>,
	platform: Platform,
): PlatformFeatureId[] {
	return PLATFORM_FEATURE_IDS.filter(
		(id) =>
			used.has(id) &&
			(platform === "web-apps"
				? PLATFORM_FEATURES[id].webApps
				: PLATFORM_FEATURES[id].android
			).reading === "unavailable",
	);
}

function declaring(runsOnlyOn: Platform): Mutation {
	return { kind: "setAppSettings", settings: { runsOnlyOn } };
}

/** The declaration `doc`'s content other than media allows, with the
 * mutations that write it. */
export function planContentDeclaration(
	doc: BlueprintDoc,
): ContentDeclarationPlan {
	if (doc.appSettings.runsOnlyOn !== undefined)
		return {
			kind: "declared",
			runsOnlyOn: doc.appSettings.runsOnlyOn,
			causes: [],
			mutations: [],
			splits: [],
		};
	const used = new Set(
		unavailableUses(doc, PLATFORMS).map((use) => use.feature),
	);
	const webApps = unavailableOn(used, "web-apps");
	const android = unavailableOn(used, "android");
	if (webApps.length === 0 && android.length === 0)
		return {
			kind: "declared",
			runsOnlyOn: undefined,
			causes: [],
			mutations: [],
			splits: [],
		};
	if (android.length === 0)
		return {
			kind: "declared",
			runsOnlyOn: "android",
			causes: webApps,
			mutations: [declaring("android")],
			splits: [],
		};
	if (webApps.length === 0)
		return {
			kind: "declared",
			runsOnlyOn: "web-apps",
			causes: android,
			mutations: [declaring("web-apps")],
			splits: [],
		};
	if (webApps.length !== 1 || webApps[0] !== "datetime-question")
		return {
			kind: "runs-on-neither",
			webAppsUnavailable: webApps,
			androidUnavailable: android,
		};
	const split = planDatetimeSplits(doc);
	if (!split.ok)
		return {
			kind: "split-refused",
			fieldUuid: split.fieldUuid,
			reason: "self-read-through-a-filter",
		};
	return {
		kind: "declared",
		runsOnlyOn: "web-apps",
		causes: android,
		mutations: [declaring("web-apps"), ...split.mutations],
		splits: split.splits,
	};
}

/** The applier leaves its result as mutable as the document it was given:
 * a fuzz draw goes on to `fuzzSample.ts::afterDraw`, which edits it in
 * place. */
const UNFROZEN = new Immer({ autoFreeze: false });

/** A document whose content no declaration admits as it stands. */
export class PlatformDeclarationBlocked extends Error {
	constructor(
		readonly plan: Exclude<ContentDeclarationPlan, { kind: "declared" }>,
	) {
		super(
			plan.kind === "runs-on-neither"
				? `This document's content runs on neither platform: Web Apps can't run ${plan.webAppsUnavailable.join(", ")}, and Android can't run ${plan.androidUnavailable.join(", ")}. Take out one platform's uses, or give the document the declaration it should keep.`
				: `This document runs on neither platform until its date-and-time questions are split, and the split of field ${plan.fieldUuid} is refused (${plan.reason}). Write the question's own rule over "." and try again.`,
		);
		this.name = "PlatformDeclarationBlocked";
	}
}

/** `doc` with `planContentDeclaration(doc)`'s mutations applied
 *  (`applyMutations` in one draft); throws `PlatformDeclarationBlocked`,
 *  naming the plan's kind and its blocking feature ids or field, on any kind
 *  but `declared`. Deterministic and idempotent. */
export function declaredForContent(doc: BlueprintDoc): BlueprintDoc {
	// The split planner applies each split to a working copy with Immer, which
	// freezes what the copy shares with its source; planning over a clone
	// keeps the given document as mutable as it came.
	const plan = planContentDeclaration(structuredClone(doc));
	if (plan.kind !== "declared") throw new PlatformDeclarationBlocked(plan);
	if (plan.mutations.length === 0) return doc;
	return UNFROZEN.produce(doc, (draft) => {
		applyMutations(draft, plan.mutations);
	});
}

/** One declaration a document's content runs on, with the mutations that write it. */
export interface DeclarationChoice {
	/** Undefined is Web Apps and Android. */
	readonly runsOnlyOn: Platform | undefined;
	/** Whether every date-and-time question is split (`datetimeSplit.ts`). */
	readonly split: boolean;
	/** `setAppSettings` where `runsOnlyOn` is defined, then each split's mutations. */
	readonly mutations: readonly Mutation[];
	readonly splits: readonly DatetimeSplit[];
}

export type DeclarationChoices =
	| {
			readonly kind: "choices";
			readonly choices: readonly DeclarationChoice[];
			/** Index of the proposed choice. */
			readonly proposed: number;
			/** True where HQ holds Web Apps off and the proposal is narrower than the content needs. */
			readonly narrowedByHq: boolean;
			/** True where HQ holds Web Apps on and the proposal splits date-and-time questions to keep it. */
			readonly keepsWebApps: boolean;
	  }
	| {
			readonly kind: "none";
			/** Every use some platform cannot run, with that platform. */
			readonly blocking: readonly {
				readonly use: PlatformFeatureUse;
				readonly platform: Platform;
			}[];
			/** The question whose split is refused, where that is why no choice runs. */
			readonly splitRefused?: Uuid;
	  };

/** The platforms a declaration runs the app on. */
function declared(runsOnlyOn: Platform | undefined): readonly Platform[] {
	return runsOnlyOn === undefined ? PLATFORMS : [runsOnlyOn];
}

/**
 * Every declaration `doc`'s content runs on, with and without the
 * date-and-time split, and the one to propose, over a document that declares
 * nothing (its own declaration is not read).
 *
 * The candidates, in order: both platforms, Android only, Web Apps only, then,
 * where the document holds a date-and-time question and every one splits,
 * both with the split and Web Apps only with the split. A candidate runs where
 * no use of its document (the split's mutations applied) is unavailable on a
 * platform it declares. The choices are the candidates that run, less a split
 * candidate whose unsplit twin runs, and less Web Apps only with the split
 * where both with the split runs. With Web Apps off in HQ the proposal is
 * Android only where it runs, else the first choice; with Web Apps on, the
 * first choice that declares Web Apps, else the first choice, so the proposal
 * never turns off a platform the project space serves while a choice keeps it.
 */
export function planDeclarationChoices(
	doc: BlueprintDoc,
	options: {
		readonly webAppsOnInHq: boolean;
		/** Platforms excluded by a Project data reference the document holds by identity. */
		readonly unavailableDataPlatforms?: ReadonlySet<Platform>;
	},
): DeclarationChoices {
	const holdsDatetime = Object.values(doc.fields).some(
		(field) => field.kind === "datetime",
	);
	// The split planner and the draft below share structure with the document
	// they are given and freeze it; planning over a clone leaves the caller's
	// document as mutable as it came, as `declaredForContent` does.
	const working = holdsDatetime ? structuredClone(doc) : doc;
	const splitPlan = holdsDatetime ? planDatetimeSplits(working) : undefined;
	const split =
		splitPlan?.ok === true
			? {
					mutations: splitPlan.mutations,
					splits: splitPlan.splits,
					doc: produce(working, (draft) => {
						applyMutations(draft, splitPlan.mutations);
					}),
				}
			: undefined;
	const candidate = (
		runsOnlyOn: Platform | undefined,
		splitting: boolean,
	): DeclarationChoice & { readonly runs: boolean } => {
		const over = splitting && split !== undefined ? split.doc : doc;
		return {
			runsOnlyOn,
			split: splitting,
			mutations: [
				...(runsOnlyOn === undefined ? [] : [declaring(runsOnlyOn)]),
				...(splitting && split !== undefined ? split.mutations : []),
			],
			splits: splitting && split !== undefined ? split.splits : [],
			runs:
				!declared(runsOnlyOn).some((platform) =>
					options.unavailableDataPlatforms?.has(platform),
				) && unavailableUses(over, declared(runsOnlyOn)).length === 0,
		};
	};
	const both = candidate(undefined, false);
	const android = candidate("android", false);
	const webApps = candidate("web-apps", false);
	const splitCandidates =
		split === undefined
			? []
			: [candidate(undefined, true), candidate("web-apps", true)];
	const bothSplit = splitCandidates[0];
	const choices = [both, android, webApps, ...splitCandidates].filter(
		(choice) => {
			if (!choice.runs) return false;
			if (!choice.split) return true;
			const twin = choice.runsOnlyOn === undefined ? both : webApps;
			if (twin.runs) return false;
			return !(choice.runsOnlyOn === "web-apps" && bothSplit?.runs === true);
		},
	);
	if (choices.length === 0) {
		const blocking = unavailableUses(doc, PLATFORMS).flatMap((use) =>
			PLATFORMS.filter(
				(platform) =>
					unavailablePlatform(use.feature, [platform]) !== undefined,
			).map((platform) => ({ use, platform })),
		);
		return {
			kind: "none",
			blocking,
			...(splitPlan?.ok === false &&
			splitPlan.reason === "self-read-through-a-filter"
				? { splitRefused: splitPlan.fieldUuid }
				: {}),
		};
	}
	const firstWhere = (test: (choice: DeclarationChoice) => boolean) =>
		choices.findIndex(test);
	const androidOnly = firstWhere(
		(choice) => choice.runsOnlyOn === "android" && !choice.split,
	);
	let proposed: number;
	let narrowedByHq = false;
	if (!options.webAppsOnInHq) {
		proposed = Math.max(androidOnly, 0);
		narrowedByHq = androidOnly >= 0 && both.runs;
	} else {
		const keeping = firstWhere((choice) => choice.runsOnlyOn !== "android");
		proposed = Math.max(keeping, 0);
	}
	const proposal = choices[proposed];
	const keepsWebApps =
		options.webAppsOnInHq &&
		proposal?.split === true &&
		androidOnly >= 0 &&
		androidOnly < proposed;
	return {
		kind: "choices",
		choices: choices.map(({ runs: _runs, ...choice }) => choice),
		proposed,
		narrowedByHq,
		keepsWebApps,
	};
}
