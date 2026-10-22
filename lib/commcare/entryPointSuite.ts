import type { Element } from "domhandler";
import { type BlueprintDoc, entryPointInventory } from "@/lib/domain";
import { el, type WireElementContext, xel } from "./elementBuilders";
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
import { w } from "./xpath/wire/builders";
import { InstanceSink, selectedCasesInstance } from "./xpath/wire/instances";
import { caseById } from "./xpath/wire/rowScope";

function argumentDatum(
	s: EntryPointRequiredSelection,
	context: WireElementContext,
): Element {
	return xel(
		s.cardinality === "multiple" ? "instance-datum" : "datum",
		{
			attributes: { id: s.argumentId },
			xpath: { value: w.endpointArgumentVar(s.argumentId) },
		},
		context,
	);
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
	const instances = new InstanceSink();
	const context: WireElementContext = { mode: { target: "suite" }, instances };
	const post = xel(
		"post",
		{
			attributes: { url: claimUrl },
			xpath: {
				relevant: multiple
					? w.ne(w.caseIdVar(), w.str(""))
					: w.eq(w.call("count", [caseById(ref, "casedb")]), w.num(0)),
			},
		},
		context,
		[
			xel(
				"data",
				{
					attributes: { key: "case_id" },
					xpath: {
						ref: multiple ? w.context() : ref,
						...(multiple
							? {
									nodeset: w.instance(selectedCasesInstance(id), [
										w.step("results"),
										w.step("value"),
									]),
									exclude: w.eq(
										w.call("count", [
											caseById(w.current([w.self()]), "casedb"),
										]),
										w.num(1),
									),
								}
							: {}),
					},
				},
				context,
			),
		],
	);
	// The computed datum reads the session even when the multiple claim itself
	// reads only the selected-entity and case instances. Build every tree before
	// materializing this remote request's declarations.
	const session = el("session", {}, [
		xel(
			"datum",
			{
				attributes: { id },
				xpath: { function: ref },
			},
			context,
		),
	]);
	return el("remote-request", {}, [
		post,
		el("command", { id: `claim_command.${endpointId}.${id}` }, [
			el("display", {}, [el("text", {})]),
		]),
		...instances
			.declarations()
			.map(({ id, src }) => el("instance", { id, src })),
		session,
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
		const instances = new InstanceSink();
		const context: WireElementContext = {
			mode: { target: "suite" },
			instances,
		};
		const selections = new Map(
			p.requiredSelections.map((s) => [s.argumentId, s]),
		);
		const pushes: Element[] = [];
		if (!moduleIsSearchFirst(doc.modules[target.moduleUuid]))
			for (const selection of p.requiredSelections) {
				pushes.push(
					el("push", {}, [
						argumentDatum(selection, context),
						xel(
							"command",
							{
								xpath: {
									value: w.str(
										`claim_command.${entryPoint.id}.${selection.argumentId}`,
									),
								},
							},
							context,
						),
					]),
				);
				remoteRequests.push(
					entryPointClaimRequest(entryPoint.id, selection, urls.claim),
				);
			}
		const navigation = p.frame.flatMap((child): Element[] => {
			if (child.type === "command")
				return [xel("command", { xpath: { value: w.str(child.id) } }, context)];
			const d = child.datum;
			if (d.query) {
				if (d.caseType === undefined) {
					throw new Error(
						`Entry point '${entryPoint.id}' has a case hydration query without its case type. Check the projected navigation frame.`,
					);
				}
				return [
					el("query", { id: d.id, value: urls.caseFixture }, [
						xel(
							"data",
							{
								attributes: { key: "case_type" },
								xpath: { ref: w.str(d.caseType) },
							},
							context,
						),
						xel(
							"data",
							{
								attributes: { key: "case_id" },
								xpath: {
									ref: d.query.nextDatumIsCollection
										? w.context()
										: w.caseIdVar(),
									...(d.query.nextDatumIsCollection
										? {
												nodeset: w.instance(
													selectedCasesInstance(d.query.nextDatumId),
													[w.step("results"), w.step("value")],
												),
											}
										: {}),
								},
							},
							context,
						),
					]),
				];
			}
			const selected = selections.get(d.id);
			return selected ? [argumentDatum(selected, context)] : [];
		});
		pushes.push(el("push", {}, navigation));
		// EndpointParser supplies collection instances through argument metadata;
		// an endpoint has no <instance> declaration scope of its own.
		const suppliedInstances = new Set(
			p.requiredSelections
				.filter((selection) => selection.cardinality === "multiple")
				.map((selection) => selection.argumentId),
		);
		for (const declaration of instances.declarations()) {
			if (
				!suppliedInstances.has(declaration.id) ||
				declaration.src !== selectedCasesInstance(declaration.id).src
			) {
				throw new Error(
					`Entry point '${entryPoint.id}' reads instance '${declaration.id}' without a matching collection argument. Check its projected navigation frame.`,
				);
			}
		}
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
