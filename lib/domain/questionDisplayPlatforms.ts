import type { PlatformFeature } from "./platforms";

/** The platform advice attached to each authored question display setting. */
export const questionDisplayPlatforms = {
	"choice-grid": {
		label: "Choice grid",
		channel: "structure",
		webApps: {
			reading: "ignored",
			note: "choices appear in the ordinary list",
		},
		android: { reading: "runs", note: "choices appear in a grid" },
	},
	"choice-advance": {
		label: "Advance after a choice",
		channel: "structure",
		webApps: { reading: "ignored", note: "the worker stays on the form" },
		android: {
			reading: "runs",
			note: "choosing an answer continues to the next screen",
		},
	},
	"choice-multiword": {
		label: "Match search words",
		channel: "structure",
		webApps: {
			reading: "different",
			note: "a complete word in the choice can match",
		},
		android: { reading: "runs", note: "part of a word can match" },
	},
	"choice-fuzzy": {
		label: "Similar-sounding choice search",
		channel: "structure",
		webApps: {
			reading: "different",
			note: "similar text matches using Web Apps search",
		},
		android: {
			reading: "runs",
			note: "the phone ranks choices using its own spelling search",
		},
	},
	"choice-row": {
		label: "Choice table row",
		channel: "structure",
		webApps: {
			reading: "ignored",
			note: "choices appear in the ordinary list",
		},
		android: { reading: "runs", note: "choices appear on one row" },
	},
	"choice-cycle": {
		label: "Cycle through choices",
		channel: "structure",
		webApps: { reading: "runs", note: "each press moves to the next choice" },
		android: {
			reading: "ignored",
			note: "choices appear in the ordinary list",
		},
	},
	"question-receiver": {
		label: "Fill from a channel",
		channel: "structure",
		webApps: { reading: "runs", note: "a matching update fills the answer" },
		android: { reading: "ignored", note: "the worker fills the answer" },
	},
	"secret-keypad": {
		label: "Number keypad on a password",
		channel: "structure",
		webApps: {
			reading: "different",
			note: "the digits the worker types are visible",
		},
		android: { reading: "runs", note: "the password stays masked" },
	},
	"android-keypad": {
		label: "Number keypad on Android",
		channel: "structure",
		webApps: {
			reading: "ignored",
			note: "the question uses its usual keyboard",
		},
		android: { reading: "runs", note: "the question offers a number keypad" },
	},
	"short-input": {
		label: "Short entry",
		channel: "structure",
		webApps: { reading: "runs", note: "the entry box is narrow" },
		android: {
			reading: "different",
			note: "a text or number question on its own changes the keyboard action",
		},
	},
	"medium-input": {
		label: "Medium entry",
		channel: "structure",
		webApps: { reading: "runs", note: "the entry box uses medium width" },
		android: { reading: "ignored", note: "the entry box uses its usual width" },
	},
	"address-lookup": {
		label: "Address search",
		channel: "structure",
		webApps: {
			reading: "runs",
			note: "the worker can choose a place when the project space supports address search",
		},
		android: { reading: "ignored", note: "the worker types an answer" },
	},
	"question-sender": {
		label: "Share question updates",
		channel: "structure",
		webApps: {
			reading: "runs",
			note: "the question sends updates to the named channels",
		},
		android: {
			reading: "ignored",
			note: "the answer stays with this question",
		},
	},
	"barcode-text-options": {
		label: "Text options on a barcode",
		channel: "structure",
		webApps: {
			reading: "different",
			note: "the question accepts text and applies its text entry settings",
		},
		android: { reading: "ignored", note: "the worker scans the barcode" },
	},
	"placeholder-hint": {
		label: "Hint inside the entry box",
		channel: "structure",
		webApps: { reading: "runs", note: "an empty entry box shows its hint" },
		android: {
			reading: "ignored",
			note: "the hint appears below the question",
		},
	},
	"hide-web-hint": {
		label: "Hint hidden in Web Apps",
		channel: "structure",
		webApps: { reading: "different", note: "the hint is hidden" },
		android: {
			reading: "ignored",
			note: "the hint appears below the question",
		},
	},
	"auto-scan": {
		label: "Open the scanner automatically",
		channel: "structure",
		webApps: { reading: "ignored", note: "the worker types the code" },
		android: {
			reading: "runs",
			note: "opening an unanswered question starts the scanner",
		},
	},
	"android-calendar": {
		label: "Android calendar",
		channel: "structure",
		webApps: { reading: "ignored", note: "the worker uses the usual calendar" },
		android: {
			reading: "runs",
			note: "the worker chooses a day in the selected calendar",
		},
	},
	"twelve-hour-clock": {
		label: "12-hour clock",
		channel: "structure",
		webApps: { reading: "runs", note: "the clock shows AM or PM" },
		android: { reading: "ignored", note: "the phone uses its time settings" },
	},
	"android-map": {
		label: "Choose a location on a map",
		channel: "structure",
		webApps: { reading: "ignored", note: "the usual location entry opens" },
		android: {
			reading: "runs",
			note: "the worker chooses a location on a map",
		},
	},
	"edit-scan": {
		label: "Edit a scanned answer",
		channel: "structure",
		webApps: { reading: "ignored", note: "the worker types the code" },
		android: {
			reading: "runs",
			note: "the worker can change the scanned text",
		},
	},
	"camera-only": {
		label: "Camera capture",
		channel: "structure",
		webApps: {
			reading: "ignored",
			note: "the worker chooses an existing file",
		},
		android: { reading: "runs", note: "the worker uses the camera" },
	},
	"photo-overlay": {
		label: "Small photo overlay",
		channel: "structure",
		webApps: { reading: "ignored", note: "the worker chooses a file" },
		android: { reading: "runs", note: "the preview uses a small overlay" },
	},
	"classic-recorder": {
		label: "Classic audio recorder",
		channel: "structure",
		webApps: { reading: "ignored", note: "the worker chooses a file" },
		android: { reading: "runs", note: "the phone opens its classic recorder" },
	},
	"record-or-choose": {
		label: "Record or choose audio",
		channel: "structure",
		webApps: { reading: "ignored", note: "the worker chooses a file" },
		android: {
			reading: "runs",
			note: "the worker can record or choose an audio file",
		},
	},
	"long-recording": {
		label: "Pause audio recording",
		channel: "structure",
		webApps: { reading: "ignored", note: "the worker chooses a file" },
		android: {
			reading: "runs",
			note: "the worker can pause and resume recording on Android 7 or later",
		},
	},
	"select-label-text": {
		label: "Selectable label text",
		channel: "structure",
		webApps: {
			reading: "ignored",
			note: "the label uses the usual text behavior",
		},
		android: { reading: "runs", note: "the worker can select the text" },
	},
	"question-banner": {
		label: "Question banner",
		channel: "structure",
		webApps: { reading: "ignored", note: "the question stays in the form" },
		android: {
			reading: "runs",
			note: "the question text appears in a colored banner",
		},
	},
	"hidden-label": {
		label: "Hidden label",
		channel: "structure",
		webApps: { reading: "ignored", note: "the label stays visible" },
		android: { reading: "different", note: "the label is hidden" },
	},
	"compact-group": {
		label: "Compact group",
		channel: "structure",
		webApps: { reading: "ignored", note: "the group uses its usual layout" },
		android: { reading: "runs", note: "the group shares a screen" },
	},
	"collapse-group": {
		label: "Collapsible group",
		channel: "structure",
		webApps: {
			reading: "runs",
			note: "the worker can open and close the group",
		},
		android: { reading: "ignored", note: "the group uses its usual layout" },
	},
	"group-border": {
		label: "Group border",
		channel: "structure",
		webApps: { reading: "runs", note: "a border surrounds the group" },
		android: { reading: "ignored", note: "the group uses its usual layout" },
	},
	"questions-across": {
		label: "Questions per row",
		channel: "structure",
		webApps: { reading: "runs", note: "questions can share a row" },
		android: {
			reading: "ignored",
			note: "questions use the usual screen layout",
		},
	},
	"repeats-across": {
		label: "Repeats per row",
		channel: "structure",
		webApps: { reading: "runs", note: "repeat entries can share a row" },
		android: {
			reading: "ignored",
			note: "repeat entries use the usual screen layout",
		},
	},
	"question-alignment": {
		label: "Question alignment",
		channel: "structure",
		webApps: { reading: "runs", note: "text uses the selected alignment" },
		android: { reading: "ignored", note: "text uses its usual alignment" },
	},
	"combined-question-display": {
		label: "Combined question display",
		channel: "structure",
		webApps: {
			reading: "different",
			note: "the entry applies the available display settings together",
		},
		android: {
			reading: "different",
			note: "the phone uses the control offered by this combination",
		},
	},
} as const satisfies Record<string, PlatformFeature>;

export const questionDisplayPlatformIds = Object.keys(
	questionDisplayPlatforms,
) as (keyof typeof questionDisplayPlatforms)[];
