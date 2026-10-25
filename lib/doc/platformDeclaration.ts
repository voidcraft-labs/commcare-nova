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
import { Immer } from "immer";
import {
	type BlueprintDoc,
	PLATFORM_FEATURE_IDS,
	PLATFORM_FEATURES,
	PLATFORMS,
	type Platform,
	type PlatformFeatureId,
	type Uuid,
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

/** The feature ids of `doc`'s uses that read `unavailable` on `platform`,
 * once each, in `PLATFORM_FEATURE_IDS` order. */
function unavailableOn(
	doc: BlueprintDoc,
	platform: Platform,
): PlatformFeatureId[] {
	const used = new Set(
		unavailableUses(doc, PLATFORMS)
			.map((use) => use.feature)
			.filter(
				(feature) =>
					(platform === "web-apps"
						? PLATFORM_FEATURES[feature].webApps
						: PLATFORM_FEATURES[feature].android
					).reading === "unavailable",
			),
	);
	return PLATFORM_FEATURE_IDS.filter((id) => used.has(id));
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
	const webApps = unavailableOn(doc, "web-apps");
	const android = unavailableOn(doc, "android");
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
