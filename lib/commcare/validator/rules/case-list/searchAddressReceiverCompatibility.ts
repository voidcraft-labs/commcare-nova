import {
	isVisibleSearchInput,
	type Module,
	projectSearchOf,
	SEARCH_ADDRESS_RECEIVER_MESSAGES,
	searchAddressReceiverProblem,
	type Uuid,
} from "@/lib/domain";
import { validationError } from "../../errors";

export function searchAddressReceiverCompatibility(
	module: Module,
	moduleUuid: Uuid,
) {
	const inputs = module.caseListConfig?.searchInputs ?? [];
	const projectSearch = projectSearchOf(module) !== undefined;
	return inputs.flatMap((input, index) => {
		const reason =
			input.kind === "address" && projectSearch
				? "project-search"
				: isVisibleSearchInput(input)
					? searchAddressReceiverProblem(input, inputs)
					: undefined;
		return reason === undefined
			? []
			: [
					validationError(
						"CASE_LIST_SEARCH_ADDRESS_FIELD",
						"module",
						reason === "project-search"
							? "Add the address field to a case Search screen. A Search supplied by the project space uses the inputs it defines."
							: SEARCH_ADDRESS_RECEIVER_MESSAGES[reason],
						{ moduleUuid, moduleName: module.name },
						{
							reason,
							slot: `caseListConfig.searchInputs[${index}]`,
							inputName: input.name,
							inputUuid: input.uuid,
						},
					),
				];
	});
}
