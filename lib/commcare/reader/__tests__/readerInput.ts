/**
 * A reader's input over an app as CommCare HQ serves it: the source read
 * through Nova's own reader of HQ's source view from a retained answer of
 * HQ's, or from a body a test changed, with the menus aligned by position.
 * The stages these tests run read the source and nothing of the lookup
 * tables, the expression judge or the app strings, which answer nothing.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	type RetainedHqAnswer,
	replyRetained,
	retainedBodyJson,
	retainedGroupRead,
} from "@/__tests__/helpers/retainedHqReads";
import type { HqAlignedModule } from "../../hq/appReading";
import { type HqAppSource, readHqAppSource } from "../../hq/appSource";
import type { HqLocationType } from "../../hq/locations";
import { inventoryIndex } from "../../surface/inventory";
import { applicationReading } from "../appShell";
import { createReadContext, type ReadContext } from "../context";
import { mintingResolver } from "../identity";
import type { ReaderInput, ReaderMediaResolution } from "../types";

const CREDS = { username: "account", apiKey: "key", server: "india" } as const;
const HOST = "https://india.commcarehq.org";
const DOMAIN = "clinic";
const APP_ID = "0123456789abcdef0123456789abcdef";

/** A retained answer's body, as JSON, for a test to change. */
export function retainedSourceBody(file: string): Record<string, unknown> {
	return retainedBodyJson(retainedGroupRead(file));
}

/** The retained reads of Nova's navigation export after each of HQ's own pages saved it, by
 *  the name `retainedSourceBody` takes. */
export function retainedSaveReads(): string[] {
	return readdirSync(join(process.cwd(), "proof/hq-reads/navigation-base"))
		.filter(
			(name) => name.startsWith("app-source-after-") && name.endsWith(".json"),
		)
		.map((name) => `navigation-base/${name.slice(0, -".json".length)}`)
		.sort();
}

/** The source Nova's reader gives for `body`, served as HQ's source view answers. */
export async function sourceFromBody(
	body: Readonly<Record<string, unknown>>,
): Promise<HqAppSource> {
	const answer: RetainedHqAnswer = {
		status: 200,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	};
	return withHttpPeer(async (peer) => {
		replyRetained(
			peer.get(HOST).intercept({
				path: `/a/${DOMAIN}/apps/source/${APP_ID}/`,
				method: "GET",
			}),
			answer,
		);
		const read = await readHqAppSource(CREDS, DOMAIN, APP_ID, { admit: "any" });
		if (!("kind" in read) || read.kind !== "source")
			throw new Error(`HQ's source did not read: ${JSON.stringify(read)}`);
		return read.source;
	});
}

/** The menus aligned by position, each form under its own read id. */
function aligned(source: HqAppSource): HqAlignedModule[] {
	return source.modules.map((menu) => ({
		kind: "aligned",
		uniqueId: menu.uniqueId,
		docType: menu.docType,
		forms: menu.forms.map((form) => ({
			uniqueId: form.readUniqueId,
			xmlns: form.xmlns,
			source: form,
			questions: [],
		})),
	}));
}

export interface InputOptions {
	readonly levels?: readonly HqLocationType[];
	readonly media?: (path: string) => ReaderMediaResolution;
}

export function readerInput(
	source: HqAppSource,
	options: InputOptions = {},
): ReaderInput {
	return {
		appId: "app-1",
		target: { origin: HOST, domain: DOMAIN },
		source,
		modules: aligned(source),
		resolver: mintingResolver("app-1"),
		lookup: { table: () => undefined, definitions: new Map() },
		organization: {
			levelCodes: (options.levels ?? []).map((level) => level.code),
			levels: options.levels ?? [],
		},
		media: { resolve: options.media ?? (() => ({ kind: "no-entry" })) },
		appStrings: () => null,
		recordDialect: (() => {
			throw new Error("These stages never ask the record dialect.");
		}) as unknown as ReaderInput["recordDialect"],
	};
}

/** A context over `input` that keeps every claim, as the reading's stages share it. */
export function readContext(input: ReaderInput): ReadContext {
	return createReadContext(input, { claims: "full" }, inventoryIndex());
}

/**
 * Reads what the stages after the structure stage read of what the first two
 * admitted (the app's name, which the assembly writes, and each form's
 * source, which the forms stage parses), then closes the reading.
 */
export function closeAfterStructure(
	ctx: ReadContext,
): ReturnType<ReadContext["close"]> {
	const name = ctx.draft.appName;
	if (name !== undefined) expect(name.value).toBeTypeOf("string");
	const attachments = applicationReading(ctx)?.attachments;
	if (attachments !== undefined) expect(attachments.value).toBeTypeOf("object");
	return ctx.close();
}

/** Each claim record at `where` in `app.json`, by its entry. */
export function entriesAt(
	closed: ReturnType<ReadContext["close"]>,
	where: string,
): string[] {
	return [...closed.claims.records()]
		.filter(
			(record) => record.artifact === "app.json" && record.where === where,
		)
		.map((record) => record.entry);
}
