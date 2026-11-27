// lib/commcare/multimedia/hqJsonExportArchive.ts
//
// Assembles the HQ import file: always a ZIP. CommCare HQ has no single
// import that takes an app together with the things it depends on: media is
// a second manual step and lookup data is a third. So the archive mirrors
// that shape: the app JSON (carrying its `jr://file/commcare/<hash><ext>`
// references), the HQ bulk-upload `multimedia.zip` holding the bytes those
// references resolve to, the app's logo as `logo<ext>`, the fixture workbook
// holding the lookup tables the app reads that Nova manages, one more per
// project space holding Nova's copy of the tables that space manages in
// CommCare HQ, and a README that walks a person through the steps that apply.
//
// The file is made for no project space, so it must work for a space that
// manages a table and for one that has never seen it: a person importing into
// a space that manages some of the tables leaves that space's workbook out,
// and uploads every other one.
//
// The app JSON carries no `logo_refs`, and HQ's bulk upload maps no
// app-level media (`hqmedia/models.py::ApplicationMediaMixin.all_media`), so
// the logo's file rides beside `multimedia.zip` for a person to add in the
// app's settings, and `multimedia.zip` leaves out a file only the logo uses,
// by the filter the direct upload uses (`bulkUploadAssets`).
//
// The README is the rendered manual-import guide (`lib/publish/manualImportGuide.ts`),
// which always holds at least the CommCare version step, so every app's file
// carries one. Each companion appears only when the app has one, so a README
// never lists a step for a file that is not in the archive.
//
// The direct-upload path pushes the SAME rows through CommCare HQ's fixture
// API before it imports the app (`lib/deployment/service.ts`), less any table
// CommCare HQ manages in the project space it writes to, so a hand-imported
// app and an API-uploaded one land the same data on the project space.
//
// One builder, two callers: the HTTP download (`app/api/compile/json`) and the
// MCP `compile_app` json tool both ship THIS archive with the guide
// `hqImportFileGuide` derives, so the manual-import and programmatic surfaces
// can't drift in format or in what they tell a person. It is pure assembly
// over already-resolved inputs: no Postgres and no expand.

import { type BlueprintDoc, declaresWebApps } from "@/lib/domain";
import { bulkUploadAssetIds } from "@/lib/domain/mediaRefs";
import { driftDate } from "@/lib/publish/driftReference";
import {
	MANUAL_IMPORT_LOOKUP_WORKBOOK,
	MANUAL_IMPORT_MANAGED_LOOKUP_WORKBOOK_PREFIX,
	MANUAL_IMPORT_MEDIA_ZIP,
	type ManualImportStep,
	manualImportGuide,
} from "@/lib/publish/manualImportGuide";
import { sanitizeArchiveMemberName } from "@/lib/utils/sanitize";
import { appEmitsConnectBlocks } from "../connectSlugs";
import { distanceSearchProperties } from "../distanceSearches";
import { readsLocationsFixture } from "../locations/readsLocationsFixture";
import type { LookupWireNaming } from "../lookup/naming";
import type { LookupWorkbook } from "../lookup/workbook";
import {
	commtrackReasons,
	formEntrySyncReasons,
	requiredPlanFeatures,
} from "../planPrivileges";
import { requiredProjectSpaceCapabilities } from "../projectSpaceCompatibility";
import { sameTypeBasicChildCases } from "../sameTypeChildCases";
import { COMMCARE_SERVERS, isCommCareServer } from "../servers";
import type { HqApplication } from "../types";
import { COMMCARE_VERSION_FLOOR } from "../versionFloor";
import type { AttachmentUrlTarget } from "../xform/captureUrlNode";
import { type ArchiveMember, zipMembers } from "../zipMembers";
import type { AssetManifest } from "./assetWirePath";
import { buildMediaBulkUploadZip } from "./bulkUploadZip";

/**
 * The app JSON's member name, without its extension.
 *
 * Sanitized here, at the archive boundary, so the member is always a safe
 * relative leaf whichever caller arrives: `appName` is an owner-controlled
 * string the blueprint schema leaves unconstrained, so a name carrying `/`,
 * `\`, `:`, CR/LF, or `..` segments would otherwise become the ZIP entry
 * path a downstream extractor trusts. The archive-member sanitizer, not
 * `sanitizeFilename`: a ZIP member is UTF-8, so a non-Latin or accented app
 * name (`调查表`, `Café Survey`) keeps its identity here, while the HTTP
 * route's separate `Content-Disposition` filename stays ASCII.
 */
function appFileName(appName: string): string {
	return sanitizeArchiveMemberName(appName);
}

/**
 * The assets HQ's bulk upload carries: each one some carrier that rides the
 * upload references (`lib/domain/mediaRefs.ts::carriesViaBulkUpload`). An
 * image only the logo uses is left out; one the logo shares with a question
 * stays, for the question. The direct upload's ZIP and the import file's
 * `multimedia.zip` both read this filter.
 */
export function bulkUploadAssets(
	doc: BlueprintDoc,
	assets: AssetManifest,
): AssetManifest {
	const carried = bulkUploadAssetIds(doc);
	return new Map([...assets].filter(([assetId]) => carried.has(assetId)));
}

/** The logo's file as the import file holds it, `logo<ext>`, or `undefined`
 * for an app with no logo. */
function logoMember(
	doc: BlueprintDoc,
	assets: AssetManifest,
): { readonly name: string; readonly bytes: Buffer | undefined } | undefined {
	const logo = doc.logo === undefined ? undefined : assets.get(doc.logo);
	if (logo === undefined) return undefined;
	return { name: `logo${logo.extension}`, bytes: logo.bytes };
}

/** The name of each form `sameTypeBasicChildCases` lists, once each, in
 *  document order. */
function sameTypeChildFormNames(doc: BlueprintDoc): string[] {
	const names = sameTypeBasicChildCases(doc).map(({ formUuid }) => {
		const form = doc.forms[formUuid];
		return form.name.trim() || form.id;
	});
	return [...new Set(names)];
}

/**
 * A table CommCare HQ manages, as the export boundary lists those it left out
 * of the first workbook (`PreparedExportBoundary.managedLookupTables`).
 */
export interface HqImportFileManagedTable {
	readonly tag: string;
	/** The project space that manages it: its server and domain. */
	readonly server: string;
	readonly domain: string;
	/** When Nova's copy was last refreshed, an ISO instant. */
	readonly refreshedAt: string;
}

/**
 * One workbook of the tables one project space manages, as the export
 * boundary builds them (`PreparedExportBoundary.managedLookupWorkbooks`).
 */
export interface HqImportFileManagedWorkbook {
	readonly server: string;
	readonly domain: string;
	readonly workbook: LookupWorkbook;
}

/** A managed workbook as the archive holds it and the guide names it. */
interface ManagedWorkbookMember {
	readonly server: string;
	readonly domain: string;
	readonly fileName: string;
	/** The domain, with its server's label where another member has the same domain. */
	readonly projectSpace: string;
	readonly bytes: LookupWorkbook["bytes"];
}

/** A project space's name as a ZIP member carries it: every character but a letter, digit, dot, underscore or hyphen becomes a hyphen. */
function memberSegment(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[.-]+/, "");
}

function serverLabel(server: string): string {
	return isCommCareServer(server) ? COMMCARE_SERVERS[server].label : server;
}

/**
 * Each managed workbook's member: `lookup-tables-managed-in-<domain>.xlsx`,
 * with the server's label after the domain where two workbooks share a
 * domain on two servers, and a count after that where two names still meet.
 * A name depends on the set of workbooks alone, never their order, so the
 * archive and the guide, which both derive it, name each file alike.
 */
function managedWorkbookMembers(
	workbooks: readonly HqImportFileManagedWorkbook[],
): readonly ManagedWorkbookMember[] {
	const domainCount = new Map<string, number>();
	for (const { domain } of workbooks) {
		domainCount.set(domain, (domainCount.get(domain) ?? 0) + 1);
	}
	const shared = (domain: string) => (domainCount.get(domain) ?? 0) > 1;
	const baseOf = (workbook: HqImportFileManagedWorkbook) =>
		`${MANUAL_IMPORT_MANAGED_LOOKUP_WORKBOOK_PREFIX}${memberSegment(workbook.domain)}${
			shared(workbook.domain)
				? `-${memberSegment(serverLabel(workbook.server))}`
				: ""
		}`;
	/* Two bases meet only where two domains spell alike once made safe; the
	 * order a count follows is the workbooks' by server and domain. */
	const sorted = [...workbooks].sort((left, right) =>
		`${left.server}\u0000${left.domain}` <
		`${right.server}\u0000${right.domain}`
			? -1
			: 1,
	);
	const taken = new Set<string>();
	const nameOf = new Map<HqImportFileManagedWorkbook, string>();
	for (const workbook of sorted) {
		const base = baseOf(workbook);
		let name = base;
		for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
		taken.add(name);
		nameOf.set(workbook, `${name}.xlsx`);
	}
	return workbooks.map((workbook) => ({
		server: workbook.server,
		domain: workbook.domain,
		fileName: nameOf.get(workbook) ?? "",
		projectSpace: shared(workbook.domain)
			? `${workbook.domain} (${serverLabel(workbook.server)})`
			: workbook.domain,
		bytes: workbook.workbook.bytes,
	}));
}

/**
 * The manual-import steps for this file, from the same derivations a
 * publish's own checks read: the capabilities and plan features the document
 * needs, the workbooks' tables, the media the bulk upload carries, the logo,
 * whether the app runs in Web Apps, whether the app reads places, whether it sends forms to CommCare Connect,
 * whether a publish would ask that sync on form entry or CommCare Supply is off, the forms that make a case linked to a case of their own type, and the properties its searches measure distance on. An import file has no target and sends no places.
 *
 * The capabilities step leaves out links between cases of the same type: that
 * step says Dimagi can turn a feature on, and those links need a setting
 * Dimagi turns off, so they get a step of their own.
 */
export function hqImportFileGuide(input: {
	readonly appName: string;
	readonly doc: BlueprintDoc;
	readonly assets: AssetManifest;
	readonly lookupWorkbook: LookupWorkbook | undefined;
	/** The workbooks of the tables CommCare HQ manages, one per project space that manages some. */
	readonly managedLookupWorkbooks: readonly HqImportFileManagedWorkbook[];
	/** The tables those workbooks carry, in the definitions' order. */
	readonly managedLookupTables: readonly HqImportFileManagedTable[];
	/** The target the app JSON beside it was written for (`expandDoc`'s). */
	readonly attachmentTarget: AttachmentUrlTarget | null;
	/** The lookup naming the app JSON beside it was written under (`expandDoc`'s), or `undefined` for an app that reads no table. */
	readonly lookupNaming: LookupWireNaming | undefined;
}): readonly ManualImportStep[] {
	const logo = logoMember(input.doc, input.assets);
	return manualImportGuide({
		appFileName: appFileName(input.appName),
		lookupTags: input.lookupWorkbook?.tables.map((table) => table.tag) ?? [],
		/* The guide is made on the server for whoever opens the ZIP, so it has
		 * no reader's locale: the day is the UTC day, spelled as every drift
		 * sentence's default spells one. */
		managedLookupFiles: managedWorkbookMembers(
			input.managedLookupWorkbooks,
		).map((member) => ({
			fileName: member.fileName,
			projectSpace: member.projectSpace,
			tables: input.managedLookupTables
				.filter(
					(table) =>
						table.server === member.server && table.domain === member.domain,
				)
				.map((table) => ({
					tag: table.tag,
					refreshedOn: driftDate(table.refreshedAt),
				})),
		})),
		hasMedia: bulkUploadAssets(input.doc, input.assets).size > 0,
		versionFloor: `${COMMCARE_VERSION_FLOOR.major}.${COMMCARE_VERSION_FLOOR.minor}`,
		capabilities: requiredProjectSpaceCapabilities(input.doc)
			.filter(({ id }) => id !== "same-type-child-links")
			.map(({ label, reasons }) => ({ label, reasons })),
		planFeatures: requiredPlanFeatures(
			input.doc,
			{
				/* Every workbook needs the plan's lookup tables, wherever a managed
				 * one goes but the project space that manages its tables. */
				lookupTables:
					input.lookupWorkbook !== undefined ||
					input.managedLookupWorkbooks.length > 0,
				places: false,
			},
			input.attachmentTarget,
		).map(({ label, plans, consequence }) => ({ label, plans, consequence })),
		logo: logo === undefined ? null : { fileName: logo.name },
		runsInWebApps: declaresWebApps(input.doc),
		readsLocations: readsLocationsFixture(input.doc),
		sendsToConnect: appEmitsConnectBlocks(input.doc),
		formEntrySync: formEntrySyncReasons(input.doc).length > 0,
		commtrack: commtrackReasons(input.doc, input.lookupNaming).length > 0,
		sameTypeChildLinks: sameTypeChildFormNames(input.doc),
		distanceSearches: distanceSearchProperties(input.doc),
	});
}

/**
 * Build the `<app>.zip`: the app JSON, the HQ bulk-upload `multimedia.zip`
 * when the bulk upload carries any media, the logo as `logo<ext>` when the
 * app has one, the fixture workbook when it reads a lookup table Nova
 * manages, one workbook per project space that manages a table it reads in
 * CommCare HQ, named as the guide names it, and `README.txt`, the rendered
 * guide its caller derived with `hqImportFileGuide` over the same inputs.
 *
 * The JSON is pretty-printed: it lands as a file a person may open. The
 * `multimedia.zip` IS CommCare HQ's bulk-upload format (each entry at the
 * asset's bare `commcare/<hash><ext>` wire path), built by the one shared
 * `buildMediaBulkUploadZip` over `bulkUploadAssets`, so a manual import and
 * an API upload speak one format. The caller resolves the manifest
 * `withBytes: true` first: every entry must carry its bytes or
 * `buildMediaBulkUploadZip` throws. The workbooks arrive already built, from
 * the same validated lookup generation the export boundary measured.
 */
export function buildHqJsonExportArchive(
	appName: string,
	doc: BlueprintDoc,
	hqJson: HqApplication,
	assets: AssetManifest,
	lookupWorkbook: LookupWorkbook | undefined,
	managedLookupWorkbooks: readonly HqImportFileManagedWorkbook[],
	readme: string,
): Buffer {
	const members: ArchiveMember[] = [
		{
			path: `${appFileName(appName)}.json`,
			bytes: Buffer.from(JSON.stringify(hqJson, null, 2), "utf-8"),
		},
	];
	const bulk = bulkUploadAssets(doc, assets);
	if (bulk.size > 0) {
		members.push({
			path: MANUAL_IMPORT_MEDIA_ZIP,
			bytes: buildMediaBulkUploadZip(bulk),
		});
	}
	const logo = logoMember(doc, assets);
	if (logo !== undefined) {
		if (logo.bytes === undefined) {
			throw new Error(
				`The HQ import file needs the logo's bytes, but "${logo.name}" arrived without any. ` +
					"Resolve the manifest with `withBytes: true` before building the import file.",
			);
		}
		members.push({ path: logo.name, bytes: logo.bytes });
	}
	if (lookupWorkbook !== undefined) {
		members.push({
			path: MANUAL_IMPORT_LOOKUP_WORKBOOK,
			bytes: Buffer.from(lookupWorkbook.bytes),
		});
	}
	for (const member of managedWorkbookMembers(managedLookupWorkbooks)) {
		members.push({
			path: member.fileName,
			bytes: Buffer.from(member.bytes),
		});
	}
	members.push({ path: "README.txt", bytes: Buffer.from(readme, "utf-8") });
	return zipMembers(members, "buildHqJsonExportArchive");
}
