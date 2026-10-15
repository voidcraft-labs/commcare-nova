/**
 * One Cloud KMS decrypt per use of a member's stored CommCare HQ key.
 *
 * The cutover runs as a bundle with no `node_modules` beside it, so it calls
 * KMS's REST `:decrypt` method with `google-auth-library`, which the Cloud SQL
 * connector already brings into the bundle, instead of the gax client
 * `lib/commcare/encryption.ts` uses. The key is the one that module encrypts
 * with. A plaintext is returned to the one caller about to send it and is
 * never placed in the plan, a digest input, a log line or an error.
 */

import { GoogleAuth } from "google-auth-library";

const KMS_ENDPOINT = "https://cloudkms.googleapis.com";
const KMS_LOCATION = "us-central1";
const KMS_KEY_RING = "nova";
const KMS_KEY = "commcare-api-keys";
const KMS_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/** The KMS key `lib/commcare/encryption.ts` encrypts stored keys with. */
export function storedKeyName(project: string): string {
	return `projects/${project}/locations/${KMS_LOCATION}/keyRings/${KMS_KEY_RING}/cryptoKeys/${KMS_KEY}`;
}

/** Where the decrypt is sent and how it is authorized. */
export interface KmsDecryptTransport {
	/** The KMS REST origin. */
	readonly endpoint: string;
	/** A bearer token for the identity the decrypt runs as. */
	readonly accessToken: () => Promise<string>;
	readonly keyName: string;
}

/** The transport the Job uses: KMS itself, as the Job's own identity. */
export function defaultKmsTransport(): KmsDecryptTransport {
	const project = process.env.GOOGLE_CLOUD_PROJECT;
	if (project === undefined || project.trim() === "") {
		throw new Error(
			"The cutover decrypts members' stored keys with the project's KMS key, so it needs GOOGLE_CLOUD_PROJECT. The Job sets it; set it before running locally.",
		);
	}
	const auth = new GoogleAuth({ scopes: [KMS_SCOPE] });
	return {
		endpoint: KMS_ENDPOINT,
		keyName: storedKeyName(project),
		accessToken: async () => {
			const token = await auth.getAccessToken();
			if (token === null || token === undefined || token === "") {
				throw new Error(
					"Google's credentials gave no access token for the KMS decrypt. Check the identity the cutover runs as.",
				);
			}
			return token;
		},
	};
}

/**
 * KMS refused a decrypt. `permission` is KMS's own permission refusal, which
 * a grant still being applied answers for a while after it is made. The
 * message holds the status and KMS's error status alone, never a key.
 */
export class KmsDecryptRefusedError extends Error {
	readonly name = "KmsDecryptRefusedError";

	constructor(
		readonly status: number,
		readonly kind: "permission" | "other",
		kmsStatus: string | null,
	) {
		super(
			kind === "permission"
				? `Cloud KMS refused the decrypt with ${status}${kmsStatus === null ? "" : ` ${kmsStatus}`}: the cutover's identity holds no decrypt grant on the key yet. Make the grant, or wait while IAM applies it.`
				: `Cloud KMS refused the decrypt with ${status}${kmsStatus === null ? "" : ` ${kmsStatus}`}, so the stored key could not be read.`,
		);
	}
}

function kmsErrorStatus(body: unknown): string | null {
	if (body === null || typeof body !== "object") return null;
	const error = (body as { error?: unknown }).error;
	if (error === null || typeof error !== "object") return null;
	const status = (error as { status?: unknown }).status;
	return typeof status === "string" ? status : null;
}

/** Decrypt one stored ciphertext (base64, as `user_settings` holds it). */
export async function kmsDecrypt(
	ciphertext: string,
	transport: KmsDecryptTransport,
): Promise<string> {
	const response = await fetch(
		`${transport.endpoint}/v1/${transport.keyName}:decrypt`,
		{
			method: "POST",
			headers: {
				authorization: `Bearer ${await transport.accessToken()}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ ciphertext }),
		},
	);
	let body: unknown = null;
	try {
		body = await response.json();
	} catch {
		body = null;
	}
	if (!response.ok) {
		const kmsStatus = kmsErrorStatus(body);
		throw new KmsDecryptRefusedError(
			response.status,
			response.status === 403 || kmsStatus === "PERMISSION_DENIED"
				? "permission"
				: "other",
			kmsStatus,
		);
	}
	const plaintext =
		body !== null && typeof body === "object"
			? (body as { plaintext?: unknown }).plaintext
			: undefined;
	if (typeof plaintext !== "string" || plaintext === "") {
		throw new Error(
			"Cloud KMS answered the decrypt with no plaintext, so the stored key could not be read.",
		);
	}
	return Buffer.from(plaintext, "base64").toString("utf8");
}

/** The clock `proveDecrypt` waits on: real time in the Job, the test's own in tests. */
export interface DecryptClock {
	now(): number;
	sleep(milliseconds: number): Promise<void>;
}

export const realClock: DecryptClock = {
	now: () => Date.now(),
	sleep: (milliseconds) =>
		new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export const PROVE_DECRYPT_INTERVAL_MS = 10_000;
export const PROVE_DECRYPT_WINDOW_MS = 10 * 60_000;

/**
 * Decrypt one ciphertext as proof that a grant stands. A permission refusal
 * is tried again every ten seconds for up to ten minutes, since IAM applies a
 * new grant some time after it is made; any other refusal ends the proof.
 * Answers whether a decrypt succeeded; the plaintext is dropped.
 */
export async function proveDecrypt(
	ciphertext: string,
	transport: KmsDecryptTransport,
	clock: DecryptClock = realClock,
): Promise<"ok" | "failed"> {
	const started = clock.now();
	while (true) {
		try {
			await kmsDecrypt(ciphertext, transport);
			return "ok";
		} catch (error) {
			if (
				!(error instanceof KmsDecryptRefusedError) ||
				error.kind !== "permission"
			) {
				throw error;
			}
			if (
				clock.now() - started + PROVE_DECRYPT_INTERVAL_MS >
				PROVE_DECRYPT_WINDOW_MS
			) {
				return "failed";
			}
			await clock.sleep(PROVE_DECRYPT_INTERVAL_MS);
		}
	}
}
