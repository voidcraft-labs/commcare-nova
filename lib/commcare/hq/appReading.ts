import "server-only";

/**
 * A bring-in's read of one app on CommCare HQ, made as one bracketed
 * attempt: the application resource (its save counter V, its real form ids
 * and HQ's question summary), the source, then the save counter again
 * (`views/releases.py::current_app_version`). Equal counters mean the source
 * read lies between two moments at which the app document and its media map
 * were the same: `models/applications.py::ApplicationBase.save` raises the
 * counter on every save of a working app but two (a restore of a deleted
 * app, and a linked app's pull), and a bring-in reads neither.
 *
 * Each read owns its own deadline and none is shared: the two whose body is
 * the app have `HQ_APP_BODY_DEADLINE_MS` each and are bounded at
 * `HQ_BRING_IN_APP_MAX_BYTES`, the counter and the app list the default. The
 * caller's `cancel` is handed to every read. The attempt is never retried
 * here: `changed` is one attempt's answer, and how many attempts a bring-in
 * makes is its caller's rule.
 */

import { log } from "@/lib/logger";
import { readAppVersions } from "../client";
import {
	type HqApplication,
	type HqApplicationModule,
	type HqQuestionSummary,
	type HqSummaryErrorShape,
	hqApplicationModules,
	readHqApplication,
} from "./application";
import {
	type HqAppSource,
	type HqAppSourceForm,
	readHqAppSource,
} from "./appSource";
import { listHqApps } from "./apps";
import {
	classifyHqFailure,
	type HqFailure,
	type HqRequestKind,
} from "./failure";
import {
	apiRefusalSentence,
	type CommCareApiError,
	type CommCareCredentials,
	HQ_MALFORMED_ANSWER,
} from "./http";

/** The deadline of each of the two reads of a bring-in whose body is the app. */
export const HQ_APP_BODY_DEADLINE_MS = 60_000;
/** The most bytes of an app body a bring-in reads: 16 MiB. A longer one is refused unparsed. */
export const HQ_BRING_IN_APP_MAX_BYTES = 16 * 1024 * 1024;

export interface HqAlignedForm {
	/** The form's real `unique_id`, from the application resource. */
	readonly uniqueId: string;
	/**
	 * The `xmlns` both reads agree on: the form's own, or for a shadow form its parent's. Null
	 * where neither read holds one.
	 */
	readonly xmlns: string | null;
	/** The source read's form at the same position. */
	readonly source: HqAppSourceForm;
	readonly questions: readonly HqQuestionSummary[];
}

export type HqAlignedModule =
	| {
			readonly kind: "aligned";
			/** The source menu's `unique_id`; null where the menu stores none. */
			readonly uniqueId: string | null;
			/** The source menu's `doc_type`. */
			readonly docType: string;
			readonly forms: readonly HqAlignedForm[];
	  }
	/**
	 * HQ could not summarize the menu at this position; its forms have no real ids. `shape` says
	 * what HQ's text was like and holds none of it: the text quotes the app, so no log line, no
	 * finding and no person reads it.
	 */
	| {
			readonly kind: "not-summarized";
			readonly uniqueId: string | null;
			readonly docType: string;
			readonly shape: HqSummaryErrorShape;
	  };

export type HqFormAlignment =
	| { readonly kind: "aligned"; readonly modules: readonly HqAlignedModule[] }
	| { readonly kind: "misaligned"; readonly at: string };

/**
 * Pair the application resource's modules and forms with the source's, by
 * position. Both reads serve them in stored order (`Application.get_modules`
 * and `ModuleBase.get_forms` are getters over the stored lists), so the
 * pairing is the position, and each menu's `unique_id` and each form's
 * `xmlns` confirm it. Any disagreement is `misaligned` at the place it was
 * found: real ids paired to the wrong forms would publish over HQ's forms
 * with crossed ids.
 *
 * A source form's expected `xmlns` is its stored one; a shadow form stores
 * none and the resource reports its parent's (`models/forms.py::ShadowForm.xmlns`),
 * so its expected value is its parent's, followed through the same read's
 * forms. Null is equal to null alone. A menu that stores no `unique_id` is
 * aligned by position alone, and an error entry, which names no menu, gives
 * `not-summarized` at the source menu of its position.
 */
export function alignHqForms(
	source: HqAppSource,
	modules: readonly HqApplicationModule[],
): HqFormAlignment {
	const misaligned = (at: string): HqFormAlignment => ({
		kind: "misaligned",
		at,
	});
	if (source.modules.length !== modules.length) return misaligned("modules");
	const expectedXmlns = expectedXmlnsOf(source);
	const aligned: HqAlignedModule[] = [];
	for (const [i, entry] of modules.entries()) {
		const menu = source.modules[i];
		if (entry.kind === "error") {
			aligned.push({
				kind: "not-summarized",
				uniqueId: menu.uniqueId,
				docType: menu.docType,
				shape: entry.shape,
			});
			continue;
		}
		if (menu.uniqueId !== null && entry.uniqueId !== menu.uniqueId)
			return misaligned(`modules[${i}].unique_id`);
		if (entry.forms.length !== menu.forms.length)
			return misaligned(`modules[${i}].forms`);
		const forms: HqAlignedForm[] = [];
		for (const [j, form] of entry.forms.entries()) {
			const sourceForm = menu.forms[j];
			const xmlns = expectedXmlns(sourceForm);
			if (form.xmlns !== xmlns)
				return misaligned(`modules[${i}].forms[${j}].xmlns`);
			forms.push({
				uniqueId: form.uniqueId,
				xmlns,
				source: sourceForm,
				questions: form.questions,
			});
		}
		aligned.push({
			kind: "aligned",
			uniqueId: menu.uniqueId,
			docType: menu.docType,
			forms,
		});
	}
	return { kind: "aligned", modules: aligned };
}

/**
 * The `xmlns` the resource reports for each source form: its stored one, or
 * where that is null, its shadow parent's, followed for at most as many
 * steps as the app has forms. Null where there is none, the parent is not
 * among the read's forms, or the steps run out.
 */
function expectedXmlnsOf(
	source: HqAppSource,
): (form: HqAppSourceForm) => string | null {
	const forms = source.modules.flatMap((menu) => menu.forms);
	const byReadId = new Map(forms.map((form) => [form.readUniqueId, form]));
	return (form) => {
		let current: HqAppSourceForm | undefined = form;
		for (let step = 0; step <= forms.length && current !== undefined; step++) {
			if (current.xmlns !== null) return current.xmlns;
			if (current.shadowParentReadId === null) return null;
			current = byReadId.get(current.shadowParentReadId);
		}
		return null;
	};
}

/** The source `doc_type`s of the menus HQ's summary is expected to hold. */
const SUMMARIZED_MENU_DOC_TYPES: ReadonlySet<string> = new Set([
	"Module",
	"AdvancedModule",
]);

/**
 * Which findings HQ's failed summaries are: none, one at each named menu, or
 * one at the app. `indexes` are positions in `modules`.
 *
 * Only a basic or an advanced menu is one HQ's summary is expected to hold;
 * a mirror menu or a report menu already has its own finding, and nothing
 * in its failed summary is the person's to fix. `dehydrate_module` computes
 * the app's case properties before it reads any form, so where every
 * expected menu of two or more failed, no one menu holds the cause.
 */
export function notSummarizedMenus(
	modules: readonly HqAlignedModule[],
):
	| { readonly kind: "none" }
	| { readonly kind: "menus"; readonly indexes: readonly number[] }
	| { readonly kind: "app" } {
	const expected = modules.flatMap((menu, index) =>
		SUMMARIZED_MENU_DOC_TYPES.has(menu.docType) ? [{ menu, index }] : [],
	);
	const failed = expected.filter(({ menu }) => menu.kind === "not-summarized");
	if (failed.length === 0) return { kind: "none" };
	if (failed.length === expected.length && expected.length >= 2)
		return { kind: "app" };
	return { kind: "menus", indexes: failed.map(({ index }) => index) };
}

export type HqAppReading =
	| {
			readonly kind: "read";
			readonly version: number;
			readonly application: HqApplication;
			readonly source: HqAppSource;
			readonly modules: readonly HqAlignedModule[];
	  }
	/** The app was saved between the first read and the last. */
	| { readonly kind: "changed" }
	| { readonly kind: "linked" }
	| { readonly kind: "remote" }
	| { readonly kind: "deleted" }
	| { readonly kind: "gone" }
	| { readonly kind: "failed"; readonly failure: HqFailure };

function failed(
	error: CommCareApiError,
	request: HqRequestKind,
	member?: boolean,
): HqAppReading {
	return {
		kind: "failed",
		failure: classifyHqFailure(
			error,
			request,
			member === undefined ? {} : { member },
		),
	};
}

/**
 * Read the app `appId` of `domain` for a bring-in, as one bracketed attempt.
 *
 * The application resource goes first: it is the API access check. A 404, a
 * 403, or a 401 holding the plan sentence, that is not the edge's asks the
 * app list once, the one read that needs membership alone. On a 403 or that
 * 401 the list answering proves membership, so the 403 is a permission and
 * the 401 the plan; the list refusing is lost membership, or a project space
 * that is gone, whose resources answer the plan sentence because
 * `HqBaseResource.dispatch` checks the default plan of a project space that
 * does not exist before it asks who is calling. On a 404 the list holding the
 * app makes it `remote` (the list's view holds remote apps, which the
 * resource does not admit); otherwise the source read says only whether HQ
 * holds it as deleted, and a deleted document that may be a build is `gone`.
 * A build's id is `gone`: no working app of the project space has it.
 */
export async function readHqAppForReading(
	creds: CommCareCredentials,
	domain: string,
	appId: string,
	options: { readonly cancel?: AbortSignal } = {},
): Promise<HqAppReading> {
	const { cancel } = options;
	const bodyRead = {
		deadlineMs: HQ_APP_BODY_DEADLINE_MS,
		maxBytes: HQ_BRING_IN_APP_MAX_BYTES,
		cancel,
	};

	/* 1. The application resource. */
	const application = await readHqApplication(creds, domain, appId, bodyRead);
	if ("success" in application) {
		const hqOwn = application.edgeRefusal !== true;
		const asksMembership =
			application.status === 403 ||
			(application.status === 401 &&
				apiRefusalSentence(application) === "plan");
		if (asksMembership && hqOwn) {
			const listed = await listHqApps(creds, domain, { cancel });
			if (!("success" in listed))
				return failed(application, "application", true);
			if (listed.status === 403 && listed.edgeRefusal !== true)
				return failed(application, "application", false);
			return failed(listed, "app-list");
		}
		if (application.status === 404 && hqOwn) {
			const listed = await listHqApps(creds, domain, { cancel });
			if ("success" in listed) return failed(listed, "app-list");
			if (listed.some((listing) => listing.appId === appId))
				return { kind: "remote" };
			/* No working app of this project space: ask only whether HQ holds
			 * it as deleted. Every other answer adds nothing to what the
			 * resource and the list said (an app of another project space
			 * makes the source read raise). */
			const source = await readHqAppSource(creds, domain, appId, {
				...bodyRead,
				admit: "any",
			});
			if (!("success" in source)) {
				/* A deleted build is no app of the project space either: only a
				 * document that cannot be a build is a deleted app to restore. */
				if (source.kind === "gone" && source.deleted && !source.mayBeBuild)
					return { kind: "deleted" };
				/* It came back between two reads. */
				if (source.kind === "source") return { kind: "changed" };
			}
			return { kind: "gone" };
		}
		return failed(application, "application");
	}
	if (application.builtFromAppId !== null) return { kind: "gone" };
	const summaries = hqApplicationModules(application);
	if ("malformedAt" in summaries)
		return failed(HQ_MALFORMED_ANSWER, "application");

	/* 2. The source. The resource answering proved membership. */
	const read = await readHqAppSource(creds, domain, appId, {
		...bodyRead,
		admit: "any",
	});
	if ("success" in read) return failed(read, "app-source", true);
	if (read.kind === "unsupported")
		return read.docType === "LinkedApplication"
			? { kind: "linked" }
			: failed(HQ_MALFORMED_ANSWER, "app-source");
	if (read.kind === "gone") return { kind: read.deleted ? "deleted" : "gone" };
	const { source } = read;
	if (source.name === null || source.multimediaMap === null)
		return failed(HQ_MALFORMED_ANSWER, "app-source");

	/* 3. The save counter, compared for equality only: one save can raise it
	 * by more than one. */
	const versions = await readAppVersions(creds, domain, appId, { cancel });
	if ("success" in versions) return failed(versions, "app-version");
	if (versions.currentVersion !== application.version)
		return { kind: "changed" };

	/* 4. The alignment. */
	const alignment = alignHqForms(source, summaries);
	if (alignment.kind === "misaligned") {
		log.error("[commcare] app reading misaligned", undefined, {
			domain,
			request: "application",
			appId,
			at: alignment.at,
		});
		return failed(HQ_MALFORMED_ANSWER, "application");
	}
	const unsummarized = notSummarizedMenus(alignment.modules);
	if (unsummarized.kind !== "none") {
		for (const [position, menu] of alignment.modules.entries()) {
			if (
				menu.kind === "not-summarized" &&
				SUMMARIZED_MENU_DOC_TYPES.has(menu.docType)
			)
				/* HQ's text quotes the app, so the line holds its shape alone. */
				log.error("[commcare] application module not summarized", undefined, {
					domain,
					request: "application",
					appId,
					position,
					docType: menu.docType,
					opens: menu.shape.opens,
					length: menu.shape.length,
				});
		}
	}
	return {
		kind: "read",
		version: application.version,
		application,
		source,
		modules: alignment.modules,
	};
}
