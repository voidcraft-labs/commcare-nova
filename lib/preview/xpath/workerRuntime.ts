/* Import the generated parser directly: the full public XPath barrel also
 * re-exports validators, lowering passes, and domain schemas. A standalone
 * browser worker cannot share those main-realm modules, so pulling the barrel
 * here duplicates hundreds of kilobytes that evaluation never reaches. */
import { parser } from "@/lib/commcare/xpath/parser";
import {
	ASYNC_XPATH_FUNCTIONS,
	evaluateAsync,
	evaluateRuntimeAsync,
} from "./asyncEvaluator";
import { xpathToString } from "./coerce";
import { javaRosaSleep } from "./javaRosaSleep";
import {
	isXPathNodeSet,
	unpackXPathRuntimeValue,
	type XPathInstance,
	type XPathNode,
	XPathNodeSet,
	type XPathRuntimeValue,
} from "./runtimeValues";
import type { EvalContext, XPathValue } from "./types";
import {
	deserializeXPathWorkerValue,
	serializeXPathWorkerValue,
} from "./workerProjection";
import {
	XPATH_WORKER_PROTOCOL_VERSION,
	type XPathRuntimeErrorCode,
	type XPathWorkerEvaluateRequest,
	type XPathWorkerInstanceSnapshot,
	type XPathWorkerNodeAddress,
	type XPathWorkerNodeSnapshot,
	type XPathWorkerRequest,
	type XPathWorkerResponse,
} from "./workerProtocol";

export interface XPathWorkerEvaluationTools {
	readonly signal: AbortSignal;
	/** Worker-owned timer boundary used by async functions such as sleep(). */
	delay(milliseconds: number): Promise<void>;
	/** Worker-owned browser cryptography boundary. */
	readonly crypto?: Pick<Crypto, "getRandomValues" | "subtle">;
}

export type AsyncXPathWorkerFunction =
	| "decrypt-string"
	| "encrypt-string"
	| "regex"
	| "replace"
	| "sleep";

/**
 * Parse-time routing signal for callers that must not enter the synchronous
 * evaluator. Detection does not execute or copy the expression.
 */
export function asyncXPathWorkerFunctions(
	source: string,
): ReadonlySet<AsyncXPathWorkerFunction> {
	const found = new Set<AsyncXPathWorkerFunction>();
	parser.parse(source).iterate({
		enter(node) {
			if (node.type.name !== "Invoke") return;
			const functionName = node.node.getChild("FunctionName");
			if (functionName === null) return;
			const name = source.slice(functionName.from, functionName.to);
			if (ASYNC_XPATH_FUNCTIONS.has(name)) {
				found.add(name as AsyncXPathWorkerFunction);
			}
		},
	});
	return found;
}

export function xpathRequiresAsyncWorker(source: string): boolean {
	return asyncXPathWorkerFunctions(source).size > 0;
}

/** Parsed hashtag tokens used to snapshot only the values one request can
 * observe. This deliberately does not regex-scan authored text. */
interface XPathWorkerNodesetValues {
	readonly kind: "nodeset-values";
	readonly values: readonly string[];
}

function isWorkerNodesetValues(
	value: XPathValue | XPathWorkerNodesetValues,
): value is XPathWorkerNodesetValues {
	return (
		"kind" in Object(value) &&
		(value as { kind?: string }).kind === "nodeset-values"
	);
}

export type XPathWorkerEvaluator = (
	request: XPathWorkerEvaluateRequest,
	tools: XPathWorkerEvaluationTools,
) =>
	| XPathValue
	| XPathWorkerNodesetValues
	| Promise<XPathValue | XPathWorkerNodesetValues>;

export interface XPathWorkerDispatcher {
	handleMessage(message: XPathWorkerRequest): void;
	retire(): void;
}

class WorkerXPathInstance implements XPathInstance {
	readonly id: string | null;
	private readonly rootNode: WorkerXPathNode;
	private readonly nodes = new Map<string, WorkerXPathNode>();

	constructor(snapshot: XPathWorkerInstanceSnapshot) {
		this.id = snapshot.id;
		this.rootNode = new WorkerXPathNode(this, snapshot.root);
	}

	root(): XPathNode {
		return this.rootNode;
	}

	register(node: WorkerXPathNode): void {
		this.nodes.set(node.path, node);
	}

	node(path: string): WorkerXPathNode | undefined {
		return this.nodes.get(path);
	}

	setValue(path: string, value: XPathValue): void {
		this.nodes.get(path)?.setValue(value);
	}

	setRelevant(path: string, relevant: boolean): void {
		this.nodes.get(path)?.setRelevant(relevant);
	}
}

class WorkerXPathNode implements XPathNode {
	readonly instanceId: string | null;
	readonly path: string;
	readonly name: string;
	readonly kind: "element" | "attribute";
	readonly multiplicity: number;
	private scalar: XPathValue;
	private relevant: boolean;
	private readonly childNodes: readonly WorkerXPathNode[];
	private readonly attributeNodes: readonly WorkerXPathNode[];
	private readonly templateChildNodes: readonly WorkerXPathNode[];
	private readonly templateAttributeNodes: readonly WorkerXPathNode[];
	private readonly childTemplateNamesSet: ReadonlySet<string>;
	private readonly attributeTemplateNamesSet: ReadonlySet<string>;
	private readonly parentNode?: WorkerXPathNode;

	constructor(
		instance: WorkerXPathInstance,
		snapshot: XPathWorkerNodeSnapshot,
		parent?: WorkerXPathNode,
	) {
		this.instanceId = instance.id;
		this.path = snapshot.path;
		this.name = snapshot.name;
		this.kind = snapshot.kind;
		this.multiplicity = snapshot.multiplicity;
		this.scalar = deserializeXPathWorkerValue(snapshot.value);
		this.relevant = snapshot.relevant;
		this.parentNode = parent;
		instance.register(this);
		this.childNodes = snapshot.children.map(
			(child) => new WorkerXPathNode(instance, child, this),
		);
		this.attributeNodes = snapshot.attributes.map(
			(attribute) => new WorkerXPathNode(instance, attribute, this),
		);
		this.templateChildNodes = (snapshot.templateChildren ?? []).map(
			(child) => new WorkerXPathNode(instance, child, this),
		);
		this.templateAttributeNodes = (snapshot.templateAttributes ?? []).map(
			(attribute) => new WorkerXPathNode(instance, attribute, this),
		);
		this.childTemplateNamesSet = new Set(snapshot.childTemplateNames ?? []);
		this.attributeTemplateNamesSet = new Set(
			snapshot.attributeTemplateNames ?? [],
		);
	}

	value(): XPathValue {
		return this.scalar;
	}

	setValue(value: XPathValue): void {
		this.scalar = value;
	}

	setRelevant(relevant: boolean): void {
		this.relevant = relevant;
	}

	parent(): XPathNode | undefined {
		return this.parentNode;
	}

	children(name?: string): readonly XPathNode[] {
		return this.childNodes.filter(
			(child) => name === undefined || name === "*" || child.name === name,
		);
	}

	/** Rebase one cached template node into a concrete synthetic occurrence.
	 * Dynamic casedb index identifiers rely on the wildcard template's blank
	 * `case_type` and `relationship` attributes surviving structured clone. */
	private snapshotAs(name: string, path: string): XPathWorkerNodeSnapshot {
		const childPath = (child: WorkerXPathNode): string => {
			const base = `${path}/${child.name}`;
			return child.multiplicity === 0 ? base : `${base}[${child.multiplicity}]`;
		};
		const attributePath = (attribute: WorkerXPathNode): string =>
			`${path}/@${attribute.name}`;
		const concreteAttributes = [
			...this.attributeNodes,
			...this.templateAttributeNodes.filter(
				(template) =>
					!this.attributeNodes.some(
						(attribute) => attribute.name === template.name,
					),
			),
		];
		return {
			name,
			path,
			kind: this.kind,
			multiplicity: 0,
			value: serializeXPathWorkerValue(this.scalar),
			relevant: this.relevant,
			children: this.childNodes.map((child) =>
				child.snapshotAs(child.name, childPath(child)),
			),
			attributes: concreteAttributes.map((attribute) =>
				attribute.snapshotAs(attribute.name, attributePath(attribute)),
			),
			templateChildren: this.templateChildNodes.map((child) =>
				child.snapshotAs(child.name, childPath(child)),
			),
			templateAttributes: this.templateAttributeNodes
				.filter(
					(template) =>
						!concreteAttributes.some(
							(attribute) => attribute.name === template.name,
						),
				)
				.map((attribute) =>
					attribute.snapshotAs(attribute.name, attributePath(attribute)),
				),
			childTemplateNames: [...this.childTemplateNamesSet],
			attributeTemplateNames: [...this.attributeTemplateNamesSet],
		};
	}

	attributes(name?: string): readonly XPathNode[] {
		return this.attributeNodes.filter(
			(attribute) =>
				name === undefined || name === "*" || attribute.name === name,
		);
	}

	templateChildren(name?: string): readonly XPathNode[] {
		const actual = this.children(name);
		if (actual.length > 0) return actual;
		return this.templateChildNodes.filter(
			(child) =>
				name === undefined ||
				name === "*" ||
				child.name === name ||
				child.name === "*",
		);
	}

	templateAttributes(name?: string): readonly XPathNode[] {
		const actual = this.attributes(name);
		if (actual.length > 0) return actual;
		return this.templateAttributeNodes.filter(
			(attribute) =>
				name === undefined || name === "*" || attribute.name === name,
		);
	}

	hasChildTemplate(name?: string): boolean {
		return (
			(name === undefined || name === "*"
				? this.childTemplateNamesSet.size > 0
				: this.childTemplateNamesSet.has("*") ||
					this.childTemplateNamesSet.has(name)) ||
			[...this.childNodes, ...this.templateChildNodes].some(
				(child) =>
					name === undefined ||
					name === "*" ||
					child.name === "*" ||
					child.name === name,
			)
		);
	}

	hasAttributeTemplate(name?: string): boolean {
		return (
			(name === undefined || name === "*"
				? this.attributeTemplateNamesSet.size > 0
				: this.attributeTemplateNamesSet.has(name)) ||
			[...this.attributeNodes, ...this.templateAttributeNodes].some(
				(attribute) =>
					name === undefined || name === "*" || attribute.name === name,
			)
		);
	}

	childTemplateNames(): readonly string[] {
		return [...this.childTemplateNamesSet];
	}

	attributeTemplateNames(): readonly string[] {
		return [...this.attributeTemplateNamesSet];
	}

	isRelevant(): boolean {
		return this.relevant;
	}
}

function safeError(
	request: XPathWorkerEvaluateRequest,
	code: XPathRuntimeErrorCode,
): XPathWorkerResponse {
	return {
		protocolVersion: XPATH_WORKER_PROTOCOL_VERSION,
		operation: "evaluate",
		requestId: request.requestId,
		entryKey: request.entryKey,
		revision: request.revision,
		profile: request.profile,
		ok: false,
		error: {
			code,
			operation: "evaluate",
			entryKey: request.entryKey,
			revision: request.revision,
			profile: request.profile,
		},
	};
}

/**
 * Default evaluator used by the browser worker for both ordinary and yielding
 * expressions. The async companion delegates wholly synchronous subtrees to
 * the existing evaluator.
 */
export async function evaluateXPathWorkerRequest(
	request: XPathWorkerEvaluateRequest,
	tools: XPathWorkerEvaluationTools,
	worldCache?: XPathWorkerEvaluationWorldCache,
): Promise<XPathValue | XPathWorkerNodesetValues> {
	const requestedWorldKey = request.instances.worldKey;
	let world = worldCache?.world;
	if (requestedWorldKey !== undefined) {
		if (request.instances.initializeWorld) {
			world = {
				key: requestedWorldKey,
				main: request.instances.main
					? new WorkerXPathInstance(request.instances.main)
					: undefined,
				secondary: new Map(
					(request.instances.secondary ?? []).map((snapshot) => {
						const instance = new WorkerXPathInstance(snapshot);
						return [snapshot.id, instance] as const;
					}),
				),
			};
			if (worldCache !== undefined) worldCache.world = world;
		} else if (world?.key !== requestedWorldKey) {
			throw new Error("The XPath worker evaluation world is unavailable.");
		}
	}
	const main =
		requestedWorldKey === undefined
			? request.instances.main
				? new WorkerXPathInstance(request.instances.main)
				: undefined
			: world?.main;
	const secondary =
		requestedWorldKey === undefined
			? new Map(
					(request.instances.secondary ?? []).map((snapshot) => {
						const instance = new WorkerXPathInstance(snapshot);
						return [snapshot.id, instance] as const;
					}),
				)
			: (world?.secondary ?? new Map());
	const pathValues = new Map(
		(request.instances.pathValues ?? []).map(({ path, value }) => [
			path,
			deserializeXPathWorkerValue(value),
		]),
	);
	for (const [path, value] of pathValues) main?.setValue(path, value);
	for (const { path, relevant } of request.instances.pathRelevance ?? []) {
		main?.setRelevant(path, relevant);
	}
	const resolveNode = (address: XPathWorkerNodeAddress | undefined) => {
		if (address === undefined) return undefined;
		const instance =
			address.instanceId === main?.id
				? main
				: secondary.get(address.instanceId);
		return instance?.node(address.path);
	};
	const hashtagValues = new Map(
		(request.instances.hashtagValues ?? []).map((hashtag) => {
			const value: XPathRuntimeValue =
				hashtag.kind === "scalar"
					? deserializeXPathWorkerValue(hashtag.value)
					: new XPathNodeSet(
							hashtag.candidates.flatMap((address) => {
								const node = resolveNode(address);
								return node === undefined ? [] : [node];
							}),
							hashtag.validPath,
						);
			return [hashtag.reference, value] as const;
		}),
	);

	const context: EvalContext = {
		...(request.instances.locale === undefined
			? {}
			: { locale: request.instances.locale }),
		getValue: (path) => {
			const direct = pathValues.get(path);
			if (direct !== undefined) return xpathToString(direct);
			const node = main?.node(path);
			return node === undefined ? undefined : xpathToString(node.value());
		},
		resolveHashtag: (reference) =>
			xpathToString(hashtagValues.get(reference) ?? ""),
		resolveHashtagValue: (reference) => hashtagValues.get(reference) ?? "",
		resolveInstance: (instanceId, path) => {
			const instance = secondary.get(instanceId);
			if (instance === undefined) return { kind: "unsupported" };
			const node = instance.node(path);
			return {
				kind: "supported",
				...(node === undefined ? {} : { value: xpathToString(node.value()) }),
			};
		},
		...(main === undefined ? {} : { mainInstance: main }),
		resolveXPathInstance: (instanceId) => secondary.get(instanceId),
		contextPath: request.instances.contextPath,
		position: request.instances.position,
		contextNode: resolveNode(request.instances.contextNode),
		originalContextNode: resolveNode(request.instances.originalContextNode),
	};
	if (request.resultMode === "nodeset-values-or-scalar") {
		const value = await evaluateRuntimeAsync(request.source, context, tools);
		return isXPathNodeSet(value)
			? {
					kind: "nodeset-values",
					values: value.nodes.map((node) => xpathToString(node.value())),
				}
			: unpackXPathRuntimeValue(value);
	}
	return evaluateAsync(request.source, context, tools);
}

interface XPathWorkerEvaluationWorld {
	readonly key: string;
	readonly main: WorkerXPathInstance | undefined;
	readonly secondary: ReadonlyMap<string | null, WorkerXPathInstance>;
}

interface XPathWorkerEvaluationWorldCache {
	world?: XPathWorkerEvaluationWorld;
}

/** Create the message owner used by both the real Worker and test adapter. */
export function createXPathWorkerDispatcher(args: {
	readonly postMessage: (response: XPathWorkerResponse) => void;
	readonly evaluate?: XPathWorkerEvaluator;
}): XPathWorkerDispatcher {
	const worldCache: XPathWorkerEvaluationWorldCache = {};
	const evaluateRequest: XPathWorkerEvaluator =
		args.evaluate ??
		((request, tools) =>
			evaluateXPathWorkerRequest(request, tools, worldCache));
	const active = new Map<number, AbortController>();
	let retired = false;

	const abortMatching = (
		entryKey: string,
		revision: number,
		profile: XPathWorkerEvaluateRequest["profile"],
	) => {
		for (const [requestId, controller] of active) {
			const request = requestById.get(requestId);
			if (
				request?.entryKey === entryKey &&
				request.revision === revision &&
				request.profile === profile
			) {
				controller.abort(new DOMException("Cancelled", "AbortError"));
			}
		}
	};
	const requestById = new Map<number, XPathWorkerEvaluateRequest>();

	return {
		handleMessage(message) {
			if (
				retired ||
				message.protocolVersion !== XPATH_WORKER_PROTOCOL_VERSION
			) {
				return;
			}
			if (message.operation === "cancel") {
				const request = requestById.get(message.requestId);
				if (
					request?.entryKey === message.entryKey &&
					request.revision === message.revision &&
					request.profile === message.profile
				) {
					active
						.get(message.requestId)
						?.abort(new DOMException("Cancelled", "AbortError"));
				}
				return;
			}
			if (message.operation === "retire") {
				abortMatching(message.entryKey, message.revision, message.profile);
				return;
			}

			const request = message;
			if (active.has(request.requestId)) {
				args.postMessage(safeError(request, "invalid-request"));
				return;
			}
			const controller = new AbortController();
			active.set(request.requestId, controller);
			requestById.set(request.requestId, request);
			void Promise.resolve()
				.then(() =>
					evaluateRequest(request, {
						signal: controller.signal,
						crypto: globalThis.crypto,
						delay: async (milliseconds) => {
							/* The host timeout is a CPU watchdog for synchronous work such as
							 * Java Pattern backtracking. JavaRosa sleep is an intentional yield,
							 * so pause that watchdog while the worker-owned timer is pending and
							 * restart a full CPU window when evaluation resumes. */
							args.postMessage({
								protocolVersion: XPATH_WORKER_PROTOCOL_VERSION,
								operation: "watchdog",
								state: "pause",
								requestId: request.requestId,
								entryKey: request.entryKey,
								revision: request.revision,
								profile: request.profile,
							});
							try {
								await javaRosaSleep(milliseconds, undefined, controller.signal);
							} finally {
								args.postMessage({
									protocolVersion: XPATH_WORKER_PROTOCOL_VERSION,
									operation: "watchdog",
									state: "resume",
									requestId: request.requestId,
									entryKey: request.entryKey,
									revision: request.revision,
									profile: request.profile,
								});
							}
						},
					}),
				)
				.then((value) => {
					if (retired || active.get(request.requestId) !== controller) return;
					args.postMessage({
						protocolVersion: XPATH_WORKER_PROTOCOL_VERSION,
						operation: "evaluate",
						requestId: request.requestId,
						entryKey: request.entryKey,
						revision: request.revision,
						profile: request.profile,
						ok: true,
						value: isWorkerNodesetValues(value)
							? ""
							: serializeXPathWorkerValue(value),
						...(isWorkerNodesetValues(value)
							? { nodesetValues: value.values }
							: {}),
					});
				})
				.catch(() => {
					if (retired || active.get(request.requestId) !== controller) return;
					args.postMessage(
						safeError(
							request,
							controller.signal.aborted ? "cancelled" : "evaluation-failed",
						),
					);
				})
				.finally(() => {
					if (active.get(request.requestId) === controller) {
						active.delete(request.requestId);
						requestById.delete(request.requestId);
					}
				});
		},
		retire() {
			if (retired) return;
			retired = true;
			for (const controller of active.values()) {
				controller.abort(new DOMException("Retired", "AbortError"));
			}
			active.clear();
			requestById.clear();
			worldCache.world = undefined;
		},
	};
}
