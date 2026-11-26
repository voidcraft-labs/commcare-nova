import { z } from "zod";
import { formLogicSchema } from "../expression/types";
import { uuidSchema } from "../uuid";

/** The ordinary input widgets that can invoke a different question's app. */
const androidAppInputKinds = [
	"text",
	"int",
	"decimal",
	"datetime",
	"date",
	"time",
	"geopoint",
	"barcode",
] as const;

export const ANDROID_APP_INPUT_KINDS: ReadonlySet<string> = new Set(
	androidAppInputKinds,
);

export function isAndroidAppInputKind(
	kind: string,
): kind is (typeof androidAppInputKinds)[number] {
	return ANDROID_APP_INPUT_KINDS.has(kind);
}

/** Another question in this form opens the same app. Names and paths are
 * projected from its UUID at export, including after a move or rename. */
export const androidAppQuestionSchema = z.strictObject({
	kind: z.literal("use-question"),
	question: uuidSchema,
});

/** Each input keeps its place among inputs with the same name. Vellum can
 * write duplicates; Android compiles only the last expression for that key. */
export function androidAppInputMember(
	inputs: readonly { readonly name?: unknown }[],
	index: number,
) {
	const name = inputs[index]?.name;
	if (typeof name !== "string")
		throw new Error("The Android app input has no name.");
	return {
		name,
		occurrence: inputs.slice(0, index).filter((input) => input.name === name)
			.length,
	};
}
const resultName = z.string().min(1);

/** A worker's answer comes from an app on their Android device. A result
 * name can fill more than one question, each with its own answer type. */
export const androidAppActionSchema = z.strictObject({
	kind: z.literal("open-app"),
	action: z.string().min(1),
	send: z.array(z.strictObject({ name: resultName, value: formLogicSchema })),
	receive: z.array(z.strictObject({ name: resultName, question: uuidSchema })),
});

export const androidAppAnswerSchema = z.discriminatedUnion("kind", [
	androidAppActionSchema,
	androidAppQuestionSchema,
]);

export type AndroidAppAction = z.infer<typeof androidAppActionSchema>;
export type AndroidAppAnswer = z.infer<typeof androidAppAnswerSchema>;

/** The actions offered by HQ's vellum-app-callout-templates.yml. The
 * privileges validator matches the action string alone, even with mappings. */
export const BUILT_IN_ANDROID_APP_ACTIONS = new Map([
	["richard.chard.lu.android.areamapper.LAUNCH", "Area Mapper"],
	["org.commcare.respiratory.BREATHCOUNT", "Breath Counter"],
	["com.simprints.id.REGISTER", "Simprints Enrolment"],
]);
