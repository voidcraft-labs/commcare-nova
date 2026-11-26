import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { z } from "zod";
import { CaptureSubmissionRejectedError } from "@/lib/case-store/errors";
import {
	getFormOpeningData,
	putFormOpeningData,
} from "@/lib/db/formOpeningData";
import {
	canonicalJsonDigest,
	canonicalJsonText,
	canonicalTextDigest,
} from "@/lib/utils/canonicalJson";
import type {
	FormOpeningAudience,
	FormOpeningProjection,
	ReceiptRunTransition,
	SignedFormOpening,
} from "./formOpeningSnapshot";
import { previewAndroidInstallId } from "./previewDevice";

const purpose = "nova:worker-form-opening:v1\u0000";
const reopen =
	"This form's opening records could not be verified. Reopen the form to load them again.";
const compress = promisify(gzip);
const decompress = promisify(gunzip);
// Keep room within the one-MiB Server Action body for answers, choices and attachments.
const INLINE_BYTES = 256 * 1024;

/** Authority to carry a committed receipt's patch across entries on the
 * same logical device run. The source entry is looked up by its receipt
 * key independently of the destination entry and form. */
export function openingCarryScope(
	audience: Pick<
		FormOpeningAudience,
		| "app"
		| "project"
		| "actor"
		| "session"
		| "worker"
		| "persona"
		| "device"
		| "run"
	>,
): string {
	const { app, project, actor, session, worker, persona, device, run } =
		audience;
	return canonicalJsonDigest({
		app,
		project,
		actor,
		session,
		worker,
		persona,
		run,
		platform: device.platform,
		androidDeviceId: previewAndroidInstallId(device),
	});
}

type TransitionAudience = Pick<
	FormOpeningAudience,
	| "app"
	| "project"
	| "actor"
	| "session"
	| "worker"
	| "persona"
	| "device"
	| "form"
	| "revision"
>;
const transitionSchema = z.strictObject({
	from: z.uuid(),
	to: z.uuid(),
	entry: z.uuid().optional(),
	signature: z.string().regex(/^[0-9a-f]{64}$/),
});

/** The requested journal for comparison with an already accepted receipt.
 * This does not authorize a transition or change the immutable receipt. */
export function requestedReceiptRun(
	transition: unknown,
	run: string | undefined,
) {
	if (transition === undefined) return run;
	const parsed = transitionSchema.safeParse(transition);
	return parsed.success ? parsed.data.to : undefined;
}

export function signReceiptRunTransition(
	secret: string,
	audience: TransitionAudience,
	transition: Omit<ReceiptRunTransition, "signature">,
): ReceiptRunTransition {
	if (!secret)
		throw new Error("A receipt transition needs the service secret.");
	const { form, revision } = audience;
	const scope = openingCarryScope({ ...audience, run: transition.from });
	const signature = createHmac("sha256", secret)
		.update("nova:receipt-run-transition:v1\u0000")
		.update(canonicalJsonText({ scope, form, revision, ...transition }))
		.digest("hex");
	return { ...transition, signature };
}

export function verifyReceiptRunTransition(
	secret: string,
	audience: TransitionAudience,
	input: unknown,
	run: string | undefined,
	entry: string,
): string {
	const parsed = transitionSchema.safeParse(input);
	if (parsed.success) {
		const { signature, ...transition } = parsed.data;
		if (
			transition.from === run &&
			(transition.entry === undefined || transition.entry === entry) &&
			timingSafeEqual(
				Buffer.from(signature, "hex"),
				Buffer.from(
					signReceiptRunTransition(secret, audience, transition).signature,
					"hex",
				),
			)
		)
			return transition.to;
	}
	throw new CaptureSubmissionRejectedError(reopen);
}

type OpeningData = Pick<FormOpeningProjection, "cases" | "lookup">;
type DataLocation<T> =
	| { kind: "inline"; data: T }
	| { kind: "compressed"; bytes: string }
	| { kind: "stored"; digest: string };
interface Manifest {
	readonly entry: DataLocation<Omit<FormOpeningProjection, keyof OpeningData>>;
	readonly data: DataLocation<OpeningData>;
}

function signature(
	secret: string,
	audience: FormOpeningAudience,
	content: string,
) {
	if (!secret)
		throw new Error(
			"Signing a form opening requires the configured service secret.",
		);
	return createHmac("sha256", secret)
		.update(purpose)
		.update(canonicalJsonText(audience))
		.update("\u0000")
		.update(canonicalTextDigest(content))
		.digest();
}

function storageKey(audience: FormOpeningAudience, contentDigest: string) {
	return {
		audienceDigest: canonicalJsonDigest(audience),
		contentDigest,
		app: audience.app,
		project: audience.project,
		session: audience.session,
	};
}

async function locate<T>(
	audience: FormOpeningAudience,
	data: T,
): Promise<DataLocation<T>> {
	const text = canonicalJsonText(data);
	// The manifest itself travels as a JSON string in the Server Action.
	// Count its escaped representation so quote- or backslash-heavy values
	// cannot unexpectedly consume the room reserved for the form answers.
	if (
		Buffer.byteLength(text, "utf8") <= INLINE_BYTES &&
		Buffer.byteLength(JSON.stringify(text), "utf8") <= INLINE_BYTES
	)
		return { kind: "inline", data };
	const bytes = await compress(text);
	if (Math.ceil(bytes.length / 3) * 4 <= INLINE_BYTES)
		return { kind: "compressed", bytes: bytes.toString("base64") };
	const digest = createHash("sha256").update(bytes).digest("hex");
	await putFormOpeningData(storageKey(audience, digest), bytes);
	return { kind: "stored", digest };
}

/** Browser manifests carry immutable inputs or an exact digest of the
 * stored bytes. Each new manual choice only changes the signed entry part. */
export async function signFormOpening(
	secret: string,
	audience: FormOpeningAudience,
	projection: FormOpeningProjection,
	prior?: SignedFormOpening,
): Promise<SignedFormOpening> {
	const { cases, lookup, ...entry } = projection;
	const data = prior
		? authenticatedManifest(secret, audience, prior).data
		: await locate(audience, { cases, lookup });
	// A computed scalar can itself contain a long table or record value.
	// Bound both portions of every outgoing token independently.
	const content = canonicalJsonText({
		entry: await locate(audience, entry),
		data,
	} satisfies Manifest);
	return {
		version: 1,
		content,
		signature: signature(secret, audience, content).toString("hex"),
	};
}

function authenticatedManifest(
	secret: string,
	audience: FormOpeningAudience,
	value: SignedFormOpening,
): Manifest {
	if (
		value.version !== 1 ||
		typeof value.content !== "string" ||
		typeof value.signature !== "string" ||
		!/^[0-9a-f]{64}$/.test(value.signature) ||
		!timingSafeEqual(
			Buffer.from(value.signature, "hex"),
			signature(secret, audience, value.content),
		)
	)
		throw new CaptureSubmissionRejectedError(reopen);
	return JSON.parse(value.content) as Manifest;
}

export async function verifyFormOpening(
	secret: string,
	audience: FormOpeningAudience,
	value: SignedFormOpening,
): Promise<FormOpeningProjection> {
	const manifest = authenticatedManifest(secret, audience, value);
	return {
		...(await readLocation(audience, manifest.entry)),
		...(await readLocation(audience, manifest.data)),
	};
}

async function readLocation<T>(
	audience: FormOpeningAudience,
	location: DataLocation<T>,
): Promise<T> {
	if (location.kind === "inline") return location.data;
	const bytes =
		location.kind === "compressed"
			? Buffer.from(location.bytes, "base64")
			: await getFormOpeningData(storageKey(audience, location.digest));
	if (
		!bytes ||
		(location.kind === "stored" &&
			createHash("sha256").update(bytes).digest("hex") !== location.digest)
	)
		throw new CaptureSubmissionRejectedError(reopen);
	return JSON.parse((await decompress(bytes)).toString("utf8")) as T;
}
