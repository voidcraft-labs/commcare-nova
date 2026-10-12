"""The native proof families and the chains between them.

A family is one corpus: the directory ``$PROOF_OUT/native/<family>`` its
producer writes, the HQ step (``steps.STEPS``) that regenerates HQ's artifacts
into the same directory, and the resource namespace (``/<family>/...``) the
Core classes that read it load from. The chains run in this order, per family:

    producer -> HQ step -> Core class -> HQ payload check

with two families that interleave further: ``media``, whose HQ pass waits for
Core's parse of the exact sources HQ asks Formplayer to validate (the
certificate ``MediaRuntimeTest.sourceFormsParseWithRealCoreBeforeHqMatching``
writes), and the payload families (``navigation``, ``function``, ``quote``),
whose Core classes write the search queries HQ's compiler then reads.
"""

from dataclasses import dataclass

VITEST = "node_modules/.bin/vitest"


@dataclass(frozen=True)
class Family:
    name: str
    # The command that writes the corpus, run from the checkout's root. A
    # script producer takes the output directory as its last argument; a
    # Vitest writer reads it from ``output_variable``.
    command: tuple[str, ...]
    output_variable: str | None = None

    @property
    def uses_vitest(self):
        return self.command[0] == VITEST


def _script(name, producer):
    return Family(name, ("node", "--import", "tsx", f"proof/native/producers/{producer}"))


def _vitest(name, test_file, variable):
    return Family(name, (VITEST, "run", test_file, "--project", "unit"), variable)


FAMILIES = {
    family.name: family
    for family in [
        _script("arithmetic", "emit-arithmetic-evidence.ts"),
        _script("case", "emit-case-evidence.ts"),
        _script("case-choice", "emit-case-choice-evidence.ts"),
        _script("case-list", "emit-case-list-evidence.ts"),
        _script("connect", "emit-connect-evidence.ts"),
        _script("container", "emit-container-evidence.ts"),
        _script("endpoint", "emit-endpoint-evidence.ts"),
        _script("form-link", "emit-form-link-evidence.ts"),
        _script("function", "emit-function-evidence.ts"),
        _script("localization", "emit-localization-evidence.ts"),
        _script("location", "emit-location-evidence.ts"),
        _script("lookup", "emit-lookup-evidence.ts"),
        _script("media", "emit-media-evidence.ts"),
        _script("navigation", "emit-navigation-evidence.ts"),
        _script("nested-menu", "emit-nested-menu-evidence.ts"),
        _script("no-matches", "emit-no-matches-evidence.ts"),
        _script("oracle", "emit-oracle-evidence.ts"),
        _script("predicate", "emit-predicate-evidence.ts"),
        _script("prompt", "emit-prompt-evidence.ts"),
        _script("quote", "emit-quote-evidence.ts"),
        _script("relation-instance", "emit-relation-instance-evidence.ts"),
        _script("search", "emit-search-evidence.ts"),
        _script("standard-case-reads", "emit-standard-case-reads.ts"),
        _script("static-quote", "emit-static-quote-evidence.ts"),
        _script("tile", "emit-tile-evidence.ts"),
        _script("worker", "emit-worker-evidence.ts"),
        _script("xml", "emit-xml-evidence.ts"),
        _script("xpath", "emit-xpath-evidence.ts"),
        # The admitted expander corpus and the HQ-JSON oracle probes are
        # written by the Vitest suites that already build them.
        _vitest("expander", "lib/commcare/__tests__/expander.test.ts", "NOVA_EXPANDER_EVIDENCE_DIR"),
        _vitest("hq-oracle", "lib/commcare/__tests__/hqJsonOracle.test.ts", "NOVA_HQ_ORACLE_EVIDENCE_DIR"),
    ]
}

# Each Core class and the one family it reads. A class runs after its
# family's producer and HQ step (steps.STEPS, where the family has one).
CORE_CLASSES = {
    "ArithmeticRuntimeTest": "arithmetic",
    "CaseCaptureRuntimeTest": "case",
    "CaseChoiceRuntimeTest": "case-choice",
    "CaseListRuntimeTest": "case-list",
    "CaseOperationRuntimeTest": "case",
    "ConnectRuntimeTest": "connect",
    "ContainerRuntimeTest": "container",
    "CsqlFunctionRuntimeTest": "function",
    "CsqlQuoteRuntimeTest": "quote",
    "EndpointRuntimeTest": "endpoint",
    "ExpanderRuntimeTest": "expander",
    "FormLinkRuntimeTest": "form-link",
    "LocalizationRuntimeTest": "localization",
    "LocationOwnerRuntimeTest": "location",
    "LookupRuntimeTest": "lookup",
    "MediaRuntimeTest": "media",
    "NavigationRuntimeTest": "navigation",
    "NestedMenuRuntimeTest": "nested-menu",
    "NoMatchesRuntimeTest": "no-matches",
    "OperationRelevanceRuntimeTest": "case",
    "PredicateRuntimeTest": "predicate",
    "RelationInstanceRuntimeTest": "relation-instance",
    "SearchPromptRuntimeTest": "prompt",
    "SearchRuntimeTest": "search",
    "StandardCaseReadsRuntimeTest": "standard-case-reads",
    "StaticQuoteRuntimeTest": "static-quote",
    "SuiteOracleRuntimeTest": "oracle",
    "TileGroupingRuntimeTest": "tile",
    "TileSuiteRuntimeTest": "tile",
    "WorkerIdentityRuntimeTest": "worker",
    "XFormOracleRuntimeTest": "oracle",
    "XPathCarrierCompatibilityTest": "xpath",
    "XmlTextRuntimeTest": "xml",
}

# The one Core method whose parse of the media sources HQ's media pass waits for.
MEDIA_CERTIFICATE = "MediaRuntimeTest.sourceFormsParseWithRealCoreBeforeHqMatching"
