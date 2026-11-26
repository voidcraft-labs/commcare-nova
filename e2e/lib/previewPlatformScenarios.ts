/**
 * The browser scenarios that show Preview playing each platform: one per
 * behavior the cell table (`lib/preview/__tests__/platformCells.ts`) proves
 * in a browser, plus Android's stand-ins for the phone's hardware. Plain
 * TypeScript, so Vitest's completeness test and the Playwright spec
 * (`e2e/tests/browser/preview-platforms.spec.ts`) read one registry; the
 * spec implements every id, so a scenario with no implementation fails
 * `tsc`.
 *
 * `fixture` names the document the component peer
 * (`e2e/lib/preview-platforms-client.tsx`, or the search peer
 * `e2e/lib/preview-search-client.tsx` for `search`) mounts for the
 * scenario, and `describe` is the observable the spec asserts.
 */

import type { Platform } from "@/lib/domain/platforms";

export type PreviewPlatformFixture =
	| "face-photo"
	| "question-display"
	| "questions"
	| "sections"
	| "screens"
	| "media"
	| "search"
	| "label-texts"
	| "home";

export interface PreviewPlatformScenario {
	readonly platform: Platform;
	readonly fixture: PreviewPlatformFixture;
	readonly describe: string;
}

export const PREVIEW_PLATFORM_SCENARIOS = {
	"face-photo-android": {
		platform: "android",
		fixture: "face-photo",
		describe:
			"the worker switches and closes a face camera, then saves its cropped photograph",
	},
	"face-photo-web-apps": {
		platform: "web-apps",
		fixture: "face-photo",
		describe:
			"the worker attaches the unchanged picture to the same face question",
	},
	"visit-display-web-apps": {
		platform: "web-apps",
		fixture: "question-display",
		describe:
			"a worker searches for a route, signs, reads a hint and answers a protected number and a field in a collapsed group",
	},
	"visit-display-android": {
		platform: "android",
		fixture: "question-display",
		describe:
			"a worker searches and clears a route, sees a paired status banner, keeps a masked code and uses the keyboard action",
	},
	"location-map-web-apps": {
		platform: "web-apps",
		fixture: "questions",
		describe:
			"the location question is the map and address search, with no way to use the browser's location, and manual coordinates answer 40.0 -74.0 0.0 0.0",
	},
	"barcode-text-web-apps": {
		platform: "web-apps",
		fixture: "questions",
		describe:
			"a barcode question is a text box with no Scan button, and its typed answer is the answer",
	},
	"number-keypad-web-apps": {
		platform: "web-apps",
		fixture: "questions",
		describe:
			"a Text question with a number keypad keeps 0712 and +254712, and refuses 12 34 with its message while keeping the earlier answer",
	},
	"image-size-web-apps": {
		platform: "web-apps",
		fixture: "media",
		describe: "a photo keeps its original bytes when an Android size is set",
	},
	"image-size-android": {
		platform: "android",
		fixture: "media",
		describe:
			"JPEG photos keep their orientation and are resized before upload",
	},
	"image-attach-web-apps": {
		platform: "web-apps",
		fixture: "media",
		describe: "an image question is Attach file, with no camera input",
	},
	"audio-attach-web-apps": {
		platform: "web-apps",
		fixture: "media",
		describe: "an audio question is Attach file, with no recorder",
	},
	"video-attach-web-apps": {
		platform: "web-apps",
		fixture: "media",
		describe: "a video question is Attach file, with no camera input",
	},
	"sections-one-screen-web-apps": {
		platform: "web-apps",
		fixture: "sections",
		describe:
			"a sectioned form shows both sections as titled groups on one screen with no pager, and Submit reveals the first invalid question",
	},
	"choice-media-web-apps": {
		platform: "web-apps",
		fixture: "media",
		describe: "a choice's image is not drawn",
	},
	"help-web-apps": {
		platform: "web-apps",
		fixture: "questions",
		describe:
			"help opens from a button on the label line into a dialog with a close button, and a question with help media alone has no help button",
	},
	"help-plain-web-apps": {
		platform: "web-apps",
		fixture: "questions",
		describe:
			"a help text written with formatting off still renders its markdown",
	},
	"hint-markdown-web-apps": {
		platform: "web-apps",
		fixture: "questions",
		describe: "a hint renders its markdown",
	},
	"validation-plain-web-apps": {
		platform: "web-apps",
		fixture: "questions",
		describe: "a validation message shows its markdown as written",
	},
	"choice-label-markdown-web-apps": {
		platform: "web-apps",
		fixture: "questions",
		describe: "a choice label renders its markdown",
	},
	"choice-label-plain-web-apps": {
		platform: "web-apps",
		fixture: "questions",
		describe:
			"a choice label written with formatting off still renders its markdown",
	},
	"group-label-web-apps": {
		platform: "web-apps",
		fixture: "questions",
		describe: "a group draws its card with its label as the card's title",
	},
	"barcode-search-field-web-apps": {
		platform: "web-apps",
		fixture: "search",
		describe: "a barcode Search field is a text box with no Scan button",
	},
	"help-android": {
		platform: "android",
		fixture: "questions",
		describe:
			"help opens from an info button under the question into a dialog with OK, and help media alone has a button too",
	},
	"hint-plain-android": {
		platform: "android",
		fixture: "questions",
		describe: "a hint shows its markdown as written",
	},
	"validation-plain-android": {
		platform: "android",
		fixture: "questions",
		describe: "a validation message shows its markdown as written",
	},
	"choice-label-markdown-android": {
		platform: "android",
		fixture: "questions",
		describe: "a choice label renders its markdown",
	},
	"group-label-android": {
		platform: "android",
		fixture: "screens",
		describe:
			"a screen inside a repeat entry reads its labeled containers as one header line, Visits (2) > Details, after the repeat prompt adds the entry",
	},
	"label-markdown-android": {
		platform: "android",
		fixture: "questions",
		describe:
			"a label with a single newline, an image and raw HTML reads as Markwon renders it",
	},
	"search-screen-text-android": {
		platform: "android",
		fixture: "search",
		describe:
			"the search screen shows no title, description or field hints, and its heading is the search action's label",
	},
	"menu-grid-web-apps": {
		platform: "web-apps",
		fixture: "home",
		describe: "a grid choice keeps its name and has no spoken label player",
	},
	"menu-grid-android": {
		platform: "android",
		fixture: "home",
		describe:
			"holding a grid choice plays its spoken label, and letting go opens it",
	},
	"logo-android": {
		platform: "android",
		fixture: "home",
		describe: "the running module list draws no logo banner",
	},
	"location-record-android": {
		platform: "android",
		fixture: "questions",
		describe:
			"Record location takes a fix of 5 metres or better at once, offers Record location for a worse one once its accuracy shows, and Cancel shows Android's toast",
	},
	"capture-android": {
		platform: "android",
		fixture: "media",
		describe:
			"an image question offers Take picture (accept image/*, capture environment) and Choose image (accept image/*), a file over 15 MB is refused with its line, a file of 3,073,023 bytes attaches without Android's large-file line and one of 3,073,024 bytes attaches with it",
	},
	"barcode-scan-android": {
		platform: "android",
		fixture: "questions",
		describe:
			"a barcode question is a text box with Scan, or a line saying the browser can't scan",
	},
	"form-screens-android": {
		platform: "android",
		fixture: "screens",
		describe:
			"a form without sections pages one question or group shown on one screen per screen, such a group in a repeat once per entry and an unlabeled group's questions one by one; Next validates and the last screen reads Finish; the repeat prompt goes back, adds another entry, declines, and reads Do not add, I'm finished when nothing follows; a repeat inside a labeled group without the flag pages its entry and prompts",
	},
	"label-texts-android": {
		platform: "android",
		fixture: "label-texts",
		describe:
			"a plain label shows its extended text, names the QR code a scan reads, and its speaker button reads the spoken text aloud until Preview plays Web Apps, where the button and the reading stop",
	},
} as const satisfies Readonly<Record<string, PreviewPlatformScenario>>;

export type PreviewPlatformScenarioId = keyof typeof PREVIEW_PLATFORM_SCENARIOS;
