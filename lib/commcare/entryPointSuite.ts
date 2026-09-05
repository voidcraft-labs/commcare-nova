import type { Element } from "domhandler";
import { type BlueprintDoc, entryPointInventory } from "@/lib/domain";
import { el } from "./elementBuilders";
import {
	type EntryPointRequiredSelection,
	projectEntryPoint,
} from "./entryPointProjection";
import {
	type FormLinkProjectionContext,
	sessionDataRef,
} from "./formLinkProjection";
import { runtimeUrls } from "./runtimeTarget";
import { moduleIsSearchFirst } from "./suite/case-search/inlineSearch";

function argumentDatum(s: EntryPointRequiredSelection): Element {
	return el(s.cardinality === "multiple" ? "instance-datum" : "datum", {
		id: s.argumentId,
		value: `$${s.argumentId}`,
	});
}
/** Exact claim request shape in HQ session_endpoint_remote_request*.xml. */
export function entryPointClaimRequest(
	endpointId: string,
	s: EntryPointRequiredSelection,
	claimUrl: string,
): Element {
	const id = s.argumentId,
		ref = sessionDataRef(id),
		multiple = s.cardinality === "multiple";
	return el("remote-request", {}, [
		el(
			"post",
			{
				url: claimUrl,
				relevant: multiple
					? "$case_id != ''"
					: `count(instance('casedb')/casedb/case[@case_id=${ref}]) = 0`,
			},
			[
				el("data", {
					key: "case_id",
					ref: multiple ? "." : ref,
					...(multiple
						? {
								nodeset: `instance('${id}')/results/value`,
								exclude:
									"count(instance('casedb')/casedb/case[@case_id=current()/.]) = 1",
							}
						: {}),
				}),
			],
		),
		el("command", { id: `claim_command.${endpointId}.${id}` }, [
			el("display", {}, [el("text", {})]),
		]),
		el("instance", { id: "casedb", src: "jr://instance/casedb" }),
		el("instance", { id: "commcaresession", src: "jr://instance/session" }),
		...(multiple
			? [el("instance", { id, src: `jr://instance/selected-entities/${id}` })]
			: []),
		el("session", {}, [el("datum", { id, function: ref })]),
		el("stack", {}),
	]);
}
export function buildEntryPointSuite(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
): { endpoints: Element[]; remoteRequests: Element[] } {
	const endpoints: Element[] = [],
		remoteRequests: Element[] = [];
	const urls = runtimeUrls(ctx.runtimeTarget);
	for (const { target, entryPoint } of entryPointInventory(doc)) {
		const p = projectEntryPoint(doc, target, ctx);
		const selections = new Map(
			p.requiredSelections.map((s) => [s.argumentId, s]),
		);
		const pushes: Element[] = [];
		if (!moduleIsSearchFirst(doc.modules[target.moduleUuid]))
			for (const selection of p.requiredSelections) {
				pushes.push(
					el("push", {}, [
						argumentDatum(selection),
						el("command", {
							value: `'claim_command.${entryPoint.id}.${selection.argumentId}'`,
						}),
					]),
				);
				remoteRequests.push(
					entryPointClaimRequest(entryPoint.id, selection, urls.claim),
				);
			}
		const navigation = p.frame.flatMap((child): Element[] => {
			if (child.type === "command")
				return [el("command", { value: `'${child.id}'` })];
			const d = child.datum;
			if (d.query)
				return [
					el("query", { id: d.id, value: urls.caseFixture }, [
						el("data", { key: "case_type", ref: `'${d.caseType}'` }),
						el("data", {
							key: "case_id",
							ref: d.query.nextDatumIsCollection ? "." : "$case_id",
							...(d.query.nextDatumIsCollection
								? {
										nodeset: `instance('${d.query.nextDatumId}')/results/value`,
									}
								: {}),
						}),
					]),
				];
			const selected = selections.get(d.id);
			return selected ? [argumentDatum(selected)] : [];
		});
		pushes.push(el("push", {}, navigation));
		endpoints.push(
			el(
				"endpoint",
				{
					id: entryPoint.id,
					...(entryPoint.ignoreDisplayConditions
						? { "respect-relevancy": "false" }
						: {}),
				},
				[
					...p.requiredSelections.map((s) =>
						el("argument", {
							id: s.argumentId,
							...(s.cardinality === "multiple"
								? {
										"instance-id": s.argumentId,
										"instance-src": "jr://instance/selected-entities",
									}
								: {}),
						}),
					),
					el("stack", {}, pushes),
				],
			),
		);
	}
	return { endpoints, remoteRequests };
}
