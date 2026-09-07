import { createCipheriv, createDecipheriv } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	javaRosaDecryptString,
	javaRosaEncryptString,
} from "../javaRosaCrypto";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ZERO_IV = new Uint8Array(12);

describe("JavaRosa AES functions", () => {
	it("uses Core's framed AES-256-GCM wire format", async () => {
		const encrypted = await javaRosaEncryptString("", KEY, "AES", {
			randomBytes: () => ZERO_IV,
		});
		// 0c || 12-byte IV || AES-256-GCM authentication tag for empty plaintext.
		expect(encrypted).toBe("DAAAAAAAAAAAAAAAAFMPivvHRTa5qWO08cTLc4s=");
		expect(await javaRosaDecryptString(encrypted, KEY, "AES")).toBe("");
	});

	it("interoperates with independent Node AES-GCM encryption and decryption", async () => {
		const message = "Preview café 👩‍💻";
		const key = Buffer.alloc(32, 0x3b);
		const iv = Buffer.alloc(12, 0xa7);
		const cipher = createCipheriv("aes-256-gcm", key, iv);
		const ciphertext = Buffer.concat([
			cipher.update(message, "utf8"),
			cipher.final(),
		]);
		const nativePayload = Buffer.concat([
			Buffer.from([12]),
			iv,
			ciphertext,
			cipher.getAuthTag(),
		]);
		expect(
			await javaRosaDecryptString(
				nativePayload.toString("base64"),
				key.toString("base64"),
				"AES",
			),
		).toBe(message);
		const encoded = await javaRosaEncryptString(
			message,
			key.toString("base64"),
			"AES",
		);
		const payload = Buffer.from(encoded, "base64");
		expect(payload[0]).toBe(12);
		const decipher = createDecipheriv(
			"aes-256-gcm",
			key,
			payload.subarray(1, 13),
		);
		decipher.setAuthTag(payload.subarray(-16));
		expect(
			Buffer.concat([
				decipher.update(payload.subarray(13, -16)),
				decipher.final(),
			]).toString("utf8"),
		).toBe(message);
	});

	it("rejects authenticated payloads with a changed IV, ciphertext, tag or key", async () => {
		const encoded = await javaRosaEncryptString("private answer", KEY, "AES", {
			randomBytes: () => ZERO_IV,
		});
		const original = Buffer.from(encoded, "base64");
		for (const index of [1, 13, original.length - 1]) {
			const tampered = Buffer.from(original);
			tampered[index] = (tampered[index] ?? 0) ^ 1;
			await expect(
				javaRosaDecryptString(tampered.toString("base64"), KEY, "AES"),
			).rejects.toThrow();
		}
		await expect(
			javaRosaDecryptString(
				encoded,
				Buffer.alloc(32, 1).toString("base64"),
				"AES",
			),
		).rejects.toThrow();
	});

	it("rejects unsupported algorithms, keys, and malformed payloads", async () => {
		await expect(javaRosaEncryptString("x", KEY, "DES")).rejects.toThrow(
			"Unsupported encryption algorithm",
		);
		await expect(javaRosaEncryptString("x", "AA==", "AES")).rejects.toThrow(
			"256-bit",
		);
		await expect(javaRosaDecryptString("AA==", KEY, "AES")).rejects.toThrow(
			"Invalid CommCare",
		);
		await expect(
			javaRosaEncryptString("x", `${KEY.slice(0, 4)}\f${KEY.slice(4)}`, "AES"),
		).rejects.toThrow("Invalid base64 value");
	});

	it("accepts only Core's four base64 whitespace bytes", async () => {
		const encrypted = await javaRosaEncryptString("", `\t${KEY}`, "AES", {
			randomBytes: () => ZERO_IV,
		});
		expect(encrypted).toBe("DAAAAAAAAAAAAAAAAFMPivvHRTa5qWO08cTLc4s=");
	});
});
