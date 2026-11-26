import {
	isVisibleSearchInput,
	type Module,
	projectSearchOf,
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
				? "Add the address field to a case Search screen. A Search supplied by the project space uses the inputs it defines."
				: isVisibleSearchInput(input)
					? searchAddressReceiverProblem(input, inputs)
					: undefined;
		return reason === undefined
			? []
			: [
					validationError(
						"CASE_LIST_SEARCH_ADDRESS_FIELD",
						"module",
						reason,
						{ moduleUuid, moduleName: module.name },
						{
							slot: `caseListConfig.searchInputs[${index}]`,
							inputName: input.name,
							inputUuid: input.uuid,
						},
					),
				];
	});
}
