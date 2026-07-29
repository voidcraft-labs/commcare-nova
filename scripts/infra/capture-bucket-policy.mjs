import { readFileSync, writeFileSync } from "node:fs";
import { captureCleanupIamCondition } from "./capture-storage-policy.mjs";

export const CAPTURE_POLICY_TITLE = "nova-capture-only-v1";
export const CAPTURE_POLICY_DESCRIPTION =
	"Capture staging durable and health objects only";

function requirePolicyObject(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Storage IAM policy must be a JSON object.");
	}
	if (typeof value.etag !== "string" || value.etag.length === 0) {
		throw new Error(
			"Storage IAM policy is missing its etag; refusing a non-atomic rewrite.",
		);
	}
	if (value.bindings !== undefined && !Array.isArray(value.bindings)) {
		throw new Error("Storage IAM policy bindings must be an array.");
	}
	return value;
}

export function parseStorageIamPolicy(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error("Storage IAM policy response was not valid JSON.", {
			cause: error,
		});
	}
	return requirePolicyObject(parsed);
}

function normalizeBinding(binding) {
	if (
		binding === null ||
		typeof binding !== "object" ||
		Array.isArray(binding) ||
		typeof binding.role !== "string" ||
		!Array.isArray(binding.members) ||
		binding.members.some((member) => typeof member !== "string")
	) {
		throw new Error("Storage IAM policy contains a malformed binding.");
	}
	return {
		...binding,
		members: [...binding.members],
	};
}

function withoutMember(binding, member) {
	const members = binding.members.filter((candidate) => candidate !== member);
	return members.length === 0 ? undefined : { ...binding, members };
}

/**
 * Produce one etag-preserving bucket-policy replacement.
 *
 * Every stale cleanup/custom-role condition and every historical broad
 * principal/role variant is removed in the same rewrite that adds the sole
 * intended binding. Unrelated principals on a shared binding survive.
 */
export function convergeCaptureBucketPolicy(policyInput, args) {
	const policy = requirePolicyObject(structuredClone(policyInput));
	const cleanupMember = `serviceAccount:${args.cleanupAccount}`;
	const mediaPolicyMember = `serviceAccount:${args.mediaPolicyAccount}`;
	const bindings = [];
	for (const rawBinding of policy.bindings ?? []) {
		const binding = normalizeBinding(rawBinding);
		let next = binding;
		if (binding.members.includes(cleanupMember)) {
			next = withoutMember(next, cleanupMember);
		}
		if (next?.members.includes(mediaPolicyMember)) {
			next = withoutMember(next, mediaPolicyMember);
		}
		if (next !== undefined) bindings.push(next);
	}
	bindings.push({
		role: args.mediaPolicyRole,
		members: [mediaPolicyMember],
	});
	bindings.push({
		role: args.captureRole,
		members: [cleanupMember],
		condition: {
			title: CAPTURE_POLICY_TITLE,
			description: CAPTURE_POLICY_DESCRIPTION,
			expression: captureCleanupIamCondition(args.bucket),
		},
	});
	return {
		...policy,
		version: 3,
		bindings,
	};
}

export function assertCaptureBucketPolicy(policyInput, args) {
	const policy = requirePolicyObject(policyInput);
	const cleanupMember = `serviceAccount:${args.cleanupAccount}`;
	const mediaPolicyMember = `serviceAccount:${args.mediaPolicyAccount}`;
	const normalizedBindings = (policy.bindings ?? []).map(normalizeBinding);
	const cleanupBindings = normalizedBindings.filter((binding) =>
		binding.members.includes(cleanupMember),
	);
	const captureBindings = cleanupBindings.filter(
		(binding) => binding.role === args.captureRole,
	);
	if (captureBindings.length !== 1) {
		throw new Error(
			`Expected exactly one capture-cleanup custom-role binding; found ${captureBindings.length}.`,
		);
	}
	if (cleanupBindings.length !== 1) {
		throw new Error(
			"Capture-cleanup principal has authority outside its sole intended custom-role binding.",
		);
	}
	const expectedCondition = {
		title: CAPTURE_POLICY_TITLE,
		description: CAPTURE_POLICY_DESCRIPTION,
		expression: captureCleanupIamCondition(args.bucket),
	};
	const actualCondition = captureBindings[0].condition;
	if (
		actualCondition === null ||
		typeof actualCondition !== "object" ||
		actualCondition.title !== expectedCondition.title ||
		actualCondition.description !== expectedCondition.description ||
		actualCondition.expression !== expectedCondition.expression
	) {
		throw new Error("Capture-cleanup binding condition does not match policy.");
	}
	const mediaBindings = normalizedBindings.filter((binding) =>
		binding.members.includes(mediaPolicyMember),
	);
	if (
		mediaBindings.length !== 1 ||
		mediaBindings[0].role !== args.mediaPolicyRole ||
		mediaBindings[0].condition !== undefined
	) {
		throw new Error(
			"Media-policy principal does not have exactly its sole unconditioned custom-role binding.",
		);
	}
}

function cliArgs(argv) {
	const [
		command,
		bucket,
		cleanupAccount,
		mediaPolicyAccount,
		captureRole,
		mediaPolicyRole,
	] = argv;
	if (
		(command !== "render" && command !== "verify") ||
		!bucket ||
		!cleanupAccount ||
		!mediaPolicyAccount ||
		!captureRole ||
		!mediaPolicyRole
	) {
		throw new Error(
			"Usage: capture-bucket-policy.mjs <render|verify> <bucket> <cleanup-account> <media-policy-account> <capture-role> <media-policy-role> <input> [output]",
		);
	}
	return {
		command,
		args: {
			bucket,
			cleanupAccount,
			mediaPolicyAccount,
			captureRole,
			mediaPolicyRole,
		},
		input: argv[6],
		output: argv[7],
	};
}

if (process.argv[1]?.endsWith("capture-bucket-policy.mjs")) {
	const parsed = cliArgs(process.argv.slice(2));
	if (!parsed.input)
		throw new Error("Storage IAM policy input path is missing.");
	const policy = parseStorageIamPolicy(readFileSync(parsed.input, "utf8"));
	if (parsed.command === "verify") {
		assertCaptureBucketPolicy(policy, parsed.args);
	} else {
		if (!parsed.output) {
			throw new Error("Storage IAM policy output path is missing.");
		}
		const converged = convergeCaptureBucketPolicy(policy, parsed.args);
		assertCaptureBucketPolicy(converged, parsed.args);
		writeFileSync(parsed.output, `${JSON.stringify(converged, null, 2)}\n`);
	}
}
