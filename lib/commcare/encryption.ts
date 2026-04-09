/**
 * Google Cloud KMS encryption for sensitive user credentials stored in Firestore.
 *
 * Delegates all cryptographic operations to Cloud KMS — no encryption keys
 * live in env vars, memory, or code. The Cloud Run service account authenticates
 * via Application Default Credentials (same mechanism as Firestore).
 *
 * ## Key rotation
 *
 * KMS handles rotation automatically. When a key is rotated:
 * - New encryptions use the latest key version (the "primary" version).
 * - Decryptions automatically detect which version was used and apply it.
 * - No advance-on-read, no key ring parsing, no migration scripts.
 *
 * Enable automatic rotation in the GCP console or via:
 *   `gcloud kms keys update KEY --keyring=RING --location=LOC --rotation-period=90d`
 *
 * ## Setup
 *
 * 1. Create a key ring (same region as Cloud Run for lowest latency):
 *    `gcloud kms keyrings create nova --location=us-central1`
 *
 * 2. Create a symmetric encrypt/decrypt key:
 *    `gcloud kms keys create commcare-api-keys --keyring=nova --location=us-central1 --purpose=encryption`
 *
 * 3. Grant the Cloud Run service account the `cloudkms.cryptoKeyEncrypterDecrypter` role.
 *
 * Ciphertexts are stored as base64 strings in Firestore.
 */

import { KeyManagementServiceClient } from "@google-cloud/kms";

/** Lazily initialized KMS client singleton. */
let _client: KeyManagementServiceClient | null = null;

function getClient(): KeyManagementServiceClient {
	if (!_client) _client = new KeyManagementServiceClient();
	return _client;
}

/** KMS key ring and key — application constants, not configuration. */
const KMS_LOCATION = "us-central1";
const KMS_KEY_RING = "nova";
const KMS_KEY = "commcare-api-keys";

/**
 * Build the KMS key resource name from the GCP project ID.
 *
 * `GOOGLE_CLOUD_PROJECT` must be set in the Cloud Run service config
 * (same var Firestore already depends on). For local dev, set it in `.env`.
 */
function getKeyName(): string {
	const project = process.env.GOOGLE_CLOUD_PROJECT;
	if (!project) {
		throw new Error(
			"GOOGLE_CLOUD_PROJECT env var is required for KMS encryption. " +
				"Set it in Cloud Run service config or .env for local dev.",
		);
	}
	return `projects/${project}/locations/${KMS_LOCATION}/keyRings/${KMS_KEY_RING}/cryptoKeys/${KMS_KEY}`;
}

/**
 * Encrypt a plaintext string using Cloud KMS.
 *
 * Returns a base64-encoded ciphertext string suitable for storage in
 * Firestore. KMS automatically uses the key's primary version for new
 * encryptions, so key rotation is transparent.
 */
export async function encrypt(plaintext: string): Promise<string> {
	const client = getClient();
	const [result] = await client.encrypt({
		name: getKeyName(),
		plaintext: Buffer.from(plaintext, "utf8"),
	});

	if (!result.ciphertext) {
		throw new Error("KMS encrypt returned empty ciphertext");
	}

	/* KMS returns ciphertext as a Uint8Array — encode as base64 for Firestore storage. */
	return Buffer.from(result.ciphertext).toString("base64");
}

/**
 * Decrypt a base64-encoded ciphertext previously encrypted with {@link encrypt}.
 *
 * KMS automatically detects which key version was used for encryption,
 * so this works seamlessly after key rotation without any special handling.
 */
export async function decrypt(ciphertext: string): Promise<string> {
	const client = getClient();
	const [result] = await client.decrypt({
		name: getKeyName(),
		ciphertext: Buffer.from(ciphertext, "base64"),
	});

	if (!result.plaintext) {
		throw new Error("KMS decrypt returned empty plaintext");
	}

	return Buffer.from(result.plaintext).toString("utf8");
}
