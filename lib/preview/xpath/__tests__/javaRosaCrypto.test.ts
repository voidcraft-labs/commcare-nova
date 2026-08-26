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

	it("round-trips UTF-8 text", async () => {
		const encrypted = await javaRosaEncryptString("Preview café", KEY, "AES");
		expect(await javaRosaDecryptString(encrypted, KEY, "AES")).toBe(
			"Preview café",
		);
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
