/**
 * Media on a text, read through the reader's own stages over an index
 * that answers `asset`, `no-entry` and `unreadable`. A held slot (a label, a
 * choice) takes the asset where every language holds the one file (one path,
 * or paths the index answers one asset for, each listed), and a path
 * with no file is handed off with its node and listed, never claimed and never
 * `unrecognized`; a language whose text holds no media form shows the form's
 * default language's (Core loads the default locale's keys under every
 * locale), so a path the default holds alone is held, and a file that differs
 * by language, or one only another language holds, is refused. A hint's or a
 * group label's media, which no slot holds, is inert where the file is there
 * and handed off as `unheld_itext` where it is not. Each question that
 * references one text reads its media as its own. A map of paths by language
 * reads as HQ's build shows it in each language: a language the map lacks or
 * holds blank shows another's path, so only two files shown differ.
 */

import { describe, expect, it } from "vitest";
import {
	readContext,
	readerInput,
	retainedSourceBody,
	sourceFromBody,
} from "../../__tests__/readerInput";
import { readApplication } from "../../appShell";
import type { ReaderMediaResolution } from "../../types";
import { readMediaMap } from "../media";
import {
	type FormReading,
	readFields,
	readForm,
	xformSource,
} from "./formReading";

const Q = (id: string) => `questions/${id}`;

/** An index that has no entry for a path ending `missing`, cannot read one holding `broken`, and
 *  answers every other path with an asset named after it. */
function index(path: string): ReaderMediaResolution {
	if (path.endsWith("missing.png")) return { kind: "no-entry" };
	if (path.includes("broken")) return { kind: "unreadable" };
	return {
		kind: "asset",
		assetId: `asset-${path.slice(path.lastIndexOf("/") + 1)}`,
		mediaKind: "image",
	};
}

/** `index`, with a French path that names the file of the path without `_fr`. */
function oneFile(path: string): ReaderMediaResolution {
	return index(path.replace("_fr.", "."));
}

function itext(translations: Readonly<Record<string, string>>): string {
	return `<itext>${Object.entries(translations)
		.map(
			([lang, texts], at) =>
				`<translation lang="${lang}"${at === 0 ? ' default=""' : ""}>${texts}</translation>`,
		)
		.join("")}</itext>`;
}

/** A form of one text question with a label and a hint, and a select with one choice. */
function source(translations: Readonly<Record<string, string>>): string {
	return xformSource({
		data: "<q/><s/><g><in/></g>",
		model: `<bind nodeset="/data/q" type="xsd:string"/><bind nodeset="/data/s" type="xsd:string"/>
			<bind nodeset="/data/g/in" type="xsd:string"/>${itext(translations)}`,
		body: `<input ref="/data/q"><label ref="jr:itext('q-label')"/><hint ref="jr:itext('q-hint')"/></input>
			<select1 ref="/data/s"><label ref="jr:itext('s-label')"/>
				<item><label ref="jr:itext('s-yes')"/><value>yes</value></item></select1>
			<group ref="/data/g"><label ref="jr:itext('g-label')"/>
				<input ref="/data/g/in"><label ref="jr:itext('in-label')"/></input></group>`,
	});
}

/** One language's texts, each slot's media path given or left out. */
function texts(paths: {
	readonly label?: string;
	readonly hint?: string;
	readonly choice?: string;
	readonly group?: string;
}): string {
	const media = (path: string | undefined) =>
		path === undefined ? "" : `<value form="image">${path}</value>`;
	return `<text id="q-label"><value>Q</value>${media(paths.label)}</text>
		<text id="q-hint"><value>H</value>${media(paths.hint)}</text>
		<text id="s-label"><value>S</value></text>
		<text id="s-yes"><value>Yes</value>${media(paths.choice)}</text>
		<text id="g-label"><value>G</value>${media(paths.group)}</text>
		<text id="in-label"><value>In</value></text>`;
}

function field(reading: FormReading, id: string): Record<string, unknown> {
	const found = readFields(reading.xform ?? ({} as never)).find(
		(one) => one.id === id,
	);
	if (found === undefined) throw new Error(`The reading holds no field ${id}.`);
	return found.field;
}

function codes(reading: FormReading): string[] {
	return reading.closed.findings
		.map((finding) => finding.code)
		.filter((code) => code !== "unrecognized");
}

function unclaimedMedia(reading: FormReading): string[] {
	return reading.closed.findings
		.filter((finding) => finding.code === "unrecognized")
		.map((finding) => finding.detail.name ?? "")
		.filter((name) => name.includes("itext"));
}

describe("media on a text", () => {
	it("puts the one path of every language in a held slot and lists it", async () => {
		const reading = await readForm(
			source({
				en: texts({
					label: "jr://file/commcare/q.png",
					choice: "jr://file/commcare/yes.png",
				}),
				fr: texts({
					label: "jr://file/commcare/q.png",
					choice: "jr://file/commcare/yes.png",
				}),
			}),
			{ langs: ["en", "fr"], media: index },
		);
		expect(field(reading, "q").label_media).toEqual({ image: "asset-q.png" });
		const options = (
			field(reading, "s").optionsSource as { options: { media?: unknown }[] }
		).options;
		expect(options[0]?.media).toEqual({ image: "asset-yes.png" });
		expect(
			reading.ctx.facts.mediaReferences.map((reference) => reference.slot),
		).toEqual(["field_media_bundle", "option_media"]);
		expect(codes(reading)).toEqual([]);
		expect(unclaimedMedia(reading)).toEqual([]);
	});

	// Core reads a media value's content whole, an `<output>` in it making the path, while the
	// path is read from its text; and the value Nova writes holds `form` alone. A value holding
	// more is no media Nova holds.
	it.each([
		[
			"an output inside its path",
			'<value form="image">jr://file/commcare/q<output value="/data/q"/>.png</value>',
		],
		[
			"an attribute Nova does not write",
			'<value form="image" note="kept">jr://file/commcare/q.png</value>',
		],
	])(
		"fills no slot from a media value holding %s, and reports it",
		async (_, value) => {
			const label = texts({ label: "jr://file/commcare/q.png" }).replace(
				'<value form="image">jr://file/commcare/q.png</value>',
				value,
			);
			const reading = await readForm(source({ en: label }), {
				langs: ["en"],
				media: index,
			});
			expect(field(reading, "q").label_media).toBeUndefined();
			expect(reading.closed.findings.map((finding) => finding.code)).toContain(
				"unrecognized",
			);
		},
	);

	it("hands a path with no file off, with a record of its node, and fills no slot", async () => {
		const reading = await readForm(
			source({
				en: texts({ label: "jr://file/commcare/missing.png" }),
				fr: texts({ label: "jr://file/commcare/missing.png" }),
			}),
			{ langs: ["en", "fr"], media: index },
		);
		expect(field(reading, "q").label_media).toBeUndefined();
		expect(reading.ctx.facts.pendingMedia).toEqual([
			expect.objectContaining({
				path: "jr://file/commcare/missing.png",
				resolution: "no-entry",
				slot: "field_media_bundle",
			}),
		]);
		expect(reading.closed.claims.handOffs).toHaveLength(2);
		expect(
			reading.closed.claims.handOffs.every(
				(record) => record.to === "media-reference",
			),
		).toBe(true);
		expect(codes(reading)).toEqual([]);
		expect(unclaimedMedia(reading)).toEqual([]);
	});

	it("puts the media of a text two questions reference in each question's slot, claimed once", async () => {
		const reading = await readForm(
			xformSource({
				data: "<a/><b/>",
				model: `<bind nodeset="/data/a" type="xsd:string"/><bind nodeset="/data/b" type="xsd:string"/>${itext(
					{
						en: `<text id="shared"><value>Same</value><value form="image">jr://file/commcare/s.png</value></text>`,
					},
				)}`,
				body: `<input ref="/data/a"><label ref="jr:itext('shared')"/></input>
					<input ref="/data/b"><label ref="jr:itext('shared')"/></input>`,
			}),
			{ media: index },
		);
		expect(field(reading, "a").label_media).toEqual({ image: "asset-s.png" });
		expect(field(reading, "b").label_media).toEqual({ image: "asset-s.png" });
		expect(
			reading.ctx.facts.mediaReferences.map((reference) => reference.place),
		).toEqual([
			expect.objectContaining({ path: "a" }),
			expect.objectContaining({ path: "b" }),
		]);
		expect(codes(reading)).toEqual([]);
		expect(unclaimedMedia(reading)).toEqual([]);
		expect(reading.closed.defects).toEqual([]);
	});

	it("holds two paths of one file, one per language, as that file, listed at both", async () => {
		const reading = await readForm(
			source({
				en: texts({ label: "jr://file/commcare/q.png" }),
				fr: texts({ label: "jr://file/commcare/q_fr.png" }),
			}),
			{ langs: ["en", "fr"], media: oneFile },
		);
		expect(codes(reading)).toEqual([]);
		expect(unclaimedMedia(reading)).toEqual([]);
		expect(field(reading, "q").label_media).toEqual({ image: "asset-q.png" });
		expect(
			reading.ctx.facts.mediaReferences.map((reference) => reference.path),
		).toEqual(["jr://file/commcare/q.png", "jr://file/commcare/q_fr.png"]);
	});

	it("holds a path the default language holds alone, which every language shows", async () => {
		const reading = await readForm(
			source({
				en: texts({ label: "jr://file/commcare/q.png" }),
				fr: texts({}),
			}),
			{ langs: ["en", "fr"], media: index },
		);
		expect(codes(reading)).toEqual([]);
		expect(unclaimedMedia(reading)).toEqual([]);
		expect(field(reading, "q").label_media).toEqual({ image: "asset-q.png" });
	});

	it("refuses a path that differs by language, and one only a language other than the default holds", async () => {
		const differing = await readForm(
			source({
				en: texts({ label: "jr://file/commcare/q.png" }),
				fr: texts({ label: "jr://file/commcare/q-fr.png" }),
			}),
			{ langs: ["en", "fr"], media: index },
		);
		expect(codes(differing)).toEqual([
			Q("label-or-option-media-differing-by-language"),
		]);
		const oneOnly = await readForm(
			source({
				en: texts({}),
				fr: texts({ label: "jr://file/commcare/q.png" }),
			}),
			{ langs: ["en", "fr"], media: index },
		);
		expect(codes(oneOnly)).toEqual([
			Q("label-or-option-media-differing-by-language"),
		]);
		expect(field(oneOnly, "q").label_media).toBeUndefined();
	});

	it("reads a help text blank in every language beside its media as no help text, its media held", async () => {
		const help = (value: string) =>
			`<text id="q-help"><value>${value}</value><value form="image">jr://file/commcare/help.png</value></text>`;
		const reading = await readForm(
			xformSource({
				data: "<q/>",
				model: `<bind nodeset="/data/q" type="xsd:string"/>${itext({
					en: `<text id="q-label"><value>Q</value></text>${help("")}`,
					fr: `<text id="q-label"><value>Q</value></text>${help(" ")}`,
				})}`,
				body: `<input ref="/data/q"><label ref="jr:itext('q-label')"/><help ref="jr:itext('q-help')"/></input>`,
			}),
			{ langs: ["en", "fr"], media: index },
		);
		const read = field(reading, "q");
		expect(read.help).toBeUndefined();
		expect(read.help_media).toEqual({ image: "asset-help.png" });
		expect(codes(reading)).toEqual([]);
		expect(unclaimedMedia(reading)).toEqual([]);
	});

	it("reads a hint's and a group label's media as inert where the file is there", async () => {
		const reading = await readForm(
			source({
				en: texts({
					hint: "jr://file/commcare/h.png",
					group: "jr://file/commcare/g.png",
				}),
			}),
			{ media: index },
		);
		expect(codes(reading)).toEqual([]);
		expect(unclaimedMedia(reading)).toEqual([]);
		expect(reading.ctx.facts.mediaReferences).toEqual([]);
		expect(reading.ctx.facts.pendingMedia).toEqual([]);
	});

	it("hands an unheld slot's path with no file off as unheld_itext", async () => {
		const reading = await readForm(
			source({
				en: texts({
					hint: "jr://file/commcare/missing.png",
					group: "jr://file/commcare/broken.png",
				}),
			}),
			{ media: index },
		);
		expect(
			reading.ctx.facts.pendingMedia.map((pending) => [
				pending.slot,
				pending.resolution,
			]),
		).toEqual([
			["unheld_itext", "no-entry"],
			["unheld_itext", "unreadable"],
		]);
		expect(reading.closed.claims.handOffs).toHaveLength(2);
		expect(codes(reading)).toEqual([]);
		expect(unclaimedMedia(reading)).toEqual([]);
	});

	it("lists a reference at the kind its slot plays, never the kind of the file its path names", async () => {
		// An audio form naming a file the index files as a video: project data holds the file's
		// class to the slot's kind, so the reference carries the slot's.
		const asVideo = (path: string): ReaderMediaResolution => ({
			kind: "asset",
			assetId: `asset-${path.slice(path.lastIndexOf("/") + 1)}`,
			mediaKind: "video",
		});
		const reading = await readForm(
			source({
				en: texts({}).replace(
					'<text id="q-label"><value>Q</value>',
					'<text id="q-label"><value>Q</value><value form="audio">jr://file/commcare/hen.mp4</value>',
				),
			}),
			{ media: asVideo },
		);
		expect(field(reading, "q").label_media).toEqual({ audio: "asset-hen.mp4" });
		expect(
			reading.ctx.facts.mediaReferences.map((reference) => [
				reference.path,
				reference.mediaKind,
			]),
		).toEqual([["jr://file/commcare/hen.mp4", "audio"]]);
	});
});

describe("a map of paths by language", () => {
	async function context(media: (path: string) => ReaderMediaResolution) {
		const body = {
			...retainedSourceBody("shell/app-source"),
			langs: ["en", "fr"],
		};
		const ctx = readContext(readerInput(await sourceFromBody(body), { media }));
		readApplication(ctx);
		return ctx;
	}
	const at = (ctx: Awaited<ReturnType<typeof context>>) => ({
		site: { json: ctx.app, key: "modules" },
		place: ctx.app.place,
		slot: "module_media",
		mediaKind: "image" as const,
	});

	it("answers none for an empty map, differs for two paths, and the asset for one", async () => {
		const ctx = await context(index);
		expect(readMediaMap(ctx, {}, at(ctx))).toEqual({ kind: "none" });
		expect(
			readMediaMap(
				ctx,
				{ en: "jr://file/a.png", fr: "jr://file/b.png" },
				at(ctx),
			),
		).toEqual({ kind: "differs" });
		expect(
			readMediaMap(
				ctx,
				{ en: "jr://file/a.png", fr: "jr://file/a.png" },
				at(ctx),
			),
		).toEqual({ kind: "asset", assetId: "asset-a.png" });
		// The reference names the value of the app's JSON it was read from, which places it.
		expect(ctx.facts.mediaReferences).toEqual([
			expect.objectContaining({
				path: "jr://file/a.png",
				pointer: "/modules",
				slot: "module_media",
			}),
		]);
	});

	it("answers the asset for two paths of one file, listing both", async () => {
		const ctx = await context(oneFile);
		expect(
			readMediaMap(
				ctx,
				{ en: "jr://file/a.png", fr: "jr://file/a_fr.png" },
				at(ctx),
			),
		).toEqual({ kind: "asset", assetId: "asset-a.png" });
		expect(ctx.facts.mediaReferences.map((one) => one.path)).toEqual([
			"jr://file/a.png",
			"jr://file/a_fr.png",
		]);
	});

	it("reads a path one app language holds, and another lacks or holds blank, as the asset both show", async () => {
		const ctx = await context(index);
		for (const map of [
			{ en: "jr://file/a.png" },
			{ fr: "jr://file/a.png" },
			{ en: "jr://file/a.png", fr: "" },
			// No app language holds it: HQ's build takes the map's least key.
			{ de: "jr://file/a.png" },
		])
			expect(readMediaMap(ctx, map, at(ctx))).toEqual({
				kind: "asset",
				assetId: "asset-a.png",
			});
	});

	it("lists a map's reference at the kind its slot plays, whatever the file is", async () => {
		const ctx = await context(index);
		expect(
			readMediaMap(
				ctx,
				{ en: "jr://file/a.png", fr: "jr://file/a.png" },
				{ ...at(ctx), mediaKind: "audio" },
			),
		).toEqual({ kind: "asset", assetId: "asset-a.png" });
		expect(ctx.facts.mediaReferences.map((one) => one.mediaKind)).toEqual([
			"audio",
		]);
	});

	it("answers differs for a value whose printed text it cannot know", async () => {
		const ctx = await context(index);
		expect(readMediaMap(ctx, { en: 5 }, at(ctx))).toEqual({ kind: "differs" });
		expect(ctx.facts.mediaReferences).toEqual([]);
	});

	it("hands a path with no file off, with a record, and lists it", async () => {
		const ctx = await context(index);
		expect(
			readMediaMap(
				ctx,
				{ en: "jr://file/missing.png", fr: "jr://file/missing.png" },
				at(ctx),
			),
		).toEqual({ kind: "handed-off" });
		expect(ctx.facts.pendingMedia).toEqual([
			expect.objectContaining({
				resolution: "no-entry",
				pointer: "/modules",
				slot: "module_media",
			}),
		]);
		expect(ctx.close().claims.handOffs).toEqual([
			expect.objectContaining({
				to: "media-reference",
				subject: "jr://file/missing.png",
			}),
		]);
	});
});
