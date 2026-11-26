import "server-only";
import type { Element } from "domhandler";
import {
	elementChildren,
	elementNamespace,
	XFORMS_NS,
	XHTML_NS,
} from "../xmlNamespaces";
import { tryParseXml } from "../xmlParse";
import type { HqAppReading } from "./appReading";
import { type HqAppSource, readHqAppSource } from "./appSource";
import { HQ_BUILD_RESOURCE_MAX_BYTES } from "./bounds";
import { hqDeadlineReached, withHqRequestDeadline } from "./deadline";
import {
	type CommCareCredentials,
	hqDomainPath,
	isValidDomainSlug,
	sendHq,
} from "./http";
import { MemoryMeterFullError } from "./memoryMeter";
import { isHqObject } from "./readCollection";
import {
	readSuiteDetailSources,
	type SuiteDetailReads,
	type SuiteDetailSources,
} from "./suiteDetailSources";

export interface WorkingLocationWitness {
	readonly menu: number;
	readonly form: number;
	readonly xmlns: string;
	readonly profile?: string;
}

function customLocations(source: HqAppSource): boolean {
	if (source.raw.use_custom_suite || !Array.isArray(source.raw.modules))
		return true;
	return source.raw.modules.some(
		(menu) =>
			isHqObject(menu) &&
			Array.isArray(menu.forms) &&
			menu.forms.some(
				(form: unknown) =>
					isHqObject(form) &&
					Array.isArray(form.custom_instances) &&
					form.custom_instances.some(
						(item: unknown) =>
							isHqObject(item) && item.instance_id === "locations",
					),
			),
	);
}

/** A model instance in the received working form, or an ordinary generated
 * suite entry. Never inspect submitted data, nested elements or extension XML. */
function locationSource(
	xml: string,
	witness: WorkingLocationWitness | undefined,
): "flat" | "hierarchical" | undefined {
	const parsed = tryParseXml(xml);
	if ("issue" in parsed) return;
	type Node = ReturnType<typeof elementChildren>[number];
	const roots = elementChildren(parsed.doc.children, new Map());
	if (roots.length !== 1) return;
	const [root] = roots;
	const named = (node: Node, name: string, ns: string | null) =>
		node.element.name.split(":").at(-1) === name &&
		elementNamespace(node.element, node.scope) === ns;
	const kids = (node: Node, name: string, ns: string | null) =>
		elementChildren(node.element.children, node.scope).filter((child) =>
			named(child, name, ns),
		);
	let declarations: Element[];
	if (witness) {
		if (!named(root, "html", XHTML_NS)) return;
		const heads = kids(root, "head", XHTML_NS);
		const models = heads.flatMap((head) => kids(head, "model", XFORMS_NS));
		if (heads.length !== 1 || models.length !== 1) return;
		const instances = kids(models[0], "instance", XFORMS_NS);
		if (!instances[0]) return;
		const data = elementChildren(
			instances[0].element.children,
			instances[0].scope,
		);
		if (
			data.length !== 1 ||
			elementNamespace(data[0].element, data[0].scope) !== witness.xmlns
		)
			return;
		declarations = instances.slice(1).map((node) => node.element);
	} else {
		if (!named(root, "suite", null)) return;
		declarations = elementChildren(root.element.children, root.scope)
			.filter((node) =>
				["entry", "remote-request", "menu"].some((tag) =>
					named(node, tag, null),
				),
			)
			.flatMap((entry) => kids(entry, "instance", null))
			.map((node) => node.element);
	}
	const found = declarations.filter((node) => node.attribs.id === "locations");
	if (found.length === 0 || (witness && found.length !== 1)) return;
	const sources = new Set(found.map((node) => node.attribs.src));
	if (sources.size !== 1) return;
	if (sources.has("jr://fixture/locations")) return "flat";
	if (sources.has("jr://fixture/commtrack:locations")) return "hierarchical";
}

/** The source and authenticated, project-specific application answer from the
 * same bracketed read. The source export alone also describes a saved build. */
export type WorkingSource = Pick<
	Extract<HqAppReading, { kind: "read" }>,
	"application" | "seen" | "source"
>;

interface WorkingRead {
	creds: CommCareCredentials;
	domain: string;
	working: WorkingSource;
	cancel?: AbortSignal;
	sameSuiteSource: (after: HqAppSource) => boolean;
}

async function readWorkingResource<T>(
	input: WorkingRead,
	resource: string,
	profile: string | undefined,
	read: (xml: string) => T | undefined,
): Promise<T | undefined> {
	const { creds, domain, working, cancel } = input;
	const { application, seen } = working;
	const remoteAppId = application.appId;
	if (
		application.builtFromAppId !== null ||
		application.domain !== domain ||
		seen.domain !== domain ||
		seen.server !== creds.server ||
		!seen.remoteAppIds.includes(remoteAppId)
	)
		return;
	if (!isValidDomainSlug(domain) || !/^[\w-]+$/.test(remoteAppId)) return;
	const query = profile ? `?${new URLSearchParams({ profile: profile })}` : "";
	const url = `${hqDomainPath(domain)}/apps/download/${remoteAppId}/${resource}${query}`;
	return withHqRequestDeadline(
		async (signal) => {
			let response: Awaited<ReturnType<typeof sendHq>>;
			try {
				response = await sendHq(creds, url, {
					accept: "application/xml",
					noStore: true,
					signal,
				});
			} catch (error) {
				if (error instanceof MemoryMeterFullError) throw error;
				cancel?.throwIfAborted();
				return undefined;
			}
			if (!response.ok) {
				await response.discard();
				return undefined;
			}
			const body = await response.read(HQ_BUILD_RESOURCE_MAX_BYTES, "text");
			if (body.kind !== "read") return undefined;
			return read(new TextDecoder().decode(body.bytes));
		},
		undefined,
		cancel,
	);
}

export async function readWorkingSuiteDetails(
	input: WorkingRead,
	reads: SuiteDetailReads,
): Promise<SuiteDetailSources | undefined> {
	if (input.working.source.raw.use_custom_suite || !reads.size) return;
	// All profiles answer one question. Their count does not extend its deadline.
	return withHqRequestDeadline(
		async (signal) => {
			try {
				return await readWorkingSuiteProfiles(
					{ ...input, cancel: signal },
					reads,
				);
			} catch (error) {
				if (hqDeadlineReached(signal) && !input.cancel?.aborted) return;
				throw error;
			}
		},
		undefined,
		input.cancel,
	);
}

async function readWorkingSuiteProfiles(
	input: WorkingRead,
	reads: SuiteDetailReads,
): Promise<SuiteDetailSources | undefined> {
	const { source, application } = input.working;
	const merged = new Map<string, Map<string, string | null> | null>();
	for (const profile of [
		undefined,
		...source.buildProfiles.map((profile) => profile.id),
	]) {
		const scopes = await readWorkingResource(
			input,
			"suite.xml",
			profile,
			(xml) => readSuiteDetailSources(xml, reads, input.cancel),
		);
		if (!scopes) return;
		for (const [id, scope] of scopes) {
			const before = merged.get(id);
			if (before && scope) {
				for (const [name, src] of before)
					if (scope.get(name) !== src) before.set(name, null);
			} else if (scope) merged.set(id, new Map(scope));
			else if (!before) merged.set(id, null);
		}
	}
	const after = await readHqAppSource(
		input.creds,
		input.domain,
		application.appId,
		{ admit: "any", cancel: input.cancel },
	);
	if (
		"kind" in after &&
		after.kind === "source" &&
		source.lastModified === after.source.lastModified &&
		input.sameSuiteSource(after.source)
	)
		return merged;
}

/** locations' factory reads a legacy project setting unavailable through an
 * API key. Observe the actual working resource on the source project. HQ
 * serves the authenticated working id directly; requesting "latest" instead
 * requires a worker's login on projects with location-specific releases.
 * Request only a form or suite:
 * download_odk_profile would autogenerate a build. The second source read
 * verifies the form attachment or the lack of any custom suite declarations
 * that could otherwise impersonate the generated instance. */
export async function readWorkingLocationFixture(
	input: WorkingRead & { witness?: WorkingLocationWitness },
): Promise<"flat" | "hierarchical" | undefined> {
	const { creds, domain, witness, cancel } = input;
	const {
		source,
		application: { appId: remoteAppId },
	} = input.working;
	if (!witness && customLocations(source)) return;
	const original = witness && source.modules[witness.menu]?.forms[witness.form];
	if (witness && (!original?.attachment || original.xmlns !== witness.xmlns))
		return;
	const resource = witness
		? `modules-${witness.menu}/forms-${witness.form}.xml`
		: "suite.xml";
	const observed = await readWorkingResource(
		input,
		resource,
		witness?.profile,
		(xml) => locationSource(xml, witness),
	);
	if (!observed) return;
	const after = await readHqAppSource(creds, domain, remoteAppId, {
		admit: "any",
		cancel,
	});
	if (!("kind" in after) || after.kind !== "source") return;
	if (source.lastModified !== after.source.lastModified) return;
	if (!witness) {
		return !customLocations(after.source) && input.sameSuiteSource(after.source)
			? observed
			: undefined;
	}
	const candidate = after.source.modules[witness.menu]?.forms[witness.form];
	return candidate?.xmlns === witness.xmlns &&
		candidate.attachment === original?.attachment
		? observed
		: undefined;
}
