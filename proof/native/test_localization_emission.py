"""HQ's language-code rule accepts every code Nova's localization exports carry.

Contract: each language code of the six localization scenarios satisfies
HQ's own grammar for a language code
(``app_manager/models/applications.py::validate_lang``, which the localization
step runs on every code HQ's import keeps), the binding fact Nova's language
wire plan rests on (``docs/architecture/multilingual-localization.md``,
"Binding CommCare facts"). HQ's build never runs that rule (only a rename on
its Languages page does), so neither the checks' builds nor their editor
saves see a code outside it. The plausible failures: a code Nova's wire plan
emits that HQ's grammar refuses, and HQ narrowing its grammar under a code
Nova emits.

The same step regenerates each scenario's form, suite and per-language app
strings for ``LocalizationRuntimeTest``, and the worker step regenerates
the worker scenarios for ``WorkerIdentityRuntimeTest``; that HQ imports and
builds those documents is the checks' (``proof/checks/bar.py``).
"""

from proof.native.hq_support import hq_commit, write_evidence

FAMILIES = ("localization",)


def test_hq_accepts_every_language_code_nova_emits(native):
    records = native.step("localization")
    assert len(records) == 6, len(records)
    write_evidence(
        native.family("localization"),
        "localization-emission",
        {
            "results": records,
            "hqCommit": hq_commit(),
            "limits": "HQ's validate_lang over each code HQ's import of the export keeps. No language editor save, "
            "full HQ build, network or database persistence.",
        },
    )
