/**
 * The identities and texts the Preview platforms peer
 * (`preview-platforms-client.tsx`) builds its documents from, shared with
 * its spec (`e2e/tests/browser/preview-platforms.spec.ts`), which cannot
 * import the peer itself.
 */

import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";

export const PLATFORM_IDS = {
	module: testUuid("platforms-module"),
	form: testUuid("platforms-form"),
	place: testUuid("platforms-place"),
	code: testUuid("platforms-code"),
	name: testUuid("platforms-name"),
	note: testUuid("platforms-note"),
	choice: testUuid("platforms-choice"),
	image: testUuid("platforms-image"),
	helpImage: testMediaAssetId("platforms-help-image"),
	choiceImage: testMediaAssetId("platforms-choice-image"),
	logo: testMediaAssetId("platforms-logo"),
} as const;

/** The label the Markwon reading reads (the targeted document
 *  `previewAndroidRenders` holds the same one): a single newline, an image
 *  and a raw tag. */
export const MARKDOWN_LABEL_TEXT = "a\nb ![x](y) <b>c</b>";
