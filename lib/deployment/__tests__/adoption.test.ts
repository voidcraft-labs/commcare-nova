/**
 * What an adopted deployment records at its birth, from the reading and the
 * source the create accepted. Pure: no store and no CommCare HQ.
 */

import { gunzipSync } from "node:zlib";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { MEDIA_PATH_FLOOR_CASES } from "@/lib/case-store/migrations/__tests__/mediaPathFloor";
import { caseOperationFixture } from "@/lib/commcare/__tests__/caseOperationFixture";
import { connectWireFixtures } from "@/lib/commcare/__tests__/connectWireFixtures";
import { syntheticModuleUuid } from "@/lib/commcare/emissionPlan";
import { expandDoc } from "@/lib/commcare/expander";
import type {
	HqAlignedForm,
	HqAlignedModule,
} from "@/lib/commcare/hq/appReading";
import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import { wirePathFor } from "@/lib/commcare/multimedia/assetWirePath";
import { DERIVED_WIRE_IDENTITY } from "@/lib/commcare/wireIdentity";
import type { BlueprintDoc, TargetedCaseOperation, Uuid } from "@/lib/domain";
import { authoredCaseIdPrefix } from "@/lib/domain/caseOperationIdentity";
import { eq, literal } from "@/lib/domain/expression";
import type { MediaAssetId } from "@/lib/domain/multimedia";
import {
	type FirstPublishView,
	firstPublishViewFromStored,
} from "@/lib/publish/firstPublishChangeIds";
import {
	type AdoptedMediaFile,
	adoptedAppBaselineWrite,
	adoptedIdentityRows,
	adoptedKeyedCaseIdRows,
	adoptionPlanFeatureConfirmations,
	assignMediaPaths,
	isHoldableWirePath,
	keyedCaseIdPrefixesFor,
} from "../adoption";
import { normalizeHqAppSource } from "../hqSourceBaseline";

const TARGET = { server: "production", domain: "field-ops" } as const;

// ── adoptedIdentityRows ──────────────────────────────────────────────────

const MENU = testUuid("adoption-menu");
const FORM = testUuid("adoption-form");
const REGISTRATION = testUuid("adoption-registration");
const XMLNS = "http://openrosa.org/formdesigner/visit";
const REGISTRATION_XMLNS = "http://openrosa.org/formdesigner/register";

function alignedForm(uniqueId: string, xmlns: string): HqAlignedForm {
	return {
		uniqueId,
		xmlns,
		source: {
			docType: "Form",
			xmlns,
			readUniqueId: `read-${uniqueId}`,
			shadowParentReadId: null,
			attachment: null,
		},
		questions: [],
	};
}

function alignedMenu(
	uniqueId: string,
	forms: readonly HqAlignedForm[],
): HqAlignedModule {
	return { kind: "aligned", uniqueId, docType: "Module", forms };
}

/** A menu with one form, and the hidden menu HQ keeps a registration form in. */
const READ = {
	modules: [
		{ uuid: MENU, uniqueId: "menu-visits" },
		{ uuid: syntheticModuleUuid(REGISTRATION), uniqueId: "menu-hidden" },
	],
	forms: [
		{ uuid: FORM, xmlns: XMLNS, moduleUniqueId: "menu-visits" },
		{
			uuid: REGISTRATION,
			xmlns: REGISTRATION_XMLNS,
			moduleUniqueId: "menu-hidden",
		},
	],
};

const ALIGNED: readonly HqAlignedModule[] = [
	alignedMenu("menu-visits", [alignedForm("form-real-id", XMLNS)]),
	alignedMenu("menu-hidden", [
		alignedForm("registration-real-id", REGISTRATION_XMLNS),
	]),
];

describe("adoptedIdentityRows", () => {
	it("writes one row per menu and form, the hidden menu under its synthetic UUID, sorted by kind then UUID", () => {
		const byUuid = (
			a: { readonly novaEntityUuid: string },
			b: { readonly novaEntityUuid: string },
		) => (a.novaEntityUuid < b.novaEntityUuid ? -1 : 1);
		const forms = [
			{
				entityKind: "form",
				novaEntityUuid: FORM,
				uniqueId: "form-real-id",
				xmlns: XMLNS,
			},
			{
				entityKind: "form",
				novaEntityUuid: REGISTRATION,
				uniqueId: "registration-real-id",
				xmlns: REGISTRATION_XMLNS,
			},
		].sort(byUuid);
		const modules = [
			{
				entityKind: "module",
				novaEntityUuid: MENU,
				uniqueId: "menu-visits",
				xmlns: null,
			},
			{
				entityKind: "module",
				novaEntityUuid: syntheticModuleUuid(REGISTRATION),
				uniqueId: "menu-hidden",
				xmlns: null,
			},
		].sort(byUuid);
		expect(adoptedIdentityRows(READ, ALIGNED)).toEqual({
			ok: true,
			rows: [...forms, ...modules],
		});
	});

	it("names the menu HQ could not summarize, which holds no real form id", () => {
		const aligned: HqAlignedModule[] = [
			{
				kind: "not-summarized",
				uniqueId: "menu-visits",
				docType: "Module",
				shape: { opens: "error-in-form", length: 40 },
			},
			ALIGNED[1] as HqAlignedModule,
		];
		expect(adoptedIdentityRows(READ, aligned)).toEqual({
			ok: false,
			at: "menu menu-visits",
		});
	});

	it("names a form the aligned menu does not hold", () => {
		const aligned = [
			alignedMenu("menu-visits", [alignedForm("other", "http://other")]),
			ALIGNED[1] as HqAlignedModule,
		];
		expect(adoptedIdentityRows(READ, aligned)).toEqual({
			ok: false,
			at: `form ${XMLNS} in menu menu-visits`,
		});
	});
});

// ── Keyed case ids ───────────────────────────────────────────────────────

/** The keyed create of the operation fixture, and the form that holds it. */
function keyedCreate(doc: BlueprintDoc): {
	readonly formUuid: Uuid;
	readonly create: TargetedCaseOperation;
} {
	for (const [formUuid, form] of Object.entries(doc.forms))
		for (const operation of form.caseOperations ?? [])
			if (
				operation.action === "create" &&
				operation.target.kind === "new" &&
				operation.target.idFrom !== undefined
			)
				return { formUuid: formUuid as Uuid, create: operation };
	throw new Error("The operation fixture holds no keyed create.");
}

/** Every form's emitted XForm, joined: where a printed prefix can be looked for. */
function emittedForms(
	doc: BlueprintDoc,
	keyedCaseIdPrefixes?: ReadonlyMap<Uuid, string>,
): string {
	const attachments = expandDoc(doc, {
		...(keyedCaseIdPrefixes && { keyedCaseIdPrefixes }),
	})._attachments as Record<string, unknown>;
	return Object.values(attachments)
		.filter((value): value is string => typeof value === "string")
		.join("\n");
}

describe("keyed case ids", () => {
	const doc = caseOperationFixture("key");
	const { formUuid, create } = keyedCreate(doc);
	/** The prefix the project space's cases stand under: the source app's derivation. */
	const sourcePrefix = authoredCaseIdPrefix({
		appId: "hq-source-app",
		formUuid,
		operationUuid: create.uuid,
		caseType: create.caseType,
	});
	const rows = adoptedKeyedCaseIdRows({
		keyedCreates: [
			{
				operationUuid: create.uuid,
				formUuid,
				caseType: create.caseType,
				prefix: sourcePrefix,
			},
		],
	});

	it("records one row per keyed create the reading keeps, and refuses one listed twice", () => {
		expect(rows).toEqual([
			{
				operationUuid: create.uuid,
				caseType: create.caseType,
				prefix: sourcePrefix,
			},
		]);
		const twice = {
			operationUuid: create.uuid,
			formUuid,
			caseType: create.caseType,
			prefix: sourcePrefix,
		};
		expect(() =>
			adoptedKeyedCaseIdRows({ keyedCreates: [twice, twice] }),
		).toThrow(/two keyed creates/);
	});

	it("prints the source's prefix for a kept keyed create, and the derivation everywhere else", () => {
		const derived = authoredCaseIdPrefix({
			appId: doc.appId,
			formUuid,
			operationUuid: create.uuid,
			caseType: create.caseType,
		});
		expect(derived).not.toBe(sourcePrefix);

		const adopted = emittedForms(doc, keyedCaseIdPrefixesFor(doc, rows));
		expect(adopted).toContain(sourcePrefix);
		expect(adopted).not.toContain(derived);

		/* Every other project space and every other export passes no rows. */
		const elsewhere = emittedForms(doc);
		expect(elsewhere).toContain(derived);
		expect(elsewhere).not.toContain(sourcePrefix);
	});

	it("takes the derivation once the operation creates another type", () => {
		const retyped = structuredClone(doc);
		const moved = keyedCreate(retyped).create;
		moved.caseType = "patient";
		const prefixes = keyedCaseIdPrefixesFor(retyped, rows);
		expect(prefixes.size).toBe(0);
		const emitted = emittedForms(retyped, prefixes);
		expect(emitted).not.toContain(sourcePrefix);
		expect(emitted).toContain(
			authoredCaseIdPrefix({
				appId: retyped.appId,
				formUuid,
				operationUuid: moved.uuid,
				caseType: "patient",
			}),
		);
	});

	it("passes nothing for an operation the document no longer holds", () => {
		const removed = structuredClone(doc);
		const form = removed.forms[formUuid];
		if (form === undefined) throw new Error("The fixture lost its form.");
		form.caseOperations = form.caseOperations?.filter(
			(operation) => operation.uuid !== create.uuid,
		);
		expect(keyedCaseIdPrefixesFor(removed, rows).size).toBe(0);
	});
});

// ── Media paths ──────────────────────────────────────────────────────────

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const ASSET_A = testMediaAssetId("adoption-asset-a");
const ASSET_B = testMediaAssetId("adoption-asset-b");
const ASSET_C = testMediaAssetId("adoption-asset-c");

function file(
	hqPath: string,
	assetId: MediaAssetId = ASSET_A,
	contentHash = HASH_A,
): AdoptedMediaFile {
	return {
		hqPath: `jr://file/${hqPath}`,
		assetId,
		contentHash,
		extension: ".png",
	};
}

describe("isHoldableWirePath", () => {
	it("refuses every path the ledger's CHECK refuses, and agrees with it on every ASCII path", () => {
		for (const { path, floorAdmits } of MEDIA_PATH_FLOOR_CASES) {
			if (!floorAdmits) expect(isHoldableWirePath(path), path).toBe(false);
			// biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII is the class tested.
			if (/^[\x00-\x7f]*$/.test(path))
				expect(isHoldableWirePath(path), path).toBe(floorAdmits);
		}
	});

	it("refuses a character Python's strip() removes at either end, and keeps it inside", () => {
		for (const space of ["\u00a0", "\u2028", "\u2029", "\u3000", "\u2009"]) {
			expect(isHoldableWirePath(`${space}media/logo.png`)).toBe(false);
			expect(isHoldableWirePath(`media/logo.png${space}`)).toBe(false);
			expect(isHoldableWirePath(`media/my${space}logo.png`)).toBe(true);
		}
		/* A zero-width space is no space to `str.isspace()`. */
		expect(isHoldableWirePath("media/logo.png\u200b")).toBe(true);
	});

	it("refuses a control character anywhere, a lone surrogate and a path over 255 code points", () => {
		expect(isHoldableWirePath("media/lo\u0085go.png")).toBe(false);
		expect(isHoldableWirePath("media/lo\ud800go.png")).toBe(false);
		/* 255 code points, most of them two UTF-16 units each. */
		const astral = "\u{1f600}".repeat(245);
		expect(isHoldableWirePath(`media/${astral}.png`)).toBe(true);
		expect(isHoldableWirePath(`media/${astral}x.png`)).toBe(false);
	});
});

describe("assignMediaPaths", () => {
	it("keeps the first path in code-unit order and lists the others as collapsed", () => {
		expect(
			assignMediaPaths([
				file("media/logo.png"),
				file("commcare/image/Logo.png"),
				file("commcare/image/logo.png"),
				file("media/logo.png"),
			]),
		).toEqual({
			rows: [{ assetId: ASSET_A, wirePath: "commcare/image/Logo.png" }],
			collapsed: [
				{
					assetId: ASSET_A,
					kept: "commcare/image/Logo.png",
					dropped: ["commcare/image/logo.png", "media/logo.png"],
				},
			],
			rederived: [],
		});
	});

	it("holds a path in any directory", () => {
		expect(assignMediaPaths([file("media/logo.png")]).rows).toEqual([
			{ assetId: ASSET_A, wirePath: "media/logo.png" },
		]);
	});

	it("re-derives a derived-shape path of another hash, in lower case and in upper case", () => {
		for (const path of [
			`commcare/${HASH_B}.png`,
			`COMMCARE/${HASH_B.toUpperCase()}.PNG`,
		]) {
			expect(assignMediaPaths([file(path)])).toEqual({
				rows: [],
				collapsed: [],
				rederived: [
					{ assetId: ASSET_A, from: path, why: "names-another-file" },
				],
			});
		}
	});

	it("holds a file's own derived path", () => {
		const own = wirePathFor(HASH_A, ".png");
		expect(assignMediaPaths([file(own)]).rows).toEqual([
			{ assetId: ASSET_A, wirePath: own },
		]);
	});

	it("re-derives both paths that only case tells apart, and still holds a third path of one of them", () => {
		expect(
			assignMediaPaths([
				file("media/Logo.png", ASSET_A, HASH_A),
				file("media/logo.png", ASSET_B, HASH_B),
				file("media/z-other.png", ASSET_B, HASH_B),
			]),
		).toEqual({
			rows: [{ assetId: ASSET_B, wirePath: "media/z-other.png" }],
			collapsed: [],
			rederived: [
				{
					assetId: ASSET_A,
					from: "media/Logo.png",
					why: "differs-only-by-case",
				},
				{
					assetId: ASSET_B,
					from: "media/logo.png",
					why: "differs-only-by-case",
				},
			],
		});
	});

	it("holds two paths that toLowerCase() keeps apart, as Python's lower() in HQ's upload does", () => {
		/* ΑΣ lowers to ας (a final sigma) and İ to i̇, so neither pair is one
		 * path to HQ's bulk upload; the ledger's folded index admits both
		 * pairs. */
		expect(
			assignMediaPaths([
				file("media/ΑΣ-1.png", ASSET_A, HASH_A),
				file("media/ασ-1.png", ASSET_B, HASH_B),
			]).rows,
		).toEqual([
			{ assetId: ASSET_A, wirePath: "media/ΑΣ-1.png" },
			{ assetId: ASSET_B, wirePath: "media/ασ-1.png" },
		]);
		expect(
			assignMediaPaths([
				file("media/İ.png", ASSET_A, HASH_A),
				file("media/i.png", ASSET_B, HASH_B),
			]).rows,
		).toEqual([
			{ assetId: ASSET_B, wirePath: "media/i.png" },
			{ assetId: ASSET_A, wirePath: "media/İ.png" },
		]);
	});

	it("re-derives a path with `..`, with no directory, or with a space at either end", () => {
		for (const path of [
			"media/../logo.png",
			"logo.png",
			" media/logo.png",
			"media/logo.png ",
		]) {
			expect(assignMediaPaths([file(path)])).toEqual({
				rows: [],
				collapsed: [],
				rederived: [{ assetId: ASSET_A, from: path, why: "not-holdable" }],
			});
		}
	});

	it("throws on a path outside jr://file/, naming the asset and never the path", () => {
		expect(() =>
			assignMediaPaths([
				{
					hqPath: "jr://images/logo.png",
					assetId: ASSET_A,
					contentHash: HASH_A,
					extension: ".png",
				},
			]),
		).toThrow(
			new Error(
				`Nova was given a media path to keep for the asset ${ASSET_A}, and it doesn't start with jr://file/. CommCare HQ can't build an app with such a path, so the reader should have reported this file before the app was created.`,
			),
		);
	});

	it("never gives two files one path, nor paths equal under toLowerCase(), and every row is holdable", () => {
		const segment = fc.oneof(
			fc.constantFrom(
				"media",
				"commcare",
				"Media",
				"image",
				"..",
				".",
				"",
				" a",
			),
			fc.stringMatching(/^[a-zA-Z]{1,3}$/),
			fc.constantFrom(HASH_A, HASH_B, HASH_C, HASH_A.toUpperCase()),
		);
		const name = fc.oneof(
			fc.constantFrom(`${HASH_A}.png`, `${HASH_B}.png`, `${HASH_C}.png`),
			fc.stringMatching(/^[a-zA-Z]{1,3}\.(png|PNG)$/),
		);
		const path = fc
			.tuple(fc.array(segment, { minLength: 0, maxLength: 2 }), name)
			.map(([dirs, leaf]) => [...dirs, leaf].join("/"));
		const asset = fc.constantFrom(
			[ASSET_A, HASH_A] as const,
			[ASSET_B, HASH_B] as const,
			[ASSET_C, HASH_C] as const,
		);
		fc.assert(
			fc.property(
				fc.array(fc.tuple(path, asset), { maxLength: 12 }),
				(entries) => {
					const { rows } = assignMediaPaths(
						entries.map(([hqPath, [assetId, hash]]) =>
							file(hqPath, assetId, hash),
						),
					);
					const folded = new Set(rows.map((row) => row.wirePath.toLowerCase()));
					expect(folded.size).toBe(rows.length);
					expect(new Set(rows.map((row) => row.assetId)).size).toBe(
						rows.length,
					);
					for (const row of rows)
						expect(isHoldableWirePath(row.wirePath)).toBe(true);
				},
			),
		);
	});
});

// ── adoptedAppBaselineWrite ──────────────────────────────────────────────

const RAW_SOURCE = {
	doc_type: "Application",
	name: "Visits",
	modules: [],
	_attachments: {},
};

function source(overrides: Partial<HqAppSource> = {}): HqAppSource {
	return {
		docType: "Application",
		buildSpecVersion: "2.57.0",
		cloudcareEnabled: false,
		logoRefs: {},
		profile: {},
		langs: ["en"],
		translations: { en: { en: "English" } },
		addOns: { display_conditions: false },
		modules: [],
		raw: RAW_SOURCE,
		name: "Visits",
		lastModified: null,
		multimediaMap: [],
		buildProfiles: [],
		...overrides,
	};
}

const FIRST_PUBLISH: FirstPublishView = {
	ids: [
		"forms-and-settings-rewritten",
		"web-apps-turned-on",
		"media-files-renamed",
	],
	touchesWorkers: true,
	of: "first-publish",
};

function baselineFor(doc: BlueprintDoc, from: HqAppSource = source()) {
	return adoptedAppBaselineWrite({
		remoteAppId: "hq-app",
		source: from,
		prepared: { doc, assets: new Map(), attachmentTarget: null },
		target: TARGET,
		identity: DERIVED_WIRE_IDENTITY,
		novaRevision: 7,
		mediaFiles: { "media/logo.png": "media-doc-1" },
		observedAt: "2026-11-10T09:00:00.000Z",
		firstPublish: FIRST_PUBLISH,
	});
}

/** A survey whose form shows under a condition, so it needs one add-on. */
const PLAIN = buildDoc({
	appName: "Visits",
	modules: [
		{
			name: "Visits",
			forms: [
				{
					name: "Visit",
					type: "survey",
					displayCondition: eq(literal("a"), literal("a")),
				},
			],
		},
	],
});

describe("adoptedAppBaselineWrite", () => {
	it("records the accepted source as a read baseline with what it was given", () => {
		const write = baselineFor(PLAIN);
		const normalized = normalizeHqAppSource(RAW_SOURCE);
		if ("malformed" in normalized) throw new Error("The source is malformed.");
		expect(write).toMatchObject({
			origin: "read",
			remoteAppId: "hq-app",
			sourceBytes: normalized.bytes,
			sourceDigest: normalized.digest,
			observedAt: "2026-11-10T09:00:00.000Z",
			discard: null,
			novaRevision: 7,
		});
		expect(
			gunzipSync(write.sourceGzip ?? Buffer.alloc(0)).toString("utf8"),
		).toBe(normalized.text);
	});

	it("records the file at each held path a publish sends, and not the logo's, which no publish sends", () => {
		const picture = testMediaAssetId("adoption-picture");
		const logo = testMediaAssetId("adoption-logo");
		const doc = buildDoc({
			appName: "Visits",
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [{ id: "name", kind: "text", label: "Name" }],
						},
					],
				},
			],
		});
		const field = Object.values(doc.fields)[0] as { label_media?: unknown };
		field.label_media = { image: picture };
		const withLogo = { ...doc, logo };
		const asset = (assetId: MediaAssetId, wirePath: string) =>
			[
				assetId,
				{
					assetId,
					wirePath,
					kind: "image",
					mimeType: "image/png",
					contentHash: "a".repeat(64),
					extension: ".png",
				},
			] as const;
		const write = adoptedAppBaselineWrite({
			remoteAppId: "hq-app",
			source: source(),
			prepared: {
				doc: withLogo,
				assets: new Map([
					asset(picture, "commcare/image/visit.png"),
					asset(logo, "commcare/logo/data/hq_logo_web_apps.png"),
				]),
				attachmentTarget: null,
			},
			target: TARGET,
			identity: DERIVED_WIRE_IDENTITY,
			novaRevision: 7,
			mediaFiles: {
				"commcare/image/visit.png": "doc-visit",
				"commcare/logo/data/hq_logo_web_apps.png": "doc-logo",
			},
			observedAt: "2026-11-10T09:00:00.000Z",
			firstPublish: FIRST_PUBLISH,
		});
		expect(write.mediaFiles).toEqual({
			kind: "set",
			files: { "commcare/image/visit.png": "doc-visit" },
		});
		expect(baselineFor(PLAIN).mediaFiles).toEqual({ kind: "set", files: {} });
	});

	it("stores the list less the two Web Apps lines, beside HQ's setting, and reads back the same list", () => {
		const write = baselineFor(PLAIN);
		const stored = {
			ids: ["forms-and-settings-rewritten", "media-files-renamed"],
			webAppsOnInHq: false,
			of: "first-publish",
		} as const;
		expect(write.firstPublish).toEqual({ kind: "set", list: stored });
		expect(firstPublishViewFromStored(stored, undefined)).toEqual(
			FIRST_PUBLISH,
		);
	});

	it("owns the needed add-ons and the two settings Nova always writes, and no custom profile property", () => {
		expect(baselineFor(PLAIN).ownership).toEqual({
			addOns: ["display_conditions"],
			profileProperties: ["cc-show-saved", "cc-show-incomplete"],
			profileCustomProperties: [],
			autoGpsCapture: false,
		});
	});

	it("owns auto GPS capture for a Connect app", () => {
		const connect = connectWireFixtures().find(
			(fixture) => fixture.name === "deliver-default",
		)?.doc;
		if (connect === undefined) throw new Error("Missing the Connect fixture.");
		expect(baselineFor(connect).ownership).toEqual({
			addOns: [],
			profileProperties: ["cc-show-saved", "cc-show-incomplete"],
			profileCustomProperties: [],
			autoGpsCapture: true,
		});
	});

	it("throws on a source that is not an application", () => {
		expect(() =>
			baselineFor(PLAIN, source({ raw: { doc_type: "Module" } })),
		).toThrow(/isn't an application Nova can read \(at doc_type\)/);
	});
});

// ── adoptionPlanFeatureConfirmations ─────────────────────────────────────

function confirmed(
	doc: BlueprintDoc,
	sourceWebAppsOn: boolean,
	sourceHoldsSaveToCase: boolean,
): readonly string[] {
	return adoptionPlanFeatureConfirmations({
		doc,
		target: TARGET,
		sourceWebAppsOn,
		sourceHoldsSaveToCase,
	}).map((key) => {
		if (key.kind !== "plan-feature") throw new Error(`Recorded ${key.kind}.`);
		return key.subject;
	});
}

describe("adoptionPlanFeatureConfirmations", () => {
	/* Runs in Web Apps and places a case change in a Save to Case block. */
	const saveToCase = caseOperationFixture("conditional");
	/* Runs on Android only, reads the worker's record and sends to Connect. */
	const connect = connectWireFixtures().find(
		(fixture) => fixture.name === "deliver-default",
	)?.doc;

	it("records Web Apps only where the document declares it and HQ holds it on", () => {
		expect(confirmed(saveToCase, true, true)).toContain("web-apps");
		expect(confirmed(saveToCase, false, true)).not.toContain("web-apps");
		if (connect === undefined) throw new Error("Missing the Connect fixture.");
		expect(confirmed(connect, true, false)).not.toContain("web-apps");
	});

	it("records Save to Case only where the document needs it and the source holds a block", () => {
		expect(confirmed(saveToCase, true, true)).toContain(
			"advanced-case-actions",
		);
		expect(confirmed(saveToCase, true, false)).not.toContain(
			"advanced-case-actions",
		);
		expect(confirmed(PLAIN, true, true)).toEqual(["web-apps"]);
	});

	it("records every other feature the document needs, and no project-space setting", () => {
		if (connect === undefined) throw new Error("Missing the Connect fixture.");
		expect(
			adoptionPlanFeatureConfirmations({
				doc: connect,
				target: TARGET,
				sourceWebAppsOn: false,
				sourceHoldsSaveToCase: false,
			}),
		).toEqual([
			{ kind: "plan-feature", subject: "worker-records" },
			{ kind: "plan-feature", subject: "data-forwarding" },
		]);
	});
});
