/**
 * The small controlled app the create's tests bring in, and the bring-in
 * itself through the production functions: one survey menu whose one form
 * takes its choices from CommCare HQ's lookup table `district`, read from the
 * proof lane's retained answers (`proof/hq-reads/targeted-hq-side-lookup/`).
 *
 * CommCare HQ answers through a controlled peer. The application resource is
 * the retained `reading/application` answer with its module summarized from
 * that source as `ApplicationResource.dehydrate_module` summarizes one
 * (`corehq/apps/api/resources/v0_4.py`, calling `XForm.get_questions` with
 * translations and fixtures, `corehq/apps/app_manager/xform.py`).
 *
 * The person's stored CommCare HQ key is decrypted at the KMS boundary
 * (`lib/commcare/encryption.ts::decrypt`), which the caller controls; this
 * module writes the person's stored connection where they hold none.
 */

import type { MockAgent } from "undici";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	type RetainedHqAnswer,
	retainedBodyJson,
	retainedBodyText,
	retainedGroupRead,
	retainedReadingRead,
} from "@/__tests__/helpers/retainedHqReads";
import type { AdoptedAppReceipt } from "@/lib/db/appGenesis";
import { getAppDb } from "@/lib/db/pg";
import { createFromReview } from "../create";
import { authorizeBringIn, readHqAppForReview } from "../read";
import type {
	BringInInput,
	ReadingAnswer,
	ReadingKey,
	ReadingReview,
} from "../types";

export const FIXTURE_SERVER = "india";
export const FIXTURE_HOST = "https://india.commcarehq.org";
export const FIXTURE_DOMAIN = "clinic";
/** The HQ app's id: the retained application resource's own. */
export const FIXTURE_REMOTE_APP_ID = retainedBodyJson(
	retainedReadingRead("application"),
).id as string;
/** CommCare HQ's id of the table `district`, as its retained list names it. */
export const FIXTURE_TABLE_ID = "8bad86ee12874fe9bf7e5f194597f4fc";

export const FIXTURE_PATHS = {
	application: `/a/${FIXTURE_DOMAIN}/api/application/v1/${FIXTURE_REMOTE_APP_ID}/`,
	source: `/a/${FIXTURE_DOMAIN}/apps/source/${FIXTURE_REMOTE_APP_ID}/`,
	version: `/a/${FIXTURE_DOMAIN}/apps/view/${FIXTURE_REMOTE_APP_ID}/current_version/`,
	tables: `/a/${FIXTURE_DOMAIN}/api/lookup_table/v1/?limit=100`,
	rows: `/a/${FIXTURE_DOMAIN}/api/fixture/v1/?fixture_type_id=${FIXTURE_TABLE_ID}`,
	media: (multimediaId: string) =>
		`/hq/multimedia/file/CommCareImage/${multimediaId}/`,
} as const;

export function fixtureKey(projectId: string): ReadingKey {
	return {
		projectId,
		server: FIXTURE_SERVER,
		domain: FIXTURE_DOMAIN,
		remoteAppId: FIXTURE_REMOTE_APP_ID,
	};
}

type Body = Record<string, unknown>;

/** A retained answer whose JSON body `change` rewrote. */
export function changedAnswer(
	answer: RetainedHqAnswer,
	change: (body: Body) => Body,
): RetainedHqAnswer {
	return {
		...answer,
		body: JSON.stringify(change(structuredClone(retainedBodyJson(answer)))),
	};
}

/** The source CommCare HQ holds: one survey menu, one form reading `district`. */
export function fixtureSource(): RetainedHqAnswer {
	return retainedGroupRead("targeted-hq-side-lookup/app-source");
}

/** The source with its form's XML rewritten by `change`. */
export function fixtureSourceWithXml(
	change: (xml: string) => string,
	answer: RetainedHqAnswer = fixtureSource(),
): RetainedHqAnswer {
	return changedAnswer(answer, (body) => {
		const attachments = body._attachments as Record<string, string>;
		for (const name of Object.keys(attachments))
			attachments[name] = change(attachments[name] as string);
		return body;
	});
}

/** One question as `XForm.get_questions` summarizes it with translations and fixtures. */
function question(input: {
	readonly id: string;
	readonly label: string;
	readonly tag: string;
	readonly type: string;
	readonly select?: true;
}): Body {
	return {
		comment: null,
		constraint: null,
		group: null,
		hashtagValue: `#form/${input.id}`,
		is_group: false,
		label: input.label,
		label_ref: `${input.id}-label`,
		relevant: null,
		repeat: null,
		required: false,
		setvalue: null,
		tag: input.tag,
		translations: { en: input.label },
		type: input.type,
		value: `/data/${input.id}`,
		...(input.select === true && {
			data_source: {
				nodeset: `instance('${input.id}')/${input.id}_list/${input.id}`,
				label_ref: "name",
				value_ref: "code",
				instance_id: input.id,
				instance_ref: `jr://fixture/item-list:${input.id}`,
			},
			options: [],
		}),
	};
}

/**
 * The application resource over `source`: the retained answer, its one
 * module summarized from the source's menu, `version` its save counter where
 * given, and `noteLabel` the second question's label where the source's was
 * changed.
 */
export function fixtureResource(
	source: RetainedHqAnswer = fixtureSource(),
	options: { readonly version?: number; readonly noteLabel?: string } = {},
): RetainedHqAnswer {
	const { version } = options;
	const held = retainedBodyJson(source);
	const [menu] = held.modules as Body[];
	const [form] = (menu?.forms ?? []) as Body[];
	if (menu === undefined || form === undefined)
		throw new Error("The fixture's source holds no form.");
	return changedAnswer(retainedReadingRead("application"), (body) => ({
		...body,
		...(version !== undefined && { version }),
		name: held.name,
		modules: [
			{
				case_properties: [],
				case_type: menu.case_type,
				forms: [
					{
						name: form.name,
						questions: [
							question({
								id: "district",
								label: "District",
								tag: "select1",
								type: "Select",
								select: true,
							}),
							question({
								id: "note",
								label: options.noteLabel ?? "Note",
								tag: "input",
								type: "Text",
							}),
						],
						unique_id: form.unique_id,
						xmlns: form.xmlns,
					},
				],
				name: menu.name,
				unique_id: menu.unique_id,
			},
		],
	}));
}

/** The counter answer of an application resource's own version. */
export function counterOf(resource: RetainedHqAnswer): RetainedHqAnswer {
	const version = retainedBodyJson(resource).version as number;
	return {
		status: 200,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			currentVersion: version,
			latestBuild: version,
			latestReleasedBuild: null,
		}),
	};
}

/** Answer one GET at `path` with `answer`, `times` times. */
export function serveAnswer(
	peer: MockAgent,
	path: string,
	answer: RetainedHqAnswer,
	times = 1,
): void {
	peer
		.get(FIXTURE_HOST)
		.intercept({ path, method: "GET" })
		.reply(answer.status, retainedBodyText(answer), {
			headers: { ...answer.headers },
		})
		.times(times);
}

/**
 * `navigation-base` as CommCare HQ holds it and summarizes it: a case-managing
 * app that reads no lookup table, for a test that needs the case changes its
 * menu holds or an app with no Project data.
 */
export function navigationSource(): RetainedHqAnswer {
	return retainedGroupRead("navigation-base/app-source");
}

/** A source whose first menu shows each image of `icons` (menu, then first form), each by its
 *  own map entry. */
export function withIcons(
	answer: RetainedHqAnswer,
	icons: readonly string[],
): RetainedHqAnswer {
	return changedAnswer(answer, (body) => {
		const [menu] = body.modules as Body[];
		const [form] = (menu?.forms ?? []) as Body[];
		const map: Body = {};
		icons.forEach((multimediaId, index) => {
			const path = `jr://file/commcare/image/${multimediaId}.png`;
			const holder = index === 0 ? menu : form;
			if (holder === undefined)
				throw new Error("The fixture's source has no slot for this icon.");
			holder.media_image = { en: path };
			map[path] = {
				doc_type: "HQMediaMapItem",
				media_type: "CommCareImage",
				multimedia_id: multimediaId,
				unique_id: `${multimediaId}-map`,
				version: 1,
			};
		});
		body.multimedia_map = map;
		return body;
	});
}

/**
 * Everything one read of the fixture app asks CommCare HQ: the resource, the
 * source, the counter, the table list, and for `district` its rows. The
 * `navigation` app is `navigation-base` under the retained resource.
 */
export function serveFixtureApp(
	peer: MockAgent,
	options: {
		readonly app?: "district" | "navigation";
		readonly source?: RetainedHqAnswer;
		readonly resource?: RetainedHqAnswer;
		readonly rows?: RetainedHqAnswer;
		/** How many reads to answer. */
		readonly times?: number;
	} = {},
): void {
	const navigation = options.app === "navigation";
	const source =
		options.source ?? (navigation ? navigationSource() : fixtureSource());
	const resource =
		options.resource ??
		(navigation ? retainedReadingRead("application") : fixtureResource(source));
	const times = options.times ?? 1;
	serveAnswer(peer, FIXTURE_PATHS.application, resource, times);
	serveAnswer(peer, FIXTURE_PATHS.source, source, times);
	serveAnswer(peer, FIXTURE_PATHS.version, counterOf(resource), times);
	if (navigation) {
		serveAnswer(
			peer,
			FIXTURE_PATHS.tables,
			retainedGroupRead("lookups/lookup-tables"),
			times,
		);
		return;
	}
	serveFixtureTables(peer, times, options.rows);
}

/** CommCare HQ's table list and the rows of `district`, `times` times. */
export function serveFixtureTables(
	peer: MockAgent,
	times = 1,
	rows: RetainedHqAnswer = retainedGroupRead(
		"targeted-hq-side-lookup/fixture-rows-district",
	),
): void {
	serveAnswer(
		peer,
		FIXTURE_PATHS.tables,
		retainedGroupRead("targeted-hq-side-lookup/lookup-tables"),
		times,
	);
	serveAnswer(peer, FIXTURE_PATHS.rows, rows, times);
}

/** The person's stored CommCare HQ connection, reaching the fixture's project space. */
export async function seedFixtureConnection(
	actorUserId: string,
): Promise<void> {
	const db = await getAppDb();
	await db
		.insertInto("user_settings")
		.values({
			user_id: actorUserId,
			commcare_username: "account",
			commcare_api_key: "ciphertext",
			commcare_server: FIXTURE_SERVER,
			approved_domains: JSON.stringify([
				{ name: FIXTURE_DOMAIN, displayName: "Clinic" },
			]),
			updated_at: new Date(),
		})
		.onConflict((conflict) => conflict.column("user_id").doNothing())
		.execute();
}

/** The create's body answering `review` as offered: the preselected declaration, HQ's name. */
export function createInputFor(
	key: ReadingKey,
	answer: Extract<ReadingAnswer, { kind: "review" }>,
	overrides: Partial<BringInInput> = {},
): BringInInput {
	const preselected = answer.review.runsOn.find((choice) => choice.preselected);
	if (preselected === undefined)
		throw new Error("The review preselects no declaration.");
	return {
		...key,
		readingId: answer.readingId,
		reviewDigest: answer.reviewDigest,
		appName: answer.review.appName,
		runsOnlyOn: preselected.runsOnlyOn,
		splitDatetime: preselected.splitDatetime,
		tableChoices: {},
		...overrides,
	};
}

/** The review a read answered, or the read's answer named in the error. */
export function reviewOf(
	answer: ReadingAnswer,
): Extract<ReadingAnswer, { kind: "review" }> & { review: ReadingReview } {
	if (answer.kind !== "review")
		throw new Error(
			`The fixture app read to ${answer.kind}: ${JSON.stringify(answer)}`,
		);
	return answer;
}

/**
 * Bring the fixture app in for `actorUserId` into `projectId`: one read to a
 * review, then the create answering it as offered, both through the
 * production functions with CommCare HQ answered by the controlled peer. The
 * person must already be a member of the Project with `edit`.
 */
export async function adoptFixtureApp(input: {
	projectId: string;
	actorUserId: string;
}): Promise<{ appId: string; receipt: AdoptedAppReceipt }> {
	await seedFixtureConnection(input.actorUserId);
	const actor = await authorizeBringIn(input.actorUserId, input.projectId);
	if (actor === null)
		throw new Error(
			"The fixture app is brought in by a member who may edit the Project, and this person may not.",
		);
	const key = fixtureKey(input.projectId);
	return withHttpPeer(async (peer) => {
		serveFixtureApp(peer, { times: 2 });
		const review = reviewOf(
			await readHqAppForReview(actor, key, { onEvent: () => {} }),
		);
		const answer = await createFromReview(actor, createInputFor(key, review), {
			onEvent: () => {},
		});
		if (answer.kind !== "created")
			throw new Error(
				`The fixture app's create answered ${answer.kind}: ${JSON.stringify(answer)}`,
			);
		return { appId: answer.receipt.appId, receipt: answer.receipt };
	});
}
