/** Native Request -> stored canonical document -> export gate -> real artifacts.
 * Only authentication, authoritative database reads and object storage are
 * controlled. Python's zipfile independently reads the bytes both routes emit;
 * CommCare runtime conformance belongs to the compiler's native core tests.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { requireSession } from "@/lib/auth-utils";
import { nestedMenuWireFixture } from "@/lib/commcare/__tests__/nestedMenuWireFixture";
import {
	decodeProjectSpaceCompatibilityReport,
	PROJECT_SPACE_COMPATIBILITY_REPORT_HEADER,
} from "@/lib/commcare/projectSpaceCompatibility";
import { DERIVED_WIRE_IDENTITY } from "@/lib/commcare/wireIdentity";
import { AppAccessError, resolveAppAccess } from "@/lib/db/appAccess";
import { loadAssetsByIds, type MediaAssetRecord } from "@/lib/db/mediaAssets";
import { attachmentUrlTarget } from "@/lib/deployment/attachmentTarget";
import {
	type DownloadTarget,
	resolveDownloadTarget,
} from "@/lib/deployment/downloadTarget";
import {
	chooseDownloadTarget,
	type ReachedDeploymentTarget,
} from "@/lib/deployment/runtimeTarget";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { type BlueprintDoc, blueprintDocSchema, proseText } from "@/lib/domain";
import {
	lookupColumnIdSchema,
	lookupRowIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { parseLookupRevision } from "@/lib/lookup/schema";
import { getLookupFixtureData } from "@/lib/lookup/service";
import type { LookupFixtureDataSnapshot } from "@/lib/lookup/types";
import {
	decodeExportAdvisories,
	EXPORT_ADVISORY_HEADER,
} from "@/lib/publish/exportAdvisories";
import {
	decodeManualImportGuide,
	MANUAL_IMPORT_GUIDE_HEADER,
	renderManualImportGuide,
} from "@/lib/publish/manualImportGuide";
import { downloadAssetBytes } from "@/lib/storage/media";
import { POST as jsonPost } from "../json/route";
import { POST as cczPost } from "../route";

vi.mock("@/lib/auth-utils", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/db/appAccess", async (original) => ({
	...(await original<typeof import("@/lib/db/appAccess")>()),
	resolveAppAccess: vi.fn(),
}));
vi.mock("@/lib/db/mediaAssets", () => ({ loadAssetsByIds: vi.fn() }));
vi.mock("@/lib/lookup/service", () => ({ getLookupFixtureData: vi.fn() }));
vi.mock("@/lib/storage/media", () => ({ downloadAssetBytes: vi.fn() }));
vi.mock("@/lib/deployment/downloadTarget", async (original) => ({
	...(await original<typeof import("@/lib/deployment/downloadTarget")>()),
	resolveDownloadTarget: vi.fn(),
}));

const execFileAsync = promisify(execFile);
async function unzip(bytes: Uint8Array): Promise<Map<string, Buffer>> {
	const { stdout } = await execFileAsync(
		"python3",
		[
			"-c",
			"import sys,io,zipfile,base64,json; z=zipfile.ZipFile(io.BytesIO(base64.b64decode(sys.argv[1]))); print(json.dumps({n:base64.b64encode(z.read(n)).decode() for n in z.namelist() if not n.endswith('/')}))",
			Buffer.from(bytes).toString("base64"),
		],
		{ maxBuffer: 4_000_000 },
	);
	return new Map(
		Object.entries(JSON.parse(stdout) as Record<string, string>).map(
			([name, body]) => [name, Buffer.from(body, "base64")],
		),
	);
}
function member(entries: Map<string, Buffer>, name: string): Buffer {
	const found = entries.get(name);
	if (!found)
		throw new Error(
			`Missing archive member: ${name}; found ${[...entries.keys()].join(", ")}`,
		);
	return found;
}
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6AAAAAElFTkSuQmCC",
	"base64",
);
const IMAGE = testMediaAssetId("export-image");
const HASH = createHash("sha256").update(PNG).digest("hex");
const ROW: MediaAssetRecord = {
	id: IMAGE,
	owner: "u1",
	project_id: "project-1",
	contentHash: HASH,
	mimeType: "image/png",
	kind: "image",
	extension: ".png",
	sizeBytes: PNG.length,
	gcsObjectKey: `projects/project-1/${HASH}.png`,
	originalFilename: "image.png",
	displayName: "Image",
	status: "ready",
	mediaFormat: "png",
	created_at: new Date(0),
};
const TABLE = lookupTableIdSchema.parse("018f0000-0000-7000-8000-000000000001");
const VALUE = lookupColumnIdSchema.parse(
	"018f0000-0000-7000-8000-000000000002",
);
const LABEL = lookupColumnIdSchema.parse(
	"018f0000-0000-7000-8000-000000000003",
);
function snapshot(withLookup = false): LookupFixtureDataSnapshot {
	return {
		projectId: "project-1",
		projectRevision: parseLookupRevision("7"),
		definitions: withLookup
			? [
					{
						id: TABLE,
						name: "Districts",
						tag: "districts",
						definitionRevision: parseLookupRevision("3"),
						columns: [
							{
								id: VALUE,
								wireName: "value",
								label: "Value",
								dataType: "text",
							},
							{
								id: LABEL,
								wireName: "label",
								label: "Label",
								dataType: "text",
							},
						],
					},
				]
			: [],
		rowsByTable: new Map(
			withLookup
				? [
						[
							TABLE,
							[
								{
									id: lookupRowIdSchema.parse(
										"018f0000-0000-7000-8000-000000000004",
									),
									values: { [VALUE]: "north", [LABEL]: "North district" },
								},
							],
						],
					]
				: [],
		),
	};
}
function fixture(
	options: {
		media?: boolean;
		lookup?: boolean;
		photo?: boolean;
		search?: boolean;
		name?: string;
	} = {},
): BlueprintDoc {
	const doc = buildDoc({
		appName: options.name ?? "Vaccine Tracker",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					...(options.photo
						? [{ name: "photo_url", label: proseText("Photo") }]
						: []),
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				...(options.search ? { caseSearchConfig: {} } : {}),
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
								...(options.media ? { label_media: { image: IMAGE } } : {}),
							}),
							...(options.lookup
								? [
										f({
											kind: "single_select",
											id: "district",
											label: proseText("District"),
											optionsSource: {
												kind: "lookup",
												tableId: TABLE,
												valueColumnId: VALUE,
												labelColumnId: LABEL,
											},
										}),
									]
								: []),
							...(options.photo
								? [
										f({
											kind: "image",
											id: "photo",
											label: proseText("Photo"),
											caseWrite: {
												caseType: "patient",
												property: "photo_url",
												mode: "url",
											},
										}),
									]
								: []),
						],
					},
				],
			},
		],
	});
	blueprintDocSchema.parse(toPersistableDoc(doc));
	const data = snapshot(options.lookup);
	const verdict = mutationCommitVerdict(doc, [], {
		kind: "available",
		projectId: data.projectId,
		projectRevision: data.projectRevision,
		definitions: data.definitions,
	});
	if (!verdict.ok) throw new Error(JSON.stringify(verdict.findings));
	return doc;
}
const ACME: ReachedDeploymentTarget = {
	server: "india",
	domain: "acme",
	hqAppId: "0123456789abcdef0123456789abcdef",
	emptyCaseListText: false,
	earlierHqApps: 0,
};
/** What the ledger answers for a `.ccz` made for one reached deployment. */
function cczFor(target: ReachedDeploymentTarget): DownloadTarget {
	return {
		format: "ccz",
		target,
		runtimeTarget: {
			server: target.server,
			domain: target.domain,
			appId: target.hqAppId,
		},
		identity: DERIVED_WIRE_IDENTITY,
		attachmentTarget: attachmentUrlTarget(target),
		reached: [target],
	};
}
/** What the ledger answers for the import file, scoped to `reached`. */
function importFileFor(
	reached: readonly ReachedDeploymentTarget[],
): DownloadTarget {
	const [only] = reached;
	return {
		format: "json",
		attachmentTarget:
			reached.length === 1 && only ? attachmentUrlTarget(only) : null,
		reached,
	};
}
function answers(
	ccz: DownloadTarget,
	json: DownloadTarget = importFileFor([]),
) {
	vi.mocked(resolveDownloadTarget).mockImplementation(async (_scope, input) =>
		input.format === "ccz" ? ccz : json,
	);
}
function loads(doc: BlueprintDoc, seq = 42) {
	vi.mocked(resolveAppAccess).mockResolvedValue({
		app: { blueprint: toPersistableDoc(doc), mutation_seq: seq },
		projectId: "project-1",
		actorUserId: "u1",
		role: "viewer",
	} as never);
}
function request(body: unknown = { appId: "a1", server: "production" }) {
	return new NextRequest("http://localhost/api/compile", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}
beforeEach(() => {
	vi.mocked(requireSession).mockResolvedValue({ user: { id: "u1" } } as never);
	vi.mocked(loadAssetsByIds).mockResolvedValue([]);
	vi.mocked(getLookupFixtureData).mockResolvedValue(snapshot());
	vi.mocked(downloadAssetBytes).mockResolvedValue(PNG);
	answers(cczFor(ACME));
	loads(fixture());
});

for (const [mode, post, verb] of [
	["ccz", cczPost, "compile"],
	["json", jsonPost, "export"],
] as const) {
	describe(`POST /api/compile${mode === "json" ? "/json" : ""}`, () => {
		it("exports the stored document and exact sequence as a readable artifact", async () => {
			loads(fixture(), 99);
			const response = await post(request());
			const bytes = new Uint8Array(await response.arrayBuffer());
			expect(response.status).toBe(200);
			expect(response.headers.get("content-disposition")).toBe(
				`attachment; filename="Vaccine Tracker.${mode === "json" ? "zip" : "ccz"}"`,
			);
			expect(resolveAppAccess).toHaveBeenCalledWith("a1", "u1", "view");
			expect(getLookupFixtureData).toHaveBeenCalledTimes(1);
			expect(getLookupFixtureData).toHaveBeenCalledWith(
				{ projectId: "project-1", actorId: "u1", role: "viewer" },
				[],
			);
			if (mode === "json") {
				expect(response.headers.get("x-compiled-at-seq")).toBe("99");
				const entries = await unzip(bytes);
				expect([...entries.keys()].sort()).toEqual([
					"README.txt",
					"Vaccine Tracker.json",
				]);
				const app = JSON.parse(
					member(entries, "Vaccine Tracker.json").toString(),
				);
				expect(app.name).toBe("Vaccine Tracker");
				expect(
					app._attachments[`${app.modules[0].forms[0].unique_id}.xml`],
				).toContain("case_name");
				const guide = decodeManualImportGuide(
					response.headers.get(MANUAL_IMPORT_GUIDE_HEADER),
				);
				/* The app runs in Web Apps, so the plan step names Web-Based Apps. */
				expect(guide.map((step) => step.kind)).toEqual([
					"import-app",
					"commcare-version",
					"plan-features",
				]);
				expect(member(entries, "README.txt").toString()).toBe(
					renderManualImportGuide(guide),
				);
			} else {
				expect(response.headers.get("content-length")).toBe(
					String(bytes.length),
				);
				const entries = await unzip(bytes);
				const xml = [...entries.values()]
					.map((entry) => entry.toString())
					.join("\n");
				expect(xml).toContain('key="cc-content-version" value="99"');
				expect(xml).toContain("case_name");
				const profile = member(entries, "profile.ccpr").toString();
				expect(profile).toContain('key="cc-content-version" value="99"');
				for (const property of [
					'key="ota-restore-url" value="https://india.commcarehq.org/a/acme/phone/restore/0123456789abcdef0123456789abcdef/" force="true"',
					'key="PostURL" value="https://india.commcarehq.org/a/acme/receiver/0123456789abcdef0123456789abcdef/" force="true"',
					'key="key_server" value="https://india.commcarehq.org/a/acme/phone/keys/" force="true"',
					'key="cc_user_domain" value="acme.commcarehq.org" force="true"',
				])
					expect(profile).toContain(property);
			}
			expect(
				decodeProjectSpaceCompatibilityReport(
					response.headers.get(PROJECT_SPACE_COMPATIBILITY_REPORT_HEADER),
				)?.status,
			).toBe("not_needed");
			expect(
				decodeExportAdvisories(response.headers.get(EXPORT_ADVISORY_HEADER)),
			).toEqual([]);
		});
		it("refuses missing app identity without loading anything", async () => {
			const response = await post(request({}));
			expect(await response.json()).toMatchObject({
				error: "appId is required",
			});
			expect(response.status).toBe(400);
			expect(resolveAppAccess).not.toHaveBeenCalled();
			expect(getLookupFixtureData).not.toHaveBeenCalled();
		});
		it("preserves private not-found refusal before external reads", async () => {
			vi.mocked(resolveAppAccess).mockRejectedValueOnce(
				new AppAccessError("not_member"),
			);
			const response = await post(request());
			expect(await response.json()).toMatchObject({ error: "App not found" });
			expect(response.status).toBe(404);
			expect(getLookupFixtureData).not.toHaveBeenCalled();
		});
		it.each(["parent-multiple", "same-smaller"] as const)(
			"propagates the real HQ-only nested selection refusal for %s",
			async (scenario) => {
				const doc = nestedMenuWireFixture(scenario);
				loads(doc);
				const response = await post(request());
				expect(resolveDownloadTarget).toHaveBeenCalledWith(
					expect.objectContaining({ appId: "a1", projectId: "project-1" }),
					expect.objectContaining({
						doc: expect.objectContaining({ moduleOrder: doc.moduleOrder }),
					}),
				);
				if (mode === "ccz") {
					expect(response.status).toBe(200);
					expect(
						(await unzip(new Uint8Array(await response.arrayBuffer()))).has(
							"suite.xml",
						),
					).toBe(true);
				} else {
					expect(response.status).toBe(422);
					expect(await response.json()).toMatchObject({
						error:
							"This app isn't ready to export. Fix the issues below, then try again.",
						details: [
							expect.stringContaining(
								scenario === "parent-multiple"
									? "several cases selected"
									: "4 selected cases",
							),
						],
					});
					expect(downloadAssetBytes).not.toHaveBeenCalled();
				}
			},
		);
		it("runs the real media gate before downloading a mismatched asset", async () => {
			loads(fixture({ media: true }));
			vi.mocked(loadAssetsByIds).mockResolvedValue([
				{
					...ROW,
					kind: "audio",
					mimeType: "audio/mpeg",
					extension: ".mp3",
					mediaFormat: "mp3",
				},
			]);
			const response = await post(request());
			expect(await response.json()).toMatchObject({
				error: `This app isn't ready to ${verb}. Fix the issues below, then try again.`,
				details: expect.arrayContaining([
					expect.stringContaining("wrong type"),
				]),
			});
			expect(response.status).toBe(422);
			expect(loadAssetsByIds).toHaveBeenCalledWith([IMAGE], "project-1");
			expect(downloadAssetBytes).not.toHaveBeenCalled();
		});
		it("keeps an operational lookup failure out of document findings", async () => {
			vi.mocked(getLookupFixtureData).mockRejectedValueOnce(
				new Error("database private failure"),
			);
			const response = await post(request());
			const body = await response.json();
			expect(response.status).toBe(500);
			expect(body.error).not.toContain("private");
			expect(body.error).not.toContain("isn't ready");
			expect(downloadAssetBytes).not.toHaveBeenCalled();
		});
		it("emits unchecked destination compatibility beside valid bytes", async () => {
			loads(fixture({ search: true }));
			const response = await post(request());
			const bytes = await response.arrayBuffer();
			expect(response.status).toBe(200);
			const report = decodeProjectSpaceCompatibilityReport(
				response.headers.get(PROJECT_SPACE_COMPATIBILITY_REPORT_HEADER),
			);
			expect(report?.status).toBe("not_checked");
			expect(report?.required_capabilities).toEqual([
				expect.objectContaining({ id: "case-search", state: "not_checked" }),
			]);
			const entries = await unzip(new Uint8Array(bytes));
			if (mode === "ccz") expect(entries.size).toBeGreaterThan(2);
			else {
				expect(
					JSON.parse(member(entries, "Vaccine Tracker.json").toString())
						.modules,
				).toHaveLength(1);
				expect(
					decodeManualImportGuide(
						response.headers.get(MANUAL_IMPORT_GUIDE_HEADER),
					).map((step) => step.kind),
				).toEqual([
					"import-app",
					"commcare-version",
					"capabilities",
					"plan-features",
				]);
			}
		});
		it.each(mode === "ccz" ? [true] : [false, true])(
			"binds captured links to the deployment the download names: %s",
			async (known) => {
				loads(fixture({ photo: true }));
				answers(cczFor(ACME), importFileFor(known ? [ACME] : []));
				const response = await post(request({ appId: "a1" }));
				const bytes = new Uint8Array(await response.arrayBuffer());
				expect(response.status).toBe(200);
				const text = [...(await unzip(bytes)).values()]
					.map((entry) => entry.toString())
					.join("\n");
				if (known)
					expect(text).toContain("https://india.commcarehq.org/a/acme/");
				else expect(text).not.toContain("https://india.commcarehq.org/a/acme/");
				const advisories = decodeExportAdvisories(
					response.headers.get(EXPORT_ADVISORY_HEADER),
				);
				expect(advisories.map((item) => item.id)).toEqual(
					known ? [] : ["attachment_links_without_target"],
				);
			},
		);
	});
}

it("bundles the referenced ready image with JSON and a matching XForm reference", async () => {
	loads(fixture({ media: true, name: "Vaccinés 中文" }));
	vi.mocked(loadAssetsByIds).mockResolvedValue([ROW]);
	const response = await jsonPost(request());
	const bytes = new Uint8Array(await response.arrayBuffer());
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toBe("application/zip");
	expect(response.headers.get("x-compiled-at-seq")).toBe("42");
	const entries = await unzip(bytes);
	const jsonName = [...entries.keys()].find((name) => name.endsWith(".json"));
	expect(jsonName).toBe("Vaccinés 中文.json");
	const app = JSON.parse(member(entries, jsonName ?? "").toString());
	expect(
		app._attachments[`${app.modules[0].forms[0].unique_id}.xml`],
	).toContain(`jr://file/commcare/${HASH}.png`);
	const images = await unzip(member(entries, "multimedia.zip"));
	expect([...images.keys()]).toEqual([`commcare/${HASH}.png`]);
	expect(member(images, `commcare/${HASH}.png`)).toEqual(PNG);
	expect(member(entries, "README.txt").toString()).toContain("multimedia.zip");
	expect(downloadAssetBytes).toHaveBeenCalledWith(
		ROW.gcsObjectKey,
		expect.any(Number),
	);
});

it("ships a readable workbook generated from the same lookup rows as the app reference", async () => {
	loads(fixture({ lookup: true }));
	vi.mocked(getLookupFixtureData).mockResolvedValue(snapshot(true));
	const response = await jsonPost(request());
	const bytes = new Uint8Array(await response.arrayBuffer());
	expect(response.status).toBe(200);
	const entries = await unzip(bytes);
	expect(entries.has("multimedia.zip")).toBe(false);
	const app = JSON.parse(member(entries, "Vaccine Tracker.json").toString());
	expect(
		app._attachments[`${app.modules[0].forms[0].unique_id}.xml`],
	).toContain("districts");
	const workbook = await unzip(member(entries, "lookup-tables.xlsx"));
	const xml = [...workbook.values()]
		.map((entry) => entry.toString())
		.join("\n");
	expect(xml).toContain("North district");
	expect(xml).toContain("north");
	expect(member(entries, "README.txt").toString()).toContain("districts");
	expect(getLookupFixtureData).toHaveBeenCalledTimes(1);
	expect(getLookupFixtureData).toHaveBeenCalledWith(expect.anything(), [TABLE]);
});

const SEVERAL: readonly ReachedDeploymentTarget[] = [
	ACME,
	{
		server: "production",
		domain: "acme",
		hqAppId: "1".repeat(32),
		emptyCaseListText: false,
		earlierHqApps: 0,
	},
];
it.each([
	[
		"needs-published-project-space",
		chooseDownloadTarget([], { format: "ccz", declaresAndroid: true }),
		[],
	],
	[
		"pick-project-space",
		chooseDownloadTarget(SEVERAL, { format: "ccz", declaresAndroid: true }),
		["acme on India", "acme on US"],
	],
	[
		"unknown-project-space",
		chooseDownloadTarget(SEVERAL, {
			format: "ccz",
			declaresAndroid: true,
			domain: "field-ops",
		}),
		["acme on India", "acme on US"],
	],
	[
		"selection-held-from-hq",
		chooseDownloadTarget([], {
			format: "ccz",
			declaresAndroid: true,
			heldFromHq: ["The first line.", "The second line."],
		}),
		["The first line.", "The second line."],
	],
	[
		"not-declared-for-android",
		chooseDownloadTarget(SEVERAL, { format: "ccz", declaresAndroid: false }),
		[],
	],
] as const)(
	"refuses a CCZ with %s, listing what the person can act on and reading no Project data",
	async (reason, refusal, details) => {
		expect(refusal).toMatchObject({ kind: "refused", reason });
		if (refusal.kind !== "refused") throw new Error("Expected a refusal");
		vi.mocked(resolveDownloadTarget).mockResolvedValueOnce(refusal);
		const response = await cczPost(
			request({ appId: "a1", server: "india", domain: "field-ops" }),
		);
		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({
			error: refusal.message,
			...(details.length > 0 && { details }),
		});
		expect(resolveDownloadTarget).toHaveBeenLastCalledWith(
			expect.objectContaining({ appId: "a1" }),
			expect.objectContaining({
				format: "ccz",
				server: "india",
				domain: "field-ops",
			}),
		);
		expect(getLookupFixtureData).not.toHaveBeenCalled();
		expect(loadAssetsByIds).not.toHaveBeenCalled();
	},
);
it("refuses a project space for the import file", async () => {
	const refusal = chooseDownloadTarget([ACME], {
		format: "json",
		declaresAndroid: true,
		domain: "acme",
	});
	if (refusal.kind !== "refused") throw new Error("Expected a refusal");
	vi.mocked(resolveDownloadTarget).mockResolvedValueOnce(refusal);
	const response = await jsonPost(request({ appId: "a1", domain: "acme" }));
	expect(response.status).toBe(422);
	expect(await response.json()).toEqual({ error: refusal.message });
	expect(refusal.reason).toBe("domain-not-for-import-file");
	expect(getLookupFixtureData).not.toHaveBeenCalled();
});
it.each([42, "", {}])(
	"refuses an invalid project space before any read: %j",
	async (domain) => {
		const response = await cczPost(request({ appId: "a1", domain }));
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "Choose a project space by its name.",
		});
		expect(resolveDownloadTarget).not.toHaveBeenCalled();
		expect(getLookupFixtureData).not.toHaveBeenCalled();
	},
);
it.each([42, "other-server", {}])(
	"refuses an invalid server before export resource reads: %j",
	async (server) => {
		const response = await cczPost(request({ appId: "a1", server }));
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "Choose US, India, or EU as the CommCare server.",
		});
		expect(getLookupFixtureData).not.toHaveBeenCalled();
	},
);
it("drops India capture addresses when explicitly exporting for EU", async () => {
	loads(fixture({ photo: true }));
	/* India holds the app and EU does not, so the server narrows to none. */
	vi.mocked(resolveDownloadTarget).mockResolvedValueOnce(importFileFor([]));
	const response = await jsonPost(request({ appId: "a1", server: "eu" }));
	expect(response.status).toBe(200);
	expect(resolveDownloadTarget).toHaveBeenLastCalledWith(
		expect.anything(),
		expect.objectContaining({ format: "json", server: "eu" }),
	);
	const app = JSON.parse(
		member(
			await unzip(new Uint8Array(await response.arrayBuffer())),
			"Vaccine Tracker.json",
		).toString(),
	);
	const source = app._attachments[`${app.modules[0].forms[0].unique_id}.xml`];
	expect(source).not.toContain("https://india.commcarehq.org/a/acme/");
	expect(
		decodeExportAdvisories(response.headers.get(EXPORT_ADVISORY_HEADER)).map(
			(item) => item.id,
		),
	).toEqual(["attachment_links_without_target"]);
});
