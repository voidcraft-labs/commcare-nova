// lib/commcare/surface/keptAtHq.ts
//
// What Nova does with each value it leaves at CommCare HQ's: one row per
// TARGET-OWNED manifest entry, by the entry's id. Content outside an app's
// menus that Nova's publish never writes is kept only when no publish changes
// it on that project space, nothing the document holds does something
// different under its value, and every Nova surface that shows or runs what it
// changes reads the project space's value or says how it differs. Each row
// says what a `.ccz` made for the project space does with the value, what
// Preview does, what a first publish to another project space does, and which
// app made in CommCare HQ holds it at a value other than the default.
//
// Pure and free of the manifest JSON: `__tests__/keptAtHq.test.ts` binds the
// table to the entries both ways. The words a person reads live in
// `lib/publish` (`keptValues.ts::KEPT_LABELS`, the export advisories), and a
// row names its label and its advisory by id.

import type { KeptExportAdvisoryId } from "@/lib/publish/exportAdvisories";
import type { KeptLabelId } from "@/lib/publish/keptValues";

/**
 * What a row keeps: a setting a project space chooses, an identity HQ gives
 * the app, a record HQ's server keeps of it, or state of the project space
 * the app's source holds none of.
 */
export type KeptKind =
	| "setting"
	| "identity"
	| "server-record"
	| "project-state";

export type KeptCczCell =
	/**
	 * The archive writes what HQ's build writes from the value, read from `TargetFacts`.
	 * `advisory` names what the download says where the value is absent and the archive
	 * cannot write what HQ's build fills in.
	 */
	| {
			readonly does: "mirrors";
			readonly by: string;
			readonly advisory?: KeptExportAdvisoryId;
	  }
	/** The archive cannot follow; the download says so through this advisory. */
	| { readonly does: "states"; readonly advisory: KeptExportAdvisoryId }
	/** Nothing an archive holds derives from the value. */
	| { readonly does: "no-reader"; readonly why: string }
	/** The archive carries Nova's own value by a stated contract. */
	| { readonly does: "own"; readonly why: string };

export type KeptPreviewCell =
	| { readonly does: "reads"; readonly by: string }
	| { readonly does: "no-claim"; readonly why: string };

export type KeptElsewhereCell =
	/** A first publish to another project space writes Nova's own value. */
	| { readonly does: "seeds"; readonly value: string }
	/** Nothing is written, so CommCare HQ's default stands there. */
	| { readonly does: "default"; readonly value: string }
	/** That project space has its own record or its own state. */
	| { readonly does: "its-own" };

export interface KeptRow {
	readonly kind: KeptKind;
	/** The label a person reads in the kept list; absent for a row no list shows. */
	readonly label?: KeptLabelId;
	readonly ccz: KeptCczCell;
	readonly preview: KeptPreviewCell;
	readonly elsewhere: KeptElsewhereCell;
	/** The HQ-authored base that holds it at a value other than the default. */
	readonly base: string;
}

// The cells most rows share.

const TARGET_PROFILE: KeptCczCell = {
	does: "mirrors",
	by: "lib/commcare/keptProfile.ts::targetProfileProperties",
};
const NO_ARCHIVE_READER: KeptCczCell = {
	does: "no-reader",
	why: "Nothing an archive holds derives from this value.",
};
const NO_CLAIM: KeptPreviewCell = {
	does: "no-claim",
	why: "Preview claims nothing this value changes.",
};
const HQ_DEFAULT: KeptElsewhereCell = {
	does: "default",
	value: "CommCare HQ's own default",
};
const ITS_OWN: KeptElsewhereCell = { does: "its-own" };

function noClaim(why: string): KeptPreviewCell {
	return { does: "no-claim", why };
}
function seeds(value: string): KeptElsewhereCell {
	return { does: "seeds", value };
}
function defaultsTo(value: string): KeptElsewhereCell {
	return { does: "default", value };
}

/** A setting Nova seeds where a project space holds none, which the archive writes at the project space's value. */
function seeded(
	label: KeptLabelId,
	seed: string,
	preview: KeptPreviewCell,
	base = "hq-kept-settings",
): KeptRow {
	return {
		kind: "setting",
		label,
		ccz: TARGET_PROFILE,
		preview,
		elsewhere: seeds(seed),
		base,
	};
}

/** A record HQ's server keeps of the app, which no archive and no Preview reads. */
const SERVER_RECORD: KeptRow = {
	kind: "server-record",
	ccz: NO_ARCHIVE_READER,
	preview: NO_CLAIM,
	elsewhere: ITS_OWN,
	base: "hq-new-app",
};

/** State of the project space that the app's source holds none of. */
const PROJECT_STATE: KeptRow = {
	kind: "project-state",
	ccz: {
		does: "no-reader",
		why: "The app's source holds none of it; publish asks a person where it matters.",
	},
	preview: NO_CLAIM,
	elsewhere: ITS_OWN,
	base: "hq-new-app",
};

const RECORDED_IDS: KeptRow = {
	kind: "identity",
	ccz: {
		does: "own",
		why: "The deployment's recorded ids (`targetWireIdentity`).",
	},
	preview: noClaim("Preview keys by Nova's UUIDs."),
	elsewhere: ITS_OWN,
	base: "hq-new-app",
};

const PROJECT_TABLE: Pick<KeptRow, "ccz" | "preview" | "elsewhere" | "base"> = {
	ccz: { does: "own", why: "The archive embeds the Project's table." },
	preview: {
		does: "reads",
		by: "lib/preview/engine/useLookupPreviewData.tsx::PreviewLookupDataProvider",
	},
	elsewhere: ITS_OWN,
	base: "hq-new-app",
};

const PREVIEW_CHROME = noClaim("Preview's chrome is Nova's own.");
const COMMCARE_WORDING = defaultsTo("CommCare's wording");
const NO_DEVICE_LOG = noClaim("Preview sends no device log.");
const NO_RECEIVER = noClaim("Preview posts to no receiver.");

/** One row per TARGET-OWNED manifest entry, by the entry's id. */
export const KEPT_AT_HQ: Readonly<Record<string, KeptRow>> = {
	"application-and-settings/1-properties-cc-autoup-freq": seeded(
		"automatic-app-updates",
		"freq-never",
		noClaim("Preview installs no update."),
	),
	"application-and-settings/4-properties-cc-days-form-retain": seeded(
		"sent-form-retention",
		"-1",
		noClaim("Preview keeps no sent forms."),
	),
	"application-and-settings/5-properties-logenabled": seeded(
		"device-logging",
		"Enabled",
		NO_DEVICE_LOG,
	),
	"application-and-settings/13-properties-cc-autosync-freq": seeded(
		"automatic-sync",
		"freq-never",
		noClaim("Preview reads the case store directly."),
	),
	"application-and-settings/17-properties-cc-content-valid": seeded(
		"media-check-at-install",
		"no",
		noClaim("Preview installs nothing."),
	),
	"application-and-settings/18-properties-unsent-number-limit": seeded(
		"unsent-form-warning-count",
		"5",
		noClaim("Preview sends each form at once."),
	),
	"application-and-settings/19-properties-unsent-time-limit": seeded(
		"unsent-form-warning-days",
		"5",
		noClaim("Preview sends each form at once."),
	),
	"application-and-settings/22-properties-cc-resize-images": seeded(
		"image-resizing",
		"none",
		noClaim("Preview stores a picture as chosen."),
	),
	"application-and-settings/23-properties-cc-fuzzy-search-enabled": seeded(
		"fuzzy-search",
		"no",
		{
			does: "reads",
			by: "components/preview/shared/listFilter.tsx::rowsMatchingFilterText",
		},
		"starter-health",
	),
	"application-and-settings/25-properties-cc-login-duration-seconds": seeded(
		"sign-in-duration",
		"86400",
		noClaim("Preview has no worker sign-in."),
	),
	"application-and-settings/26-properties-cc-inflation-target-density": seeded(
		"image-scaling",
		"none",
		noClaim("The browser scales images."),
	),
	"application-and-settings/27-properties-cc-gps-auto-capture-accuracy": seeded(
		"location-capture-accuracy",
		"10",
		noClaim("Preview captures no location on its own."),
	),
	"application-and-settings/28-properties-cc-maps-default-layer": seeded(
		"default-map-layer",
		"normal",
		noClaim("The map is Google's own in Preview."),
	),
	"application-and-settings/29-properties-cc-enable-tts": seeded(
		"text-to-speech",
		"no",
		noClaim("Preview speaks no label."),
	),
	"application-and-settings/30-properties-cc-label-required-questions-with-asterisk":
		seeded("required-question-asterisk", "no", {
			does: "reads",
			by: "lib/preview/platform.ts::requiredMarkShown",
		}),
	"application-and-settings/24-properties-cc-log-entity-detail-enabled": {
		kind: "setting",
		label: "case-detail-view-logging",
		ccz: TARGET_PROFILE,
		preview: NO_DEVICE_LOG,
		elsewhere: defaultsTo("not written"),
		base: "hq-kept-settings",
	},
	"application-and-settings/translations-key-in-a-runtime-s-ui-string-catalog-core-android":
		{
			kind: "setting",
			label: "reworded-commcare-screens",
			ccz: { does: "mirrors", by: "lib/commcare/compiler.ts::compileCcz" },
			preview: PREVIEW_CHROME,
			elsewhere: COMMCARE_WORDING,
			base: "hq-kept-settings",
		},
	/* Shown with the row above. */
	"application-and-settings/translations-catalog-key-hq-fills-with-its-own-text-in-a":
		{
			kind: "setting",
			ccz: { does: "states", advisory: "kept_ui_text_falls_back" },
			preview: PREVIEW_CHROME,
			elsewhere: COMMCARE_WORDING,
			base: "hq-kept-settings",
		},
	"application-and-settings/logo-refs-hq-logo-android-home-login-demo": {
		kind: "setting",
		label: "android-logos",
		ccz: { does: "states", advisory: "kept_android_logos_absent" },
		preview: noClaim("Preview draws no Android home or sign-in screen logo."),
		elsewhere: defaultsTo("none"),
		base: "hq-kept-settings",
	},
	"application-and-settings/49p-hq-mobile-ucr-restore-version-1-0-1-5": {
		kind: "setting",
		label: "mobile-report-version",
		ccz: { does: "no-reader", why: "An archive holds no report." },
		preview: noClaim("Preview runs no report."),
		elsewhere: defaultsTo("2.0"),
		base: "starter-health",
	},
	"application-and-settings/45p-hq-auto-gps-capture-on-an-app-that-is-not-a-connect-app":
		{
			kind: "setting",
			label: "location-with-every-form",
			ccz: {
				does: "mirrors",
				by: "lib/commcare/xform/metaBlock.ts::addMetaBlock",
			},
			preview: noClaim("Preview submits no `meta/location`."),
			elsewhere: defaultsTo("off"),
			base: "hq-kept-settings",
		},
	"application-and-settings/51-hq-persistent-menu": {
		kind: "setting",
		label: "persistent-menu",
		ccz: {
			does: "no-reader",
			why: "Only Web Apps reads it, from HQ's build.",
		},
		preview: noClaim("Preview draws no persistent menu."),
		elsewhere: defaultsTo("off"),
		base: "hq-kept-settings",
	},
	"application-and-settings/52-hq-show-breadcrumbs": {
		kind: "setting",
		label: "web-apps-breadcrumbs",
		ccz: {
			does: "no-reader",
			why: "Only Web Apps reads it, from HQ's build.",
		},
		preview: noClaim("The trail above Preview is the builder's."),
		elsewhere: defaultsTo("on"),
		base: "hq-kept-settings",
	},
	"application-and-settings/43-hq-secure-submissions": {
		kind: "setting",
		label: "secure-submissions",
		ccz: {
			does: "mirrors",
			by: "lib/commcare/runtimeTarget.ts::profileServerProperties",
		},
		preview: NO_RECEIVER,
		elsewhere: defaultsTo(
			"off (the import that makes Nova's app copies no project space setting)",
		),
		base: "starter-health",
	},
	"application-and-settings/36-hq-custom-base-url": {
		kind: "setting",
		label: "custom-base-url",
		ccz: {
			does: "mirrors",
			by: "lib/commcare/runtimeTarget.ts::profileServerProperties",
		},
		preview: NO_RECEIVER,
		elsewhere: defaultsTo("none"),
		/* The base holds a second origin with a path. */
		base: "hq-kept-settings",
	},
	"application-and-settings/35-hq-practice-mobile-worker-id": {
		kind: "setting",
		label: "practice-mobile-worker",
		ccz: { does: "states", advisory: "kept_practice_worker_absent" },
		preview: noClaim("Preview has no practice mode."),
		elsewhere: defaultsTo("none"),
		base: "hq-kept-settings",
	},
	/* No label: a version at or above the floor is no difference a person set against Nova. */
	"application-and-settings/34-hq-build-spec-at-or-above-nova-s-floor-2-57": {
		kind: "setting",
		ccz: { does: "own", why: "The profile requires Nova's floor, 2.57." },
		preview: noClaim("Preview runs Nova's own engine."),
		elsewhere: defaultsTo("the server's default build"),
		base: "hq-new-app",
	},
	/* No label: the row holds an app with no build profile. */
	"application-and-settings/build-profiles-each-profile-s-name-langs-practice-mobile-worker":
		{
			kind: "setting",
			ccz: { does: "no-reader", why: "An archive is one build." },
			preview: NO_CLAIM,
			elsewhere: defaultsTo("none"),
			base: "hq-new-app",
		},
	"application-and-settings/32-features-credentials": {
		kind: "setting",
		label: "worker-activity-credential",
		/* `compileCcz` writes the profile, whose `<features>` end with the `<credentials>` block. */
		ccz: { does: "mirrors", by: "lib/commcare/compiler.ts::compileCcz" },
		preview: noClaim("Preview shows no work history."),
		elsewhere: ITS_OWN,
		base: "hq-kept-settings",
	},
	"application-and-settings/target-derived-profile-properties-posturl-posttesturl-ota":
		{
			kind: "setting",
			ccz: {
				does: "own",
				why: "The four server properties and `cur_locale`, for the archive's project space.",
			},
			preview: NO_CLAIM,
			elsewhere: ITS_OWN,
			base: "hq-new-app",
		},
	"application-and-settings/amplifies-workers-amplifies-project-minimum-use-threshold":
		{ ...SERVER_RECORD, elsewhere: HQ_DEFAULT },
	"application-and-settings/rev-domain-copy-of-version": {
		...SERVER_RECORD,
		ccz: { does: "own", why: "The archive's version is the app's sequence." },
	},
	"application-and-settings/short-odk-url-short-odk-media-url": SERVER_RECORD,
	"application-and-settings/built-with-build-signed-built-on-build-comment-comment-from-last":
		SERVER_RECORD,
	"application-and-settings/date-created-created-from-template-last-modified-has-submissions":
		SERVER_RECORD,
	"application-and-settings/copy-history-family-id": SERVER_RECORD,
	"application-and-settings/external-blobs": SERVER_RECORD,
	"application-and-settings/archived-media": SERVER_RECORD,
	"application-and-settings/id": {
		kind: "identity",
		ccz: {
			does: "own",
			why: "`profileUniqueId`, Nova's id for the app on the project space.",
		},
		preview: NO_CLAIM,
		elsewhere: ITS_OWN,
		base: "hq-new-app",
	},
	"application-and-settings/multimedia-map": {
		kind: "identity",
		ccz: {
			does: "own",
			why: "The archive bundles each file at the path its references name.",
		},
		preview: {
			does: "reads",
			by: "components/builder/media/ProjectMediaResource.tsx::useProjectMediaUrl",
		},
		elsewhere: ITS_OWN,
		base: "starter-health",
	},
	"menus-and-case-lists/modulebase-unique-id": RECORDED_IDS,
	"forms-and-case-writes/unique-id": RECORDED_IDS,
	"forms-and-case-writes/version": {
		...SERVER_RECORD,
		ccz: { does: "own", why: "Each form takes the app's sequence." },
	},
	"expressions-and-data/hq-table-and-row-ids-uuid4-a-workbook-upload-re-mints-a-table":
		{ kind: "identity", ...PROJECT_TABLE },
	"expressions-and-data/is-synced-last-modified": {
		kind: "server-record",
		...PROJECT_TABLE,
	},
	"case-search/domain-casesearchconfig-sync-cases-on-form-entry": PROJECT_STATE,
	"forms-and-case-writes/supply-point-id-datum-hq-injects-under-commtrack-enabled-into":
		PROJECT_STATE,
	"forms-and-case-writes/data-dictionary-caseproperty-data-type": PROJECT_STATE,
	"forms-and-case-writes/usercase-creation-and-sync-hq-user-id": PROJECT_STATE,
};
