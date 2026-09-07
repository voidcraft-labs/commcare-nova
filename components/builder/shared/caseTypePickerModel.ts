import { caseTypeNameVerdict } from "@/lib/doc/identifierVerdicts";
import { humanizeId, slugifyId } from "@/lib/domain";

interface CaseTypeDisplay {
	readonly label: string;
	readonly needsDisambiguation: boolean;
}

/**
 * Case types are stored as identifiers but read as concepts in the builder.
 * Only identifiers that collapse to the same friendly label need their
 * stored value exposed so a person can tell them apart.
 */
export function caseTypeDisplays(
	names: readonly string[],
): ReadonlyMap<string, CaseTypeDisplay> {
	const labels = names.map((name) => ({ name, label: humanizeId(name) }));
	const labelCounts = new Map<string, number>();
	for (const { label } of labels) {
		const key = label.toLowerCase();
		labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
	}

	return new Map(
		labels.map(({ name, label }) => [
			name,
			{
				label,
				needsDisambiguation: (labelCounts.get(label.toLowerCase()) ?? 0) > 1,
			},
		]),
	);
}

function creationErrorMessage(
	verdict: ReturnType<typeof caseTypeNameVerdict>,
	candidate: string,
): string | null {
	if (verdict.ok) return null;

	switch (verdict.code) {
		case "empty":
			return "Use at least one letter or number";
		case "illegal_format":
			return "Start the name with a word, not a number";
		case "reserved":
			return `Choose a more specific name, such as ${humanizeId(candidate)} record`;
		case "too_long":
			return "Use a shorter name";
		case "duplicate":
			return `${humanizeId(candidate)} already exists. Choose it above.`;
	}
}

export function planCaseTypeCreation({
	draft,
	existingNames,
	exclude,
	choiceVerdict,
}: {
	readonly draft: string;
	readonly existingNames: ReadonlySet<string>;
	readonly exclude?: ReadonlySet<string>;
	readonly choiceVerdict?: (
		name: string,
	) => { readonly ok: true } | { readonly ok: false; readonly reason: string };
}) {
	const candidate = slugifyId(draft, "");
	const verdict = caseTypeNameVerdict(candidate, existingNames);
	const excluded = exclude?.has(candidate) === true;
	const choice =
		verdict.ok && !excluded
			? (choiceVerdict?.(candidate) ?? { ok: true as const })
			: { ok: true as const };
	const canCreate = verdict.ok && !excluded && choice.ok;
	const error =
		draft.trim().length === 0 || canCreate
			? null
			: excluded
				? !verdict.ok && verdict.code === "duplicate"
					? `${humanizeId(candidate)} already exists and is managed by the platform. Choose a different name.`
					: "That case type is managed by the platform and cannot be changed here. Choose a different name."
				: !verdict.ok
					? creationErrorMessage(verdict, candidate)
					: !choice.ok
						? choice.reason
						: null;
	return { candidate, canCreate, error };
}
