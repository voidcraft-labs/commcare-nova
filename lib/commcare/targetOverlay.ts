/**
 * Meet one generated app with the app a CommCare HQ target holds.
 *
 * HQ's import replaces every top-level key an update's body carries and
 * keeps every key it leaves out (`models/applications.py::
 * _merge_source_into_app`). Three keys hold Nova's values beside the
 * target's own: `translations`, `add_ons` and `profile`. Each is projected
 * here from one read of the app's source, the publish's last read before
 * its import: Nova's part carries Nova's values, the target's part carries
 * the read's, and a key whose result equals the read is left out of the
 * body, so HQ keeps what it holds there.
 *
 * - `translations`: per language, the target's keys (`appStringKeys.ts`)
 *   kept verbatim, and Nova's values for its own. A generated key HQ holds
 *   is dropped, since it would name the wrong menu or form after a rename,
 *   as is the name of a language the app no longer has.
 * - `add_ons`: the needed slugs `true` over the target's map. Nova never
 *   writes `false`.
 * - `profile`: the two settings Nova holds always at Nova's value; the
 *   fifteen seeded constants (`appProfileSettings.ts`) only where the target
 *   holds no value; the derived custom property as the target's Search
 *   advisory allows; every other key and section kept.
 *
 * Beside the body it returns the ownership descriptor the drift baseline
 * records: what Nova owns inside the three keys, read from what Nova set
 * and never from the body's bytes, which carry the target's values too.
 *
 * Pure: no I/O.
 */

import { canonicalJsonText } from "@/lib/utils/canonicalJsonText";
import {
	OWNED_PROFILE_PROPERTY_KEYS,
	SEEDED_PROFILE_PROPERTIES,
} from "./appProfileSettings";
import { translationKeyOwner } from "./appStringKeys";
import { NOVA_OWNED_DERIVED_PROFILE_PROPERTY_KEYS } from "./derivedProfile";
import type { HqAppSource } from "./hq/appSource";
import type { HqApplication, HqApplicationProfile } from "./types";

/** How this app's derived Search profile intent meets one HQ target. */
export type DerivedProfileTargetState =
	| "not-needed"
	| "available"
	| "missing"
	| "unverified";

/**
 * What Nova owns inside the keys HQ holds beside Nova's own. Structurally
 * `lib/deployment/types.ts::AppOwnership`.
 */
export interface TargetOwnership {
	readonly addOns: readonly string[];
	readonly profileProperties: readonly string[];
	readonly profileCustomProperties: readonly string[];
	readonly autoGpsCapture: boolean;
}

type Translations = Record<string, Record<string, string>>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameJson(left: unknown, right: unknown): boolean {
	return canonicalJsonText(left) === canonicalJsonText(right);
}

/** A value HQ's build writes nothing for: absent, `null` or `""`. */
function holdsNoValue(bag: Record<string, unknown>, key: string): boolean {
	return !Object.hasOwn(bag, key) || bag[key] === null || bag[key] === "";
}

/**
 * The `translations` an update sends, or `undefined` where it equals the
 * target's. Its languages are Nova's and every one the target holds, and an
 * entry left with no key is left out.
 */
export function projectTranslationsForTarget(
	application: Pick<HqApplication, "langs" | "translations">,
	current: Pick<HqAppSource, "langs" | "translations">,
): Translations | undefined {
	const codes = new Set([...application.langs, ...current.langs]);
	const languages = [
		...new Set([
			...application.langs,
			...Object.keys(application.translations ?? {}),
			...Object.keys(current.translations),
		]),
	];
	const projected: Translations = {};
	for (const language of languages) {
		const entry: Record<string, string> = {};
		for (const [key, value] of Object.entries(
			current.translations[language] ?? {},
		)) {
			if (translationKeyOwner(key, codes) === "target") entry[key] = value;
		}
		for (const [key, value] of Object.entries(
			application.translations?.[language] ?? {},
		)) {
			if (value !== "") entry[key] = value;
		}
		if (Object.keys(entry).length > 0) projected[language] = entry;
	}
	return sameJson(projected, current.translations) ? undefined : projected;
}

/**
 * The `add_ons` an update sends, or `undefined` where it equals the
 * target's: the target's map with every needed slug `true`.
 */
export function projectAddOnsForTarget(
	application: Pick<HqApplication, "add_ons">,
	current: Pick<HqAppSource, "addOns">,
): Record<string, boolean> | undefined {
	const projected: Record<string, boolean> = { ...current.addOns };
	for (const slug of neededAddOns(application)) projected[slug] = true;
	return sameJson(projected, current.addOns) ? undefined : projected;
}

/** The slugs the generated body sets, which are exactly the ones it needs. */
function neededAddOns(
	application: Pick<HqApplication, "add_ons">,
): readonly string[] {
	return Object.entries(application.add_ons ?? {})
		.filter(([, on]) => on)
		.map(([slug]) => slug);
}

/** The derived custom properties the generated body carries. */
function derivedProperties(
	application: Pick<HqApplication, "profile">,
): Readonly<Record<string, string>> {
	const generated = application.profile?.custom_properties ?? {};
	return Object.fromEntries(
		NOVA_OWNED_DERIVED_PROFILE_PROPERTY_KEYS.flatMap((key) => {
			const value = generated[key];
			return Object.hasOwn(generated, key) && typeof value === "string"
				? [[key, value]]
				: [];
		}),
	);
}

const SEEDED_KEYS: ReadonlySet<string> = new Set(
	SEEDED_PROFILE_PROPERTIES.map(({ key }) => key),
);

/**
 * The `profile` an update sends, or `undefined` where it equals the
 * target's.
 *
 * `properties`: each of the two settings Nova holds at Nova's value; each
 * seeded constant at the target's value where it holds one, else Nova's;
 * every other key as the target holds it. `custom_properties`: under
 * `unverified` the target's bag unchanged, since an inconclusive advisory
 * cannot justify changing it; otherwise the derived keys set where the
 * state is `available` and removed where it is not. Every other section
 * is kept.
 */
export function projectProfileForTarget(
	application: Pick<HqApplication, "profile">,
	current: HqApplicationProfile,
	targetState: DerivedProfileTargetState,
): HqApplicationProfile | undefined {
	const generated = application.profile?.properties ?? {};
	const currentProperties = isRecord(current.properties)
		? current.properties
		: {};
	const properties: Record<string, unknown> = { ...currentProperties };
	for (const [key, value] of Object.entries(generated)) {
		if (SEEDED_KEYS.has(key) && !holdsNoValue(currentProperties, key)) {
			continue;
		}
		properties[key] = value;
	}

	const currentCustom = isRecord(current.custom_properties)
		? current.custom_properties
		: {};
	let customProperties: Record<string, unknown> = currentCustom;
	if (targetState !== "unverified") {
		customProperties = { ...currentCustom };
		for (const key of NOVA_OWNED_DERIVED_PROFILE_PROPERTY_KEYS) {
			delete customProperties[key];
		}
		if (targetState === "available") {
			Object.assign(customProperties, derivedProperties(application));
		}
	}

	const projected: HqApplicationProfile = { ...current };
	if (
		Object.keys(properties).length > 0 ||
		Object.hasOwn(current, "properties")
	) {
		projected.properties = properties;
	}
	if (
		Object.keys(customProperties).length > 0 ||
		Object.hasOwn(current, "custom_properties")
	) {
		projected.custom_properties = customProperties;
	}
	return sameJson(projected, current) ? undefined : projected;
}

/**
 * The body an update sends and its ownership: `application` with the three
 * keys projected onto `current`, each left out where it equals HQ's, and
 * `_attachments` kept last.
 */
export function projectApplicationForTarget(
	application: HqApplication,
	current: HqAppSource,
	targetState: DerivedProfileTargetState,
): {
	readonly application: HqApplication;
	readonly ownership: TargetOwnership;
} {
	const translations = projectTranslationsForTarget(application, current);
	const addOns = projectAddOnsForTarget(application, current);
	const profile = projectProfileForTarget(
		application,
		current.profile,
		targetState,
	);
	/* `_attachments` must stay last in serialized HQ JSON. HQ consumes it as
	 * upload bytes rather than ordinary app source, and Nova's stable JSON
	 * tests pin that order. */
	const {
		translations: _translations,
		add_ons: _addOns,
		profile: _profile,
		_attachments: attachments,
		...rest
	} = application;
	const body: HqApplication = {
		...rest,
		...(translations !== undefined && { translations }),
		...(addOns !== undefined && { add_ons: addOns }),
		...(profile !== undefined && { profile }),
		_attachments: attachments,
	};
	return {
		application: body,
		ownership: {
			addOns: [...neededAddOns(application)].sort(),
			profileProperties: [...OWNED_PROFILE_PROPERTY_KEYS],
			profileCustomProperties:
				targetState === "available"
					? [...NOVA_OWNED_DERIVED_PROFILE_PROPERTY_KEYS]
					: [],
			autoGpsCapture: Object.hasOwn(application, "auto_gps_capture"),
		},
	};
}

/**
 * Nova's part of a profile as one HQ read holds it: the `properties` and
 * `custom_properties` keys `ownership` names, each as HQ holds it, an absent
 * key staying absent. The drift comparison compares this part alone; the
 * rest is the target's, which the overlay carries.
 */
export function ownedProfilePart(
	profile: unknown,
	ownership: Pick<
		TargetOwnership,
		"profileProperties" | "profileCustomProperties"
	>,
): Record<string, Record<string, unknown>> {
	const bag = isRecord(profile) ? profile : {};
	const pick = (section: unknown, keys: readonly string[]) => {
		const picked: Record<string, unknown> = {};
		if (!isRecord(section)) return picked;
		for (const key of keys) {
			if (Object.hasOwn(section, key)) picked[key] = section[key];
		}
		return picked;
	};
	return {
		properties: pick(bag.properties, ownership.profileProperties),
		custom_properties: pick(
			bag.custom_properties,
			ownership.profileCustomProperties,
		),
	};
}

/**
 * The ownership of the empty shell a first publish creates: no add-on and no
 * profile key, and Auto Capture Location where the shell carries the key. It
 * is recorded with the `create` baseline and decides no comparison, which
 * reads only `modules` while the origin is `create`.
 */
export function shellOwnership(
	shell: Partial<Pick<HqApplication, "auto_gps_capture">>,
): TargetOwnership {
	return {
		addOns: [],
		profileProperties: [],
		profileCustomProperties: [],
		autoGpsCapture: Object.hasOwn(shell, "auto_gps_capture"),
	};
}
