import { afterEach, expect, it, vi } from "vitest";
import { generateWorkerPassword } from "../workerCredentials";

afterEach(() => vi.restoreAllMocks());

it("guarantees all four typable character classes even when entropy would choose only lowercase letters", () => {
	// 255 exercises rejection of biased bytes; low accepted values would
	// otherwise produce only lowercase letters. Cycling permits distinct slots.
	const bytes = [255, 0, 1, 2, 3];
	let position = 0;
	vi.spyOn(crypto, "getRandomValues").mockImplementation((buffer) => {
		if (!(buffer instanceof Uint8Array))
			throw new Error("Expected random bytes");
		for (let index = 0; index < buffer.length; index++)
			buffer[index] = bytes[position++ % bytes.length] ?? 0;
		return buffer;
	});
	const password = generateWorkerPassword();
	expect(password).toHaveLength(20);
	expect(password).toMatch(
		/^[abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*?+=-]+$/,
	);
	for (const group of [/[a-z]/, /[A-Z]/, /[2-9]/, /[!@#$%&*?+=-]/])
		expect(password).toMatch(group);
});

it("uses fresh platform entropy for successive credentials", () => {
	const first = generateWorkerPassword(),
		second = generateWorkerPassword();
	expect(first).toHaveLength(20);
	expect(second).toHaveLength(20);
	expect(first).not.toBe(second);
});
