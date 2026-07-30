export interface CasePropertyRenameInput {
	readonly caseType: string;
	readonly from: string;
	readonly to: string;
}

export interface CasePropertyRenameStorageImpact {
	readonly renamedRows: number;
	readonly renamedParkedValues: number;
	readonly byRename: readonly {
		readonly caseType: string;
		readonly from: string;
		readonly to: string;
		readonly rowsWithSource: number;
		readonly parkedValuesWithSource: number;
	}[];
}

export interface CasePropertyRenameStorageConflict {
	readonly caseType: string;
	readonly property: string;
	readonly carrier: "case-row" | "parked-value";
	readonly count: number;
}

export type CasePropertyRenamePreflightResult =
	| {
			readonly kind: "ok";
			readonly mutationSeq: number;
			readonly report: CasePropertyRenameStorageImpact;
	  }
	| {
			readonly kind: "conflict";
			readonly mutationSeq: number;
			readonly conflicts: readonly CasePropertyRenameStorageConflict[];
	  }
	| {
			readonly kind: "invalid";
			readonly mutationSeq: number;
			readonly messages: readonly string[];
	  }
	| { readonly kind: "not-found" | "unauthenticated" | "forbidden" };
