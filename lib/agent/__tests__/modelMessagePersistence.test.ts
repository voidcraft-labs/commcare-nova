import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
	durableModelValueDigest,
	persistModelMessage,
	persistModelValue,
	rehydrateModelMessage,
	rehydrateModelValue,
} from "@/lib/agent/modelMessagePersistence";

describe("model message persistence", () => {
	it("preserves bare and tagged URLs without turning them into base64 strings", () => {
		const message: ModelMessage = {
			role: "user",
			content: [
				{
					type: "file",
					mediaType: "image/png",
					data: new URL("https://example.test/bare.png"),
				},
				{
					type: "file",
					mediaType: "image/png",
					data: {
						type: "url",
						url: new URL("https://example.test/tagged.png"),
					},
				},
			],
		};

		const recovered = rehydrateModelMessage(persistModelMessage(message));
		if (typeof recovered.content === "string") {
			throw new Error("Recovered message content is not multipart.");
		}
		const bare = recovered.content[0];
		const tagged = recovered.content[1];
		expect(bare?.type).toBe("file");
		expect(bare?.type === "file" ? bare.data : null).toBeInstanceOf(URL);
		expect(tagged?.type).toBe("file");
		if (
			tagged?.type !== "file" ||
			typeof tagged.data !== "object" ||
			!("url" in tagged.data)
		) {
			throw new Error("Recovered tagged URL is missing.");
		}
		expect(tagged.data.url).toBeInstanceOf(URL);
	});

	it("preserves byte-valued parts as executable binary data", () => {
		const message: ModelMessage = {
			role: "user",
			content: [
				{
					type: "file",
					mediaType: "application/octet-stream",
					data: new Uint8Array([0, 127, 255]),
				},
			],
		};
		const recovered = rehydrateModelMessage(persistModelMessage(message));
		if (typeof recovered.content === "string") {
			throw new Error("Recovered message content is not multipart.");
		}
		const part = recovered.content[0];
		expect(part?.type).toBe("file");
		expect(part?.type === "file" ? part.data : null).toEqual(
			new Uint8Array([0, 127, 255]),
		);
	});

	it("does not reinterpret customer JSON that resembles persistence tags", () => {
		const value = {
			encoding: "nova-model-value-v1",
			kind: "url",
			value: "not a URL tag",
			nested: { kind: "bytes", value: "also ordinary customer data" },
		};
		expect(rehydrateModelValue(persistModelValue(value))).toEqual(value);
	});

	it("digests a URL and its text spelling differently", () => {
		expect(
			durableModelValueDigest(new URL("https://example.test/file")),
		).not.toBe(durableModelValueDigest("https://example.test/file"));
	});

	it("rejects unsupported object types instead of silently flattening them", () => {
		expect(() => persistModelValue(new Date("2026-08-12T00:00:00Z"))).toThrow(
			"cannot persist a Date",
		);
	});
});
