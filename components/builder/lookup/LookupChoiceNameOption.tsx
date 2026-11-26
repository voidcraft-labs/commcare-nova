import { SelectItem } from "@/components/shadcn/select";
import type { Platform } from "@/lib/domain/platforms";
import {
	lookupPathNameExplanation,
	lookupPathNameIssue,
} from "@/lib/lookup/pathNames";

/** Keep the original label visible when this choice source cannot read its
 * export name. The person can still choose a different table or column. */
export function LookupChoiceNameOption({
	value,
	label,
	name,
	part,
	slot,
	platforms,
}: {
	value: string;
	label: string;
	name: string;
	part: "tag" | "column";
	slot: "lookup_options_source" | "search_input_options";
	platforms: readonly Platform[];
}) {
	const issue = lookupPathNameIssue(name, slot, part, platforms);
	return (
		<SelectItem value={value} disabled={issue !== null} wrap>
			{issue === null ? (
				label
			) : (
				<span>
					{label}
					<span className="block text-[12px] text-nova-text-secondary">
						{name}. {lookupPathNameExplanation(issue)}
					</span>
				</span>
			)}
		</SelectItem>
	);
}
