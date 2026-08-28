/* Main-realm projections for the isolated XPath worker protocol. This module
 * must stay independent of workerRuntime/asyncEvaluator so preparing a request
 * never downloads the evaluator or the OpenJDK Pattern compatibility engine
 * into the Builder's JavaScript realm. */
import { parser } from "@/lib/commcare/xpath/parser";
import {
	isXPathNodeSet,
	unpackXPathRuntimeValue,
	type XPathInstance,
	type XPathNode,
	type XPathRuntimeValue,
} from "./runtimeValues";
import { isXPathDate, XPathDate, type XPathValue } from "./types";
import type {
	SerializedXPathValue,
	XPathWorkerHashtagValue,
	XPathWorkerInstanceSnapshot,
	XPathWorkerNodeSnapshot,
} from "./workerProtocol";

/** Parsed hashtag tokens used to snapshot only the values one request can
 * observe. This deliberately does not regex-scan authored text. */
export function xpathWorkerHashtagReferences(
	source: string,
): readonly string[] {
	const found = new Set<string>();
	parser.parse(source).iterate({
		enter(node) {
			if (node.type.name === "HashtagRef") {
				found.add(source.slice(node.from, node.to));
			}
		},
	});
	return [...found];
}

export function serializeXPathWorkerValue(
	value: XPathValue,
): SerializedXPathValue {
	if (!isXPathDate(value)) return value;
	return {
		kind: "date",
		days: value.days,
		timeMilliseconds: value.time?.getTime() ?? null,
	};
}

export function deserializeXPathWorkerValue(
	value: SerializedXPathValue,
): XPathValue {
	if (typeof value !== "object") return value;
	return value.timeMilliseconds === null
		? XPathDate.fromDays(value.days)
		: XPathDate.fromJSDate(new Date(value.timeMilliseconds));
}

/** Preserve hashtag nodesets across structured clone instead of flattening
 * them before nodeset-aware JavaRosa functions can inspect cardinality. */
export function serializeXPathWorkerHashtagValue(
	reference: string,
	value: XPathRuntimeValue,
): XPathWorkerHashtagValue {
	if (isXPathNodeSet(value)) {
		return {
			reference,
			kind: "nodeset",
			candidates: value.candidates.map((node) => ({
				instanceId: node.instanceId,
				path: node.path,
			})),
			validPath: value.validPath,
		};
	}
	return {
		reference,
		kind: "scalar",
		value: serializeXPathWorkerValue(unpackXPathRuntimeValue(value)),
	};
}

function snapshotNode(node: XPathNode): XPathWorkerNodeSnapshot {
	const children = node.children();
	const attributes = node.attributes();
	const templateChildren = (node.templateChildren?.() ?? []).filter(
		(template) => !children.some((child) => child.name === template.name),
	);
	const templateAttributes = (node.templateAttributes?.() ?? []).filter(
		(template) =>
			!attributes.some((attribute) => attribute.name === template.name),
	);
	return {
		name: node.name,
		path: node.path,
		kind: node.kind,
		multiplicity: node.multiplicity,
		value: serializeXPathWorkerValue(node.value()),
		relevant: node.isRelevant(),
		children: children.map(snapshotNode),
		attributes: attributes.map(snapshotNode),
		templateChildren: templateChildren.map(snapshotNode),
		templateAttributes: templateAttributes.map(snapshotNode),
		childTemplateNames: node.childTemplateNames?.(),
		attributeTemplateNames: node.attributeTemplateNames?.(),
	};
}

/** Project an existing Preview instance onto the structured-clone protocol. */
export function snapshotXPathWorkerInstance(
	instance: XPathInstance,
): XPathWorkerInstanceSnapshot {
	return { id: instance.id, root: snapshotNode(instance.root()) };
}
