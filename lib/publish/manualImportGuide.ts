import { NATIVE_INSTALLATION_CHOICES } from "@/lib/domain/installationProfiles";
import { AS_ORIGIN } from "@/lib/hostnames";
import {
	MANUAL_LOOKUP_INSTALL_PATH,
	MANUAL_LOOKUP_MANIFEST,
} from "./manualLookupManifest";
/**
 * The steps a person takes to bring the HQ import file into CommCare HQ by
 * hand, derived from what the file carries and what the app needs.
 *
 * One derivation, read in three places: the `README.txt` of the import
 * file's ZIP, the publish dialog's outcome after the download, and a text
 * block of the MCP `compile_app` result. The guide takes inputs its callers
 * already derived with the functions a publish's own checks read, so this
 * module imports nothing from `lib/commcare` and the file and a publish
 * never name different requirements. It is never stored.
 */

import {
	DISTANCE_SEARCH_SETUP_CAVEATS,
	DISTANCE_SEARCH_SETUP_TITLE,
	type DistanceSearchSetupProperty,
	distanceSearchSetupReaders,
	distanceSearchSetupStep,
	distanceSearchSetupSummary,
} from "./distanceSearchSetup";
import {
	type ManagedLookupGuideFile,
	managedLookupGuideLines,
	managedLookupGuideTitle,
} from "./managedData";
import { namesInWords } from "./planFeatures";
import {
	PROJECT_SPACE_COMPATIBILITY_DOCS_URL,
	PROJECT_SPACE_COMPATIBILITY_SUPPORT_EMAIL,
} from "./projectSpaceCompatibility";

export type ManualImportStepKind =
	| "install-lookup-data"
	| "lookup-tables"
	| "managed-lookup-tables"
	| "bind-project-data"
	| "practice-installations"
	| "import-app"
	| "commcare-version"
	| "media"
	| "capabilities"
	| "same-type-child-links"
	| "plan-features"
	| "logo"
	| "web-apps"
	| "flat-location-fixture"
	| "connect-forwarding"
	| "form-entry-sync-off"
	| "commtrack-off"
	| "distance-search";

const STEP_KINDS: ReadonlySet<string> = new Set<ManualImportStepKind>([
	"lookup-tables",
	"install-lookup-data",
	"managed-lookup-tables",
	"bind-project-data",
	"practice-installations",
	"import-app",
	"commcare-version",
	"media",
	"capabilities",
	"same-type-child-links",
	"plan-features",
	"logo",
	"web-apps",
	"flat-location-fixture",
	"connect-forwarding",
	"form-entry-sync-off",
	"commtrack-off",
	"distance-search",
]);

export interface ManualImportStep {
	readonly kind: ManualImportStepKind;
	readonly title: string;
	/** The step's text as the README holds it, one line per entry. */
	readonly lines: readonly string[];
}

/**
 * A step's identity within one guide. A guide holds one step of each kind
 * but `managed-lookup-tables`, which it holds once per managed workbook, and
 * each of those titles names its own project space (with its server where
 * two share a domain), so kind and title together name one step.
 */
export function manualImportStepKey(step: ManualImportStep): string {
	return `${step.kind}:${step.title}`;
}

export interface ManualImportGuideInput {
	/** The app JSON's member name in the ZIP, without its extension. */
	readonly appFileName: string;
	readonly practiceInstallations?: readonly {
		readonly name: string;
		readonly languages: readonly string[];
	}[];
	/** The tag of each lookup table the workbook carries; empty for none. */
	readonly lookupTags: readonly string[];
	readonly manualLookupTables?: readonly string[];
	readonly additionalLookupFiles?: readonly {
		path: string;
		tags: readonly string[];
	}[];
	/**
	 * The file's workbooks of the lookup tables CommCare HQ manages, one per
	 * project space that manages some, in the order the archive holds them:
	 * each file's name, that project space, and each table with the UTC day
	 * Nova's copy was last refreshed. Empty for none.
	 */
	readonly managedLookupFiles: readonly ManagedLookupGuideFile[];
	readonly referencedTables?: readonly { tag: string; projectSpace?: string }[];
	readonly hasMedia: boolean;
	/** The floor as text, "2.57". The caller formats it; the guide imports no constant. */
	readonly versionFloor: string;
	/** `ProjectSpaceCapabilityUse`'s label and reasons, one per capability the app needs. */
	readonly capabilities: readonly {
		readonly label: string;
		readonly reasons: readonly string[];
	}[];
	/** The plan features the app's content needs. */
	readonly planFeatures: readonly {
		readonly label: string;
		readonly plans: string;
		readonly consequence: string;
	}[];
	/** The app's logo file, or null for an app with none. */
	readonly logo: { readonly fileName: string } | null;
	/** Whether the app runs in Web Apps (`declaresWebApps`). */
	readonly runsInWebApps: boolean;
	/** Whether the app reads the project space's locations. */
	readonly readsLocations: boolean;
	/** Whether the app's forms hold a CommCare Connect block. */
	readonly sendsToConnect: boolean;
	/** Whether publish would ask that sync on form entry is off (`formEntrySyncReasons` names a form). */
	readonly formEntrySync: boolean;
	/** Whether publish would ask that CommCare Supply is off (`commtrackReasons` names a menu or a form). */
	readonly commtrack: boolean;
	/**
	 * The name of each form that makes a case linked to a case of its own
	 * type (`sameTypeBasicChildCases`), in document order; empty for none.
	 */
	readonly sameTypeChildLinks: readonly string[];
	/** Each case property a search measures distance on; empty for none. */
	readonly distanceSearches: readonly DistanceSearchSetupProperty[];
}

/** The ZIP's member that holds the lookup tables. */
export const MANUAL_IMPORT_LOOKUP_WORKBOOK = "lookup-tables.xlsx";
/**
 * The start of each ZIP member that holds Nova's copy of the lookup tables
 * one project space manages in CommCare HQ; the rest of the name is that
 * project space's. A file of its own per project space, so a person
 * importing into a project space that manages some of them leaves that one
 * file out and touches nothing CommCare HQ manages there.
 */
export const MANUAL_IMPORT_MANAGED_LOOKUP_WORKBOOK_PREFIX =
	"lookup-tables-managed-in-";
/** The ZIP's member that holds the media, in CommCare HQ's bulk-upload format. */
export const MANUAL_IMPORT_MEDIA_ZIP = "multimedia.zip";

/**
 * The lookup step names the page rather than the upload URL because
 * `fixtures/urls.py` answers a GET to `edit_lookup_tables/upload/` with a
 * redirect back to the table list: the upload form lives on the list page
 * (`templates/fixtures/manage_tables.html`), and so does the "Replace
 * existing tables" box that makes CommCare HQ's copy match Nova's. It comes
 * first, so the app finds its data the moment CommCare HQ builds it.
 */
function lookupTablesStep(
	tags: readonly string[],
	fileName = MANUAL_IMPORT_LOOKUP_WORKBOOK,
): ManualImportStep {
	return {
		kind: "lookup-tables",
		title:
			fileName === MANUAL_IMPORT_LOOKUP_WORKBOOK
				? "Upload the lookup tables"
				: `Upload ${fileName}`,
		lines: [
			"Open the Lookup Tables page in CommCare HQ:",
			"  https://www.commcarehq.org/a/<your-project>/fixtures/",
			"",
			`Upload "${fileName}" there, tick "Replace existing`,
			"tables\", and click Upload Tables. Replacing makes CommCare's copy of",
			"each table in the file match this export exactly. Tables the file",
			"doesn't mention are left alone.",
			"",
			`The file carries ${tags.join(", ")}. If your project already has a table with one`,
			"of those names, uploading replaces its rows.",
		],
	};
}

/**
 * One step per workbook of tables CommCare HQ manages, right after the
 * first workbook's. Uploading one into the project space that manages its
 * tables would replace their rows there with Nova's copy, so its step says
 * to leave it out there; the first, where the file carries no first
 * workbook, says how to upload it anywhere else, and each later one points
 * at the step above.
 */
function managedLookupTablesSteps(
	files: readonly ManagedLookupGuideFile[],
	afterLookupTablesStep: boolean,
): readonly ManualImportStep[] {
	const several = files.length > 1;
	return files.map((file, index) => ({
		kind: "managed-lookup-tables",
		title: managedLookupGuideTitle(file, several),
		lines: managedLookupGuideLines(file, {
			several,
			afterUploadStep: afterLookupTablesStep || index > 0,
		}),
	}));
}

/**
 * The dummy App URL is load-bearing, not a placeholder: CommCare HQ's only
 * UI path to upload an app's JSON is "Import App from Another Server", whose
 * first screen requires a source-app URL. That screen never fetches the URL:
 * it validates the shape and checks the subdomain is a CommCare server other
 * than the current one (`domain/forms.py::ExtractAppInfoForm`:
 * `^https://[^/]+/a/(?P<domain>[^/]+)/apps/view/(?P<app_id>[a-f0-9]{32})/?`
 * plus a `{www|india|eu}.commcarehq.org` subdomain check that must differ from
 * `SERVER_ENVIRONMENT`). So a fixed dummy with a 32-hex app id and the `india`
 * subdomain passes the gate; the real JSON is uploaded on the next screen.
 */
function importAppStep(appFileName: string): ManualImportStep {
	return {
		kind: "import-app",
		title: "Import the app",
		lines: [
			"In CommCare HQ, open the Settings (gear) menu -> Project Settings ->",
			"Import App from Another Server:",
			"  https://www.commcarehq.org/a/<your-project>/settings/project/import_app/",
			"",
			"This is the only place CommCare's UI lets you upload an app's JSON. The",
			"first screen asks for an 'App URL' from another server, but it only",
			"checks the URL's shape and that the server differs from yours, it never",
			"opens the link. Paste this exact dummy URL and click Next:",
			"",
			"  https://india.commcarehq.org/a/x/apps/view/00000000000000000000000000000000/",
			"",
			"(If your CommCare instance IS the India server, change 'india' to 'www'.",
			" The only rule: the subdomain must be www, india, or eu, and not yours.)",
			"",
			`On the next screen, upload "${appFileName}.json", name the app, and import.`,
		],
	};
}

function commCareVersionStep(versionFloor: string): ManualImportStep {
	return {
		kind: "commcare-version",
		title: "Check the app's CommCare version",
		lines: [
			`This app needs CommCare ${versionFloor} or later.`,
			"",
			"In CommCare HQ, the app's settings show its CommCare version. If the",
			`version there is lower, you can raise it to ${versionFloor} or later and`,
			"save.",
			"",
			"After that, phones on an older CommCare can no longer install or update",
			"the app.",
		],
	};
}

function mediaStep(): ManualImportStep {
	return {
		kind: "media",
		title: "Import the media",
		lines: [
			"After the app imports, CommCare shows an instructions page with a link to",
			`your new app's multimedia upload. Open it and upload "${MANUAL_IMPORT_MEDIA_ZIP}".`,
			"The files are named by content hash and match the app's references",
			"automatically, so they attach to the right places.",
		],
	};
}

function capabilitiesStep(
	capabilities: ManualImportGuideInput["capabilities"],
): ManualImportStep {
	return {
		kind: "capabilities",
		title: "Check what the project space supports",
		lines: [
			"This app uses features that CommCare HQ turns on for one project space at",
			"a time:",
			"",
			...capabilities.map(
				(capability) =>
					`  - ${capability.label}: ${capability.reasons.join(" ")}`,
			),
			"",
			"If the project space doesn't have one of these yet, Dimagi support can",
			`turn it on for you: ${PROJECT_SPACE_COMPATIBILITY_SUPPORT_EMAIL}. There is`,
			`more about each one at ${PROJECT_SPACE_COMPATIBILITY_DOCS_URL}.`,
		],
	};
}

/**
 * HQ's build drops a basic form's link from a new case to a case of the
 * same type in a project space with an old feature flag on
 * (`app_manager/xform.py::XForm._create_casexml`). The import file has no
 * target to check, and only Dimagi can turn that flag off, so this step
 * stands apart from the capabilities step, whose features Dimagi turns on.
 */
function sameTypeChildLinksStep(forms: readonly string[]): ManualImportStep {
	return {
		kind: "same-type-child-links",
		title: "Links between cases of the same type",
		lines: [
			`${namesInWords(forms)} make a case linked to a case of the same type. A few older project spaces drop that link, and there those forms lose it.`,
			`It helps to ask Dimagi Support whether this project space keeps it: ${PROJECT_SPACE_COMPATIBILITY_SUPPORT_EMAIL}.`,
		],
	};
}

/**
 * The plan features the app needs, which the import file cannot check: no
 * API key reads a project space's plan, so the person looks for each one on
 * the project space's subscription page.
 */
function planFeaturesStep(
	planFeatures: ManualImportGuideInput["planFeatures"],
): ManualImportStep {
	return {
		kind: "plan-features",
		title: "Check the project space's plan",
		lines: [
			"This app uses features that come with some CommCare HQ plans and not others:",
			"",
			...planFeatures.map(
				(feature) =>
					`  - ${feature.label}: ${feature.plans}. ${feature.consequence}`,
			),
			"",
			"It helps to check that the project space's plan includes each one, on its Current Subscription page in CommCare HQ.",
		],
	};
}

/** The app's logo travels beside the app file, never in it. */
function logoStep(logo: { readonly fileName: string }): ManualImportStep {
	return {
		kind: "logo",
		title: "Your app's logo",
		lines: [
			`The ZIP holds your logo as "${logo.fileName}"; it isn't part of the app file.`,
			"To show it in apps built on CommCare HQ, you can add it in the imported app's settings there. That takes a plan with the Custom CommCare Logo Uploader (Advanced or Enterprise); on other plans, apps built on CommCare HQ carry no logo.",
		],
	};
}

/**
 * A manual import is a create, so CommCare HQ sets the app's Web App setting
 * from the plan whatever the file says (`_create_app_from_doc`), and no
 * update follows. An app that runs on Android only is then offered in Web
 * Apps wherever the plan includes it, though it isn't made for it.
 */
function webAppsStep(): ManualImportStep {
	return {
		kind: "web-apps",
		title: "Web Apps",
		lines: [
			"This app runs on Android only.",
			"CommCare HQ turns Web Apps on for an imported app wherever the project space's plan includes it. It helps to open the imported app's settings in CommCare HQ and turn “Web App” off, so workers don't meet it in Web Apps.",
		],
	};
}

/**
 * Every app carries `project_default`, so phones and Web Apps take the flat
 * location list by the project space's own setting, which nothing here can
 * read.
 */
function flatLocationFixtureStep(): ManualImportStep {
	return {
		kind: "flat-location-fixture",
		title: "The location list",
		lines: [
			"This app reads the places in your organization, on phones and in Web Apps, and its forms that do can't work without them.",
			"It helps to check that the project space still sends its location list to workers. It does unless someone turned that off on its Location Fixture page. Phones and Web Apps both follow that setting.",
		],
	};
}

/** A Connect app's forms reach CommCare Connect only through HQ's data forwarding. */
function connectForwardingStep(): ManualImportStep {
	return {
		kind: "connect-forwarding",
		title: "Check that the app's forms reach CommCare Connect",
		lines: [
			"This app's forms reach CommCare Connect only through CommCare HQ's data forwarding.",
			"It helps to check that the project space's plan includes Data Forwarding and that it has a forwarder set up as Forward Form Metadata to Commcare Connect.",
		],
	};
}

/**
 * HQ's build gives a form that works on a case chosen in a menu with Search a
 * claim that always posts while the project space syncs cases on form entry,
 * and Android can't open a form whose entry asks for a sync.
 */
function formEntrySyncStep(): ManualImportStep {
	return {
		kind: "form-entry-sync-off",
		title: "Sync Cases On Form Entry",
		lines: [
			"This app's forms that work on a case chosen in a menu with Search open on Android phones only while the project space has Sync Cases On Form Entry turned off.",
			"It helps to check that it's off on the project space's Case Search page in CommCare HQ. It's off unless someone turned it on.",
		],
	};
}

/**
 * Where the project space has CommCare Supply on, HQ's build adds a product
 * to choose and a supply point datum this app doesn't have
 * (`suite_xml/sections/entries.py::EntriesHelper.entry_for_module`), and no
 * API key reads the setting.
 */
function commtrackStep(): ManualImportStep {
	return {
		kind: "commtrack-off",
		title: "CommCare Supply",
		lines: [
			"CommCare HQ adds steps this app doesn't have where the project space has CommCare Supply on.",
			`It helps to check with Dimagi Support that it's off: ${PROJECT_SPACE_COMPATIBILITY_SUPPORT_EMAIL}. It's off unless Dimagi turned it on.`,
		],
	};
}

/** Each property a search measures distance on needs the GPS type in HQ's Data Dictionary. */
function distanceSearchStep(
	properties: readonly DistanceSearchSetupProperty[],
): ManualImportStep {
	return {
		kind: "distance-search",
		title: DISTANCE_SEARCH_SETUP_TITLE,
		lines: [
			distanceSearchSetupSummary(null),
			"",
			"Open the Data Dictionary in CommCare HQ:",
			"  https://www.commcarehq.org/a/<your-project>/data_dictionary/",
			"",
			...properties.map(
				(entry) =>
					`  - ${distanceSearchSetupStep(entry)} ${distanceSearchSetupReaders(entry)}`,
			),
			"",
			...DISTANCE_SEARCH_SETUP_CAVEATS,
		],
	};
}

/** The steps that apply to this file, in the order a person takes them. */
export function manualImportGuide(
	input: ManualImportGuideInput,
): readonly ManualImportStep[] {
	return [
		...(input.manualLookupTables?.length
			? [
					{
						kind: "install-lookup-data" as const,
						title: "Install lookup data in Nova",
						lines: [
							`Open ${AS_ORIGIN}${MANUAL_LOOKUP_INSTALL_PATH} and choose "${MANUAL_LOOKUP_MANIFEST}" from this ZIP.`,
							"Choose the same connected project space where you’ll import the app. Complete the lookup install before importing the app JSON.",
							`Tables: ${input.manualLookupTables.join(", ")}.`,
						],
					},
				]
			: []),
		...(input.lookupTags.length > 0
			? [lookupTablesStep(input.lookupTags)]
			: []),
		...(input.additionalLookupFiles ?? []).map((file) =>
			lookupTablesStep(file.tags, file.path),
		),
		...managedLookupTablesSteps(
			input.managedLookupFiles,
			input.lookupTags.length > 0,
		),
		...(input.referencedTables?.length
			? [
					{
						kind: "bind-project-data" as const,
						title: "Connect your project space’s data",
						lines: [
							...input.referencedTables.map(({ tag, projectSpace }) =>
								projectSpace
									? `“${tag}” uses the existing table in ${projectSpace}. When importing there, keep that table in place.`
									: `“${tag}” needs a table in the destination project space.`,
							),
							"Before importing into another space, its admin can prepare each table from a current selected-table export in CommCare HQ. Check its tag, columns, indexes, row values and order. For assigned rows, match users, groups and places to the intended recipients in that space and verify which rows they receive when they sync.",
							"To use different data, you can create a table in Project data, choose its lookup and sharing settings, and connect your app’s fields to that table before downloading a new app file.",
						],
					},
				]
			: []),
		importAppStep(input.appFileName),
		commCareVersionStep(input.versionFloor),
		...(input.practiceInstallations?.length
			? [
					{
						kind: "practice-installations" as const,
						title: "Choose the practice workers for these installations",
						lines: [
							"After importing the app, open Releases → Application Profiles in this project space. Give any blank or repeated profiles different names so you can identify each one in the download menu. Select an active practice worker for each installation and save.",
							...input.practiceInstallations.map(
								({ name, languages }) =>
									`• ${name || "Unnamed profile"} (${languages.join(" → ")}).`,
							),
							NATIVE_INSTALLATION_CHOICES,
							"Choose Make new version. Under Deploy → Download to Android → Offline Installation, select each named Application Profile and download its CommCare_vN.ccz. Open it on a device and check the expected language and practice data before sending it to workers.",
						],
					},
				]
			: []),
		...(input.hasMedia ? [mediaStep()] : []),
		...(input.capabilities.length > 0
			? [capabilitiesStep(input.capabilities)]
			: []),
		...(input.sameTypeChildLinks.length > 0
			? [sameTypeChildLinksStep(input.sameTypeChildLinks)]
			: []),
		...(input.planFeatures.length > 0
			? [planFeaturesStep(input.planFeatures)]
			: []),
		...(input.logo === null ? [] : [logoStep(input.logo)]),
		...(input.runsInWebApps ? [] : [webAppsStep()]),
		...(input.readsLocations ? [flatLocationFixtureStep()] : []),
		...(input.sendsToConnect ? [connectForwardingStep()] : []),
		...(input.formEntrySync ? [formEntrySyncStep()] : []),
		...(input.commtrack ? [commtrackStep()] : []),
		...(input.distanceSearches.length > 0
			? [distanceSearchStep(input.distanceSearches)]
			: []),
	];
}

/** The guide as the ZIP's `README.txt` holds it. */
export function renderManualImportGuide(
	steps: readonly ManualImportStep[],
): string {
	return [
		"Import this app into CommCare HQ",
		"",
		...steps.flatMap((step, index) => [
			`=== ${index + 1}. ${step.title} ===`,
			"",
			...step.lines,
			"",
		]),
	].join("\n");
}

/** The response header `/api/compile/json` carries the steps in, for the publish dialog. */
export const MANUAL_IMPORT_GUIDE_HEADER = "X-Nova-Manual-Import-Guide";

/**
 * The most the header's value holds, in encoded characters. Proxies between
 * the route and the browser refuse a response whose headers run long, and a
 * guide that names many lookup tables or capability reasons can, so the
 * header stays well under the limits they commonly set.
 */
export const MANUAL_IMPORT_GUIDE_HEADER_LIMIT = 8 * 1024;

/** What a step the header has no room for says in the dialog. */
export const MANUAL_IMPORT_STEP_IN_README =
	"The README.txt in the ZIP has this step in full.";

/**
 * The steps as the header carries them, within
 * `MANUAL_IMPORT_GUIDE_HEADER_LIMIT`. Every step keeps its title, in order.
 * While the guide runs over, the longest step still carrying its text gives
 * it up for the line that points to the README, which always holds the guide
 * in full.
 */
export function encodeManualImportGuide(
	steps: readonly ManualImportStep[],
): string {
	const carried = [...steps];
	const encode = () => encodeURIComponent(JSON.stringify(carried));
	const longestFirst = steps
		.map((step, index) => ({
			index,
			length: encodeURIComponent(JSON.stringify(step.lines)).length,
		}))
		.sort((a, b) => b.length - a.length);
	let encoded = encode();
	for (const { index } of longestFirst) {
		if (encoded.length <= MANUAL_IMPORT_GUIDE_HEADER_LIMIT) break;
		carried[index] = { ...steps[index], lines: [MANUAL_IMPORT_STEP_IN_README] };
		encoded = encode();
	}
	return encoded;
}

function isManualImportStep(value: unknown): value is ManualImportStep {
	if (typeof value !== "object" || value === null) return false;
	const step = value as Record<string, unknown>;
	return (
		typeof step.kind === "string" &&
		STEP_KINDS.has(step.kind) &&
		typeof step.title === "string" &&
		Array.isArray(step.lines) &&
		step.lines.every((line) => typeof line === "string")
	);
}

/** Empty for a missing or unreadable header: the bytes already arrived, and the README holds the guide. */
export function decodeManualImportGuide(
	value: string | null,
): readonly ManualImportStep[] {
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(decodeURIComponent(value));
		return Array.isArray(parsed) && parsed.every(isManualImportStep)
			? parsed
			: [];
	} catch {
		return [];
	}
}
