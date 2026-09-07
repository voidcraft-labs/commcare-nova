import type {
	FormLinkCarryVerdict,
	FormLinkRequiredDatum,
	FormLinkTargetVerdict,
} from "@/lib/doc/formLinkReview";
import type { FormLink } from "@/lib/domain";

/** One presentation decision from the real shared admission verdicts. The
 * recovery branches are defensive views of previously stored invalid maps. */
export function carryValuesModel(
	link: FormLink,
	carry: FormLinkCarryVerdict,
	required: readonly FormLinkRequiredDatum[],
	manualCarry: FormLinkTargetVerdict,
) {
	const manual = link.datums !== undefined;
	const manualCarryUnavailable = !manualCarry.ok;
	const invalidManual = manual && manualCarryUnavailable;
	return {
		manual,
		manualCarryUnavailable,
		invalidManual,
		presentation:
			carry.kind === "nothing-needed" && !manual
				? ("nothing" as const)
				: invalidManual && carry.kind !== "automatic"
					? ("destination-repair" as const)
					: carry.kind === "manual-required"
						? ("manual-required" as const)
						: carry.kind === "automatic" && manualCarryUnavailable && !manual
							? ("collection" as const)
							: carry.kind === "automatic"
								? ("choices" as const)
								: ("none" as const),
		missing: required.filter(
			(datum) => !(link.datums ?? []).some((held) => held.name === datum.id),
		),
	};
}
