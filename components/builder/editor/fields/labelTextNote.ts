// components/builder/editor/fields/labelTextNote.ts
//
// The line under a label's other text in the inspector
// (`lib/domain/labelForms.ts`): what a worker meets on each platform the app
// runs on. An extended text shows on both platforms exactly where the label
// shows as typed; a QR code and a spoken text are Android's alone, and their
// readings come from the platform table (`lib/domain/platforms.ts`).

import type { LabelTextSlot } from "@/lib/domain/labelForms";
import {
	inPlatform,
	PLATFORM_FEATURES,
	type Platform,
	type PlatformFeatureId,
} from "@/lib/domain/platforms";

const FEATURE_OF: Readonly<
	Record<Exclude<LabelTextSlot, "extended_text">, PlatformFeatureId>
> = {
	qr_code: "label-qr-code",
	spoken_text: "label-spoken-text",
};

function sentence(platform: Platform, note: string): string {
	const where = inPlatform(platform);
	return `${where.charAt(0).toUpperCase()}${where.slice(1)}, ${note}.`;
}

/** The note for one label text slot, given the declared platforms and
 *  whether the label shows as typed. */
export function labelTextNote(
	slot: LabelTextSlot,
	platforms: readonly Platform[],
	labelShowsAsTyped: boolean,
): string {
	if (slot === "extended_text")
		return labelShowsAsTyped
			? "Workers see this in place of the label."
			: "Workers see this in place of the label once the label's Format text is off.";
	const feature = PLATFORM_FEATURES[FEATURE_OF[slot]];
	return platforms
		.map((platform) => {
			const behavior =
				platform === "web-apps" ? feature.webApps : feature.android;
			return behavior.note === undefined
				? undefined
				: sentence(platform, behavior.note);
		})
		.filter((line): line is string => line !== undefined)
		.join(" ");
}
