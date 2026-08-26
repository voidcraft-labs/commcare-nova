/**
 * Browser implementation of CommCare Core's encrypt-string/decrypt-string
 * payload contract. These functions are intentionally asynchronous because
 * Web Crypto is the browser's native, nonblocking cryptography boundary.
 */

const AES_KEY_BYTES = 32;
const DEFAULT_IV_BYTES = 12;
const TAG_BITS = 128;

export interface JavaRosaCryptoOptions {
	/** Injection point for deterministic tests; production callers should omit it. */
	readonly randomBytes?: (length: number) => Uint8Array;
	/** Worker-owned WebCrypto boundary. */
	readonly crypto?: Pick<Crypto, "getRandomValues" | "subtle">;
}

export async function javaRosaEncryptString(
	message: string,
	keyBase64: string,
	algorithm: string,
	options: JavaRosaCryptoOptions = {},
): Promise<string> {
	requireAes(algorithm);
	const crypto = options.crypto ?? globalThis.crypto;
	const keyBytes = decodeBase64(keyBase64);
	requireKeyLength(keyBytes);
	const iv = copyBytes(
		options.randomBytes?.(DEFAULT_IV_BYTES) ??
			crypto.getRandomValues(new Uint8Array(DEFAULT_IV_BYTES)),
	);
	if (iv.length < 1 || iv.length > 255) {
		throw new Error("AES-GCM IV length must fit in one byte.");
	}
	const key = await importAesKey(keyBytes, ["encrypt"], crypto);
	const encrypted = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv, tagLength: TAG_BITS },
			key,
			copyBytes(new TextEncoder().encode(message)),
		),
	);
	const payload = new Uint8Array(1 + iv.length + encrypted.length);
	payload[0] = iv.length;
	payload.set(iv, 1);
	payload.set(encrypted, 1 + iv.length);
	return encodeBase64(payload);
}

export async function javaRosaDecryptString(
	payloadBase64: string,
	keyBase64: string,
	algorithm: string,
	options: Pick<JavaRosaCryptoOptions, "crypto"> = {},
): Promise<string> {
	requireAes(algorithm);
	const crypto = options.crypto ?? globalThis.crypto;
	const keyBytes = decodeBase64(keyBase64);
	requireKeyLength(keyBytes);
	const payload = decodeBase64(payloadBase64);
	const ivLength = payload[0];
	if (
		ivLength === undefined ||
		ivLength === 0 ||
		payload.length < 1 + ivLength + TAG_BITS / 8
	) {
		throw new Error("Invalid CommCare AES-GCM payload.");
	}
	const iv = copyBytes(payload.slice(1, 1 + ivLength));
	const ciphertextAndTag = copyBytes(payload.slice(1 + ivLength));
	const key = await importAesKey(keyBytes, ["decrypt"], crypto);
	const plaintext = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv, tagLength: TAG_BITS },
		key,
		ciphertextAndTag,
	);
	// Java's UTF-8 decoder replaces malformed input rather than throwing.
	return new TextDecoder("utf-8").decode(plaintext);
}

function requireAes(algorithm: string): void {
	if (algorithm !== "AES") {
		throw new Error(`Unsupported encryption algorithm: ${algorithm}`);
	}
}

function requireKeyLength(key: Uint8Array): void {
	if (key.length !== AES_KEY_BYTES) {
		throw new Error("AES encryption requires a 256-bit base64 key.");
	}
}

async function importAesKey(
	key: Uint8Array,
	usage: KeyUsage[],
	crypto: Pick<Crypto, "subtle">,
): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		copyBytes(key),
		"AES-GCM",
		false,
		usage,
	);
}

function copyBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
	const copy = new Uint8Array(value.byteLength);
	copy.set(value);
	return copy;
}

function decodeBase64(value: string): Uint8Array {
	/* Port CommCare Core's `org.commcare.util.Base64.decode`, rather than
	 * delegating to the browser's forgiving-base64 algorithm. `atob()` also
	 * discards form feed; Core recognizes only tab, LF, CR, and space as
	 * whitespace, and its padding checks deliberately retain the raw byte
	 * positions around those characters. */
	const source = new TextEncoder().encode(value);
	const output: number[] = [];
	const quartet: number[] = [];
	for (let index = 0; index < source.length; index += 1) {
		const raw = source[index];
		if (raw === undefined) continue;
		const cropped = raw & 0x7f;
		if (isCoreBase64Whitespace(cropped)) continue;
		if (cropped === 0x3d) {
			const bytesLeft = source.length - index;
			const last = (source[source.length - 1] ?? 0) & 0x7f;
			if (
				quartet.length === 0 ||
				quartet.length === 1 ||
				(quartet.length === 3 && bytesLeft > 2) ||
				(last !== 0x3d && last !== 0x0a)
			) {
				throw new Error("Invalid base64 value.");
			}
			break;
		}
		if (coreBase64Value(cropped) === undefined) {
			throw new Error("Invalid base64 value.");
		}
		quartet.push(cropped);
		if (quartet.length === 4) {
			decodeCoreBase64Quartet(quartet, output);
			quartet.length = 0;
		}
	}
	if (quartet.length !== 0) {
		if (quartet.length === 1) throw new Error("Invalid base64 value.");
		while (quartet.length < 4) quartet.push(0x3d);
		decodeCoreBase64Quartet(quartet, output);
	}
	return Uint8Array.from(output);
}

function isCoreBase64Whitespace(value: number): boolean {
	return value === 0x09 || value === 0x0a || value === 0x0d || value === 0x20;
}

function coreBase64Value(value: number): number | undefined {
	if (value >= 0x41 && value <= 0x5a) return value - 0x41;
	if (value >= 0x61 && value <= 0x7a) return value - 0x61 + 26;
	if (value >= 0x30 && value <= 0x39) return value - 0x30 + 52;
	if (value === 0x2b) return 62;
	if (value === 0x2f) return 63;
	return undefined;
}

function decodeCoreBase64Quartet(
	quartet: readonly number[],
	output: number[],
): void {
	const a = coreBase64Value(quartet[0] ?? -1);
	const b = coreBase64Value(quartet[1] ?? -1);
	if (a === undefined || b === undefined)
		throw new Error("Invalid base64 value.");
	output.push((a << 2) | (b >> 4));
	if (quartet[2] === 0x3d) return;
	const c = coreBase64Value(quartet[2] ?? -1);
	if (c === undefined) throw new Error("Invalid base64 value.");
	output.push(((b & 0x0f) << 4) | (c >> 2));
	if (quartet[3] === 0x3d) return;
	const d = coreBase64Value(quartet[3] ?? -1);
	if (d === undefined) throw new Error("Invalid base64 value.");
	output.push(((c & 0x03) << 6) | d);
}

function encodeBase64(value: Uint8Array): string {
	let binary = "";
	for (const byte of value) binary += String.fromCharCode(byte);
	return globalThis.btoa(binary);
}
