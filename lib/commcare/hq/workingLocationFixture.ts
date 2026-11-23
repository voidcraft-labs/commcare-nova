import "server-only";
import type { Element } from "domhandler";
import {
	elementChildren,
	elementNamespace,
	XFORMS_NS,
	XHTML_NS,
} from "../xmlNamespaces";
import { tryParseXml } from "../xmlParse";
import { type HqAppSource, readHqAppSource } from "./appSource";
import { HQ_BUILD_RESOURCE_MAX_BYTES } from "./bounds";
import { withHqRequestDeadline } from "./deadline";
import {
	baseUrl,
	type CommCareCredentials,
	isValidDomainSlug,
	sendHq,
} from "./http";
import { MemoryMeterFullError } from "./memoryMeter";
import { isHqObject } from "./readCollection";

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

/** locations' factory reads a legacy project setting unavailable through an
 * API key. Observe the actual working resource on the source project. HQ
 * resolves target=save to the working app. Request only a form or suite:
 * download_odk_profile would autogenerate a build. The second source read
 * verifies the form attachment or the lack of any custom suite declarations
 * that could otherwise impersonate the generated instance. */
export async function readWorkingLocationFixture(input: {
	creds: CommCareCredentials;
	domain: string;
	remoteAppId: string;
	source: HqAppSource;
	sameSuiteSource: (after: HqAppSource) => boolean;
	witness?: WorkingLocationWitness;
	cancel?: AbortSignal;
}): Promise<"flat" | "hierarchical" | undefined> {
	const { creds, domain, remoteAppId, source, witness, cancel } = input;
	if (!isValidDomainSlug(domain) || !/^[\w-]+$/.test(remoteAppId)) return;
	if (!witness && customLocations(source)) return;
	const original = witness && source.modules[witness.menu]?.forms[witness.form];
	if (witness && (!original?.attachment || original.xmlns !== witness.xmlns))
		return;
	const resource = witness
		? `modules-${witness.menu}/forms-${witness.form}.xml`
		: "suite.xml";
	const query = new URLSearchParams({ latest: "true", target: "save" });
	if (witness?.profile) query.set("profile", witness.profile);
	const url = `${baseUrl(creds)}/a/${domain}/apps/download/${remoteAppId}/${resource}?${query}`;
	const observed = await withHqRequestDeadline(
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
			return locationSource(new TextDecoder().decode(body.bytes), witness);
		},
		undefined,
		cancel,
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
