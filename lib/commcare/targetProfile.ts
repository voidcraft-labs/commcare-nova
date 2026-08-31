/**
 * Project Nova's derived profile properties onto one concrete HQ target.
 *
 * New apps have no target-owned profile to preserve. Updates do: CommCare HQ
 * shallow-replaces `profile` when an import includes it, so an update sends the
 * complete source profile only when one of Nova's owned keys actually changes.
 * A no-op omits `profile` and lets HQ retain its current bag untouched.
 */

import type { HqApplication, HqApplicationProfile } from "@/lib/commcare";
import { NOVA_OWNED_DERIVED_PROFILE_PROPERTY_KEYS } from "./derivedProfile";

export interface TargetProfileProjection {
	readonly application: HqApplication;
	/** Whether this import intentionally changes Nova-owned profile state. */
	readonly profileChanged: boolean;
}

function withProfile(
	application: HqApplication,
	profile: HqApplicationProfile | undefined,
): HqApplication {
	/* `_attachments` must stay last in serialized HQ JSON. HQ consumes it as
	 * upload bytes rather than ordinary app source, and Nova's stable JSON tests
	 * pin that order. */
	const {
		profile: _generatedProfile,
		_attachments: attachments,
		...withoutProfileOrAttachments
	} = application;
	return {
		...withoutProfileOrAttachments,
		...(profile === undefined ? {} : { profile }),
		_attachments: attachments,
	};
}

function generatedProperties(
	application: HqApplication,
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

function withoutOwnedGeneratedProperties(
	application: HqApplication,
): HqApplication {
	const profile = application.profile;
	if (profile === undefined) return application;
	const customProperties = { ...(profile.custom_properties ?? {}) };
	for (const key of NOVA_OWNED_DERIVED_PROFILE_PROPERTY_KEYS) {
		delete customProperties[key];
	}
	const hasOtherProfileState =
		Object.keys(customProperties).length > 0 ||
		profile.features !== undefined ||
		profile.properties !== undefined;
	return withProfile(
		application,
		hasOtherProfileState
			? { ...profile, custom_properties: customProperties }
			: undefined,
	);
}

/** Prepare a new-app import for a target whose advisory support is known. */
export function projectNewAppProfileForTarget(
	application: HqApplication,
	supportsDerivedProfile: boolean,
): TargetProfileProjection {
	if (supportsDerivedProfile || application.profile === undefined) {
		return { application, profileChanged: false };
	}
	return {
		application: withoutOwnedGeneratedProperties(application),
		profileChanged: false,
	};
}

/**
 * Prepare an in-place update from the source profile read immediately before
 * import. Only the allowlisted Nova keys may change; every foreign key and
 * every other profile section is preserved exactly.
 */
export function projectUpdatedAppProfileForTarget(
	application: HqApplication,
	currentProfile: HqApplicationProfile,
	supportsDerivedProfile: boolean,
): TargetProfileProjection {
	const desired = supportsDerivedProfile
		? generatedProperties(application)
		: {};
	const currentCustom = currentProfile.custom_properties ?? {};
	const profileChanged = NOVA_OWNED_DERIVED_PROFILE_PROPERTY_KEYS.some(
		(key) => {
			const hasCurrent = Object.hasOwn(currentCustom, key);
			const hasDesired = Object.hasOwn(desired, key);
			return hasCurrent !== hasDesired || currentCustom[key] !== desired[key];
		},
	);

	if (!profileChanged) {
		return {
			application: withProfile(application, undefined),
			profileChanged: false,
		};
	}

	const customProperties = { ...currentCustom };
	for (const key of NOVA_OWNED_DERIVED_PROFILE_PROPERTY_KEYS) {
		delete customProperties[key];
	}
	Object.assign(customProperties, desired);

	return {
		application: withProfile(application, {
			...currentProfile,
			custom_properties: customProperties,
		}),
		profileChanged: true,
	};
}
