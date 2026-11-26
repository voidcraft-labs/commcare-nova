/**
 * The identities and texts the Preview platforms peer
 * (`preview-platforms-client.tsx`) builds its documents from, shared with
 * its spec (`e2e/tests/browser/preview-platforms.spec.ts`), which cannot
 * import the peer itself.
 */

import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";

export const PLATFORM_IDS = {
	meter: testUuid("platforms-meter"),
	reading: testUuid("platforms-reading"),
	verify: testUuid("platforms-verify"),
	module: testUuid("platforms-module"),
	form: testUuid("platforms-form"),
	place: testUuid("platforms-place"),
	address: testUuid("platforms-address"),
	addressCityCopy: testUuid("platforms-address-city-copy"),
	changeDay: testUuid("platforms-change-day"),
	returnDay: testUuid("platforms-return-day"),
	code: testUuid("platforms-code"),
	phone: testUuid("platforms-phone"),
	phoneHeld: testUuid("platforms-phone-held"),
	name: testUuid("platforms-name"),
	note: testUuid("platforms-note"),
	plainHelp: testUuid("platforms-plain-help"),
	choice: testUuid("platforms-choice"),
	image: testUuid("platforms-image"),
	helpImage: testMediaAssetId("platforms-help-image"),
	choiceImage: testMediaAssetId("platforms-choice-image"),
	logo: testMediaAssetId("platforms-logo"),
	menuSound: testMediaAssetId("platforms-menu-sound"),
} as const;

/** The label the Markwon reading reads (the targeted document
 *  `previewAndroidRenders` holds the same one): a single newline, an image
 *  and a raw tag. */
export const MARKDOWN_LABEL_TEXT = "a\nb ![x](y) <b>c</b>";
