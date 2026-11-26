import { z } from "zod";

/** CommCare HQ's row layout consumes a leading decimal integer using the
 * browser's Number semantics. Keeping decimal digits also preserves counts
 * too wide for an exact JavaScript number. */
export const rowCountSchema = z
	.string()
	.regex(/^(?:0|[1-9][0-9]*)$/, "Use a whole number of items per row.");
/** Returned field names may contain separators such as ||. Both channel and
 * returned field can be empty. Only an ASCII space ends a topic in Web Apps. */
const topicName = z
	.string()
	.regex(/^[^ ]*$/, "A channel name can contain any character except a space.");
export const displaySchemas = {
	keypad: z.enum(["numbers", "android-numbers"]),
	inputWidth: z.enum(["short", "medium"]),
	addressLookup: z.literal(true),
	sendTopics: z
		.array(topicName)
		.min(1)
		.refine(
			(topics) => new Set(topics).size === topics.length,
			"Each channel can occur once.",
		),
	receiveFrom: z.strictObject({
		channel: topicName,
		field: z
			.string()
			.regex(
				/^[^ -]*$/,
				"The returned field cannot contain a space or hyphen.",
			),
	}),
	hintPlacement: z.enum(["placeholder", "hidden-on-web"]),
	scanOnOpen: z.literal(true),
	canEditScan: z.literal(true),
	calendar: z.enum([
		"ethiopian",
		"nepali",
		"gregorian",
		"gregorian-with-clear",
	]),
	clock: z.literal("twelve-hour"),
	locationPicker: z.literal("map"),
	captureSource: z.enum(["camera", "face-camera", "record-or-choose"]),
	overlaySize: z.literal("small"),
	recorder: z.literal("legacy"),
	pauseRecording: z.literal(true),
	selectableText: z.literal(true),
	banner: z.enum(["good", "caution", "bad", "hidden"]),
	compact: z.literal(true),
	collapse: z.enum(["closed", "open"]),
	border: z.literal(true),
	itemsPerRow: rowCountSchema,
	repeatsPerRow: rowCountSchema,
	textAlignment: z.enum(["center", "right"]),
	webSignature: z.literal(true),
} as const;
