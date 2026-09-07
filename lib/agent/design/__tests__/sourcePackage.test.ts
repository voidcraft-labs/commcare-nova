/** Pure projection rules use complete metadata and real image bytes. Native
 * Project lookup, extract reading and byte hashing live in the Postgres suite. */
import { expect, it, vi } from "vitest";
import type { NovaUIMessage } from "@/lib/chat/attachmentRefs";
import { EXTRACTOR_VERSION } from "@/lib/domain/multimedia";
import { sourceClaimSchema } from "../evidence";
import {
	buildDesignSourcePackage,
	citableSourceRefs,
	computeSourcePackageDigest,
	computeSourcePackageExtensionProof,
	MAX_ATTACHMENT_EXTRACT_CHARS,
	MAX_DOCUMENT_ATTACHMENTS,
	MAX_IMAGE_ATTACHMENTS,
	MAX_REQUEST_BLOCK_CHARS,
	MAX_TOTAL_PROJECTED_CHARS,
	type SourcePackageDeps,
	SourcePackageError,
	sourcePackageProofExtends,
	toPersistedSourcePackage,
} from "../sourcePackage";
import {
	SOURCE_DOCUMENT,
	SOURCE_IMAGE,
	SOURCE_PNG,
	SOURCE_PROJECT,
	SOURCE_SESSION,
	SOURCE_TEXT,
	SOURCE_THREAD,
	sourceAsset,
	sourceDigest,
	sourceMessage,
	sourceRef,
} from "./sourcePackageFixtures";

function resources(overrides: Partial<SourcePackageDeps> = {}) {
	return {
		loadAssets: vi.fn<SourcePackageDeps["loadAssets"]>(async (ids) =>
			ids.map((id) => sourceAsset(id)),
		),
		readExtract: vi.fn<SourcePackageDeps["readExtract"]>(async () => ({
			text: SOURCE_TEXT,
			truncated: false,
		})),
		loadImage: vi.fn<SourcePackageDeps["loadImage"]>(async () => ({
			mediaType: "image/png",
			dataUrl: `data:image/png;base64,${SOURCE_PNG.toString("base64")}`,
			bytesDigest: sourceDigest(SOURCE_PNG),
		})),
		...overrides,
	};
}
function args(messages: NovaUIMessage[], deps = resources()) {
	return {
		designSessionId: SOURCE_SESSION,
		threadId: SOURCE_THREAD,
		projectId: SOURCE_PROJECT,
		messages,
		deps,
	};
}
const ref = (messageId: string, partIndex = 0) => ({
	kind: "message" as const,
	threadId: SOURCE_THREAD,
	messageId,
	partIndex,
});
const documentRef = {
	kind: "attachment-extract" as const,
	assetId: SOURCE_DOCUMENT,
	extractorVersion: EXTRACTOR_VERSION,
	sectionPath: [],
};
const imageRef = {
	kind: "image" as const,
	assetId: SOURCE_IMAGE,
	bytesDigest: sourceDigest(SOURCE_PNG),
};

it("preserves actual part coordinates, user order, first attachment labels and citable source grouping", async () => {
	const first = sourceMessage("m1", "ignored", [
		sourceRef(SOURCE_IMAGE),
		sourceRef(SOURCE_DOCUMENT),
	]);
	first.parts = [
		{ type: "text", text: "  " },
		{
			type: "file",
			mediaType: "image/png",
			url: "https://example.invalid/ignored.png",
		},
		{ type: "text", text: "  Build visits. \n" },
		{ type: "text", text: "Track outcomes." },
	];
	const assistant: NovaUIMessage = {
		id: "a1",
		role: "assistant",
		parts: [{ type: "text", text: "Not source text" }],
		metadata: { attachments: [sourceRef(crypto.randomUUID())] },
	};
	const duplicate = {
		...sourceRef(SOURCE_DOCUMENT),
		filename: "later-name.txt",
	};
	const messages = [
		first,
		assistant,
		sourceMessage("m2", "Supervisor queue.", [duplicate]),
	];
	const saved = structuredClone(messages);
	const deps = resources();
	const pkg = await buildDesignSourcePackage(args(messages, deps));
	expect(pkg.request.blocks).toEqual([
		{ ref: ref("m1", 2), text: "Build visits.", truncated: false },
		{ ref: ref("m1", 3), text: "Track outcomes.", truncated: false },
		{ ref: ref("m2"), text: "Supervisor queue.", truncated: false },
	]);
	expect(pkg.attachments).toEqual([
		{
			assetId: SOURCE_DOCUMENT,
			extractorVersion: EXTRACTOR_VERSION,
			filename: "requirements.txt",
			title: "Program requirements",
			summary: "Patient visits.",
			extract: SOURCE_TEXT,
			truncated: false,
		},
	]);
	expect(pkg.images).toEqual([
		{
			assetId: SOURCE_IMAGE,
			filename: "mockup.png",
			mediaType: "image/png",
			bytesDigest: sourceDigest(SOURCE_PNG),
			dataUrl: `data:image/png;base64,${SOURCE_PNG.toString("base64")}`,
		},
	]);
	expect(pkg.sources).toEqual(
		[ref("m1", 2), ref("m1", 3), ref("m2"), documentRef, imageRef].map(
			(ref) => ({ ref }),
		),
	);
	expect(deps.loadAssets).toHaveBeenCalledExactlyOnceWith(
		[SOURCE_DOCUMENT, SOURCE_IMAGE],
		SOURCE_PROJECT,
	);
	expect(deps.readExtract).toHaveBeenCalledExactlyOnceWith(
		sourceAsset(SOURCE_DOCUMENT),
		"text",
	);
	expect(deps.loadImage).toHaveBeenCalledOnce();
	expect(messages).toEqual(saved);
	const { packageDigest, ...unsealed } = pkg;
	expect(computeSourcePackageDigest(unsealed)).toBe(packageDigest);
});

it("persists coordinates and UTF-8 byte accounting without copying source bodies", async () => {
	const pkg = await buildDesignSourcePackage(
		args([
			sourceMessage("m1", "é漢", [
				sourceRef(SOURCE_DOCUMENT),
				sourceRef(SOURCE_IMAGE),
			]),
		]),
	);
	const persisted = toPersistedSourcePackage(pkg);
	expect(persisted).toEqual({
		schemaVersion: 1,
		designSessionId: SOURCE_SESSION,
		projectId: SOURCE_PROJECT,
		packageDigest: pkg.packageDigest,
		claims: [],
		sources: [ref("m1"), documentRef, imageRef],
		requestBlockCount: 1,
		attachmentCount: 1,
		imageCount: 1,
		projectedBytes: 5 + Buffer.byteLength(SOURCE_TEXT),
		extensionProof: computeSourcePackageExtensionProof(pkg),
	});
	expect(JSON.stringify(persisted)).not.toContain(SOURCE_TEXT);
	expect(JSON.stringify(persisted)).not.toContain("é漢");
	expect(JSON.stringify(persisted)).not.toContain("base64");
});

it.each([MAX_REQUEST_BLOCK_CHARS, MAX_REQUEST_BLOCK_CHARS + 1])(
	"clips request parts only beyond the %i boundary",
	async (size) => {
		const pkg = await buildDesignSourcePackage(
			args([sourceMessage("m1", `  ${"x".repeat(size)}  `)]),
		);
		expect(pkg.request.blocks).toEqual([
			{
				ref: ref("m1"),
				text: "x".repeat(MAX_REQUEST_BLOCK_CHARS),
				truncated: size > MAX_REQUEST_BLOCK_CHARS,
			},
		]);
	},
);
it.each([
	[MAX_ATTACHMENT_EXTRACT_CHARS, false],
	[MAX_ATTACHMENT_EXTRACT_CHARS + 1, false],
	[12, true],
] as const)(
	"projects extract length %i with stored truncation %s",
	async (size, truncated) => {
		const deps = resources({
			readExtract: async () => ({ text: `  ${"x".repeat(size)}  `, truncated }),
		});
		const pkg = await buildDesignSourcePackage(
			args([sourceMessage("m1", "Build", [sourceRef(SOURCE_DOCUMENT)])], deps),
		);
		expect(pkg.attachments[0]?.extract).toBe(
			"x".repeat(Math.min(size, MAX_ATTACHMENT_EXTRACT_CHARS)),
		);
		expect(pkg.attachments[0]?.truncated).toBe(
			truncated || size > MAX_ATTACHMENT_EXTRACT_CHARS,
		);
	},
);

it.each([0, 1])(
	"enforces the aggregate projection ceiling with %i excess characters before loading images",
	async (excess) => {
		const messages = Array.from(
			{ length: MAX_TOTAL_PROJECTED_CHARS / MAX_REQUEST_BLOCK_CHARS },
			(_, i) => sourceMessage(`m${i}`, "x".repeat(MAX_REQUEST_BLOCK_CHARS)),
		);
		if (excess) messages.push(sourceMessage("excess", "x"));
		messages[0].metadata = { attachments: [sourceRef(SOURCE_IMAGE)] };
		const deps = resources();
		if (excess) {
			await expect(
				buildDesignSourcePackage(args(messages, deps)),
			).rejects.toThrow(/design ceiling/);
			expect(deps.loadImage).not.toHaveBeenCalled();
		} else
			expect(
				(await buildDesignSourcePackage(args(messages, deps))).images,
			).toHaveLength(1);
	},
);

it.each(["text", "image"] as const)(
	"admits exactly the %s count and rejects one extra before resource loading",
	async (kind) => {
		const max =
			kind === "text" ? MAX_DOCUMENT_ATTACHMENTS : MAX_IMAGE_ATTACHMENTS;
		const attachments = Array.from({ length: max }, () =>
			sourceRef(crypto.randomUUID(), kind),
		);
		const deps = resources({
			loadAssets: async (ids) => ids.map((id) => sourceAsset(id, kind)),
		});
		const pkg = await buildDesignSourcePackage(
			args([sourceMessage("m1", "Build", attachments)], deps),
		);
		expect(kind === "text" ? pkg.attachments.length : pkg.images.length).toBe(
			max,
		);
		const noResources = resources();
		await expect(
			buildDesignSourcePackage(
				args(
					[
						sourceMessage("m1", "Build", [
							...attachments,
							sourceRef(crypto.randomUUID(), kind),
						]),
					],
					noResources,
				),
			),
		).rejects.toThrow(/bounded at/);
		expect(noResources.loadAssets).not.toHaveBeenCalled();
	},
);

it("refuses empty user text and empty extracts without proceeding to images", async () => {
	const deps = resources({
		readExtract: async () => ({ text: " \n ", truncated: false }),
	});
	await expect(
		buildDesignSourcePackage(
			args(
				[
					{
						id: "a1",
						role: "assistant",
						parts: [{ type: "text", text: "Build" }],
					},
					sourceMessage("m1", "   "),
				],
				deps,
			),
		),
	).rejects.toBeInstanceOf(SourcePackageError);
	expect(deps.loadAssets).not.toHaveBeenCalled();
	await expect(
		buildDesignSourcePackage(
			args(
				[
					sourceMessage("m1", "Build", [
						sourceRef(SOURCE_DOCUMENT),
						sourceRef(SOURCE_IMAGE),
					]),
				],
				deps,
			),
		),
	).rejects.toThrow(/empty extract/);
	expect(deps.loadImage).not.toHaveBeenCalled();
});
it("propagates resource failures without producing a partial package", async () => {
	const failure = new Error("Storage unavailable");
	await expect(
		buildDesignSourcePackage(
			args(
				[sourceMessage("m1", "Build", [sourceRef(SOURCE_DOCUMENT)])],
				resources({
					readExtract: async () => {
						throw failure;
					},
				}),
			),
		),
	).rejects.toBe(failure);
});

it("deduplicates cited source identities while retaining additional claim coordinates", async () => {
	const claim = sourceClaimSchema.parse({
		id: crypto.randomUUID(),
		statement: "A figure describes the workflow.",
		sourceRefs: [
			ref("m1"),
			{ ...documentRef, sectionPath: ["Workflow"], figureMarker: "1" },
			ref("answer", 2),
		],
	});
	const pkg = await buildDesignSourcePackage({
		...args([sourceMessage("m1", "Build", [sourceRef(SOURCE_DOCUMENT)])]),
		claims: [claim],
	});
	expect(citableSourceRefs(pkg)).toEqual([
		ref("m1"),
		documentRef,
		ref("answer", 2),
	]);
	expect(toPersistedSourcePackage(pkg).claims).toEqual([claim]);
});

it("allows cumulative additions even when the grouped source index shifts", async () => {
	const oldMessages = [
		sourceMessage("m1", "Build", [
			sourceRef(SOURCE_DOCUMENT),
			sourceRef(SOURCE_IMAGE),
		]),
	];
	const previous = await buildDesignSourcePackage(args(oldMessages));
	const next = await buildDesignSourcePackage(
		args([...oldMessages, sourceMessage("m2", "Supervisor queue")]),
	);
	const a = computeSourcePackageExtensionProof(previous),
		b = computeSourcePackageExtensionProof(next);
	expect(sourcePackageProofExtends(a, a)).toBe(true);
	expect(sourcePackageProofExtends(a, b)).toBe(true);
	expect(sourcePackageProofExtends(b, a)).toBe(false);
	expect(sourcePackageProofExtends(undefined, b)).toBe(false);
	expect(sourcePackageProofExtends(a, undefined)).toBe(false);
});

it.each([
	"foundation",
	"request",
	"claim",
	"attachment",
	"image",
	"source-index",
] as const)(
	"refuses inherited work after changing a prior %s unit",
	async (family) => {
		const claim = sourceClaimSchema.parse({
			id: crypto.randomUUID(),
			statement: "Track patients",
			sourceRefs: [ref("m1")],
		});
		const previous = await buildDesignSourcePackage({
			...args([
				sourceMessage("m1", "Build", [
					sourceRef(SOURCE_DOCUMENT),
					sourceRef(SOURCE_IMAGE),
				]),
				sourceMessage("m2", "Visits"),
			]),
			claims: [claim],
		});
		const next = structuredClone(previous);
		if (family === "foundation") next.projectId = "changed-project";
		if (family === "request") next.request.blocks.reverse();
		if (family === "claim") next.claims[0].statement = "Changed requirement";
		if (family === "attachment")
			next.attachments[0].extract = "Changed extract";
		if (family === "image")
			next.images[0].bytesDigest = sourceDigest("changed bytes");
		if (family === "source-index") next.sources.pop();
		expect(
			sourcePackageProofExtends(
				computeSourcePackageExtensionProof(previous),
				computeSourcePackageExtensionProof(next),
			),
		).toBe(false);
		expect(computeSourcePackageDigest(next)).not.toBe(previous.packageDigest);
	},
);
