"""Connect's own extractor reads the same learn and deliver metadata from every path of Nova's Connect forms.

Contract: for each Connect scenario, Connect's metadata extractors at the
pinned commit (``commcare_connect/opportunity/app_xml.py``:
``extract_connect_blocks``, ``extract_deliver_units``,
``extract_task_units``) read exactly the modules, deliver units and tasks the
scenario authors (with its escaped and non-ASCII text) from HQ's imported
source, the CCZ form and HQ's regenerated form, each form of the scenario on
its own, and read nothing from the scenario without Connect. A deliver
scenario's deliver unit is in its first form and its task ``follow_up`` in a
form of its own (``<scenario>.task``), since Connect turns away the visit of
a form that also completes the worker's assigned task.
``ConnectRuntimeTest`` then computes the same values in Core on both paths.
The plausible failures: HQ's regeneration dropping or re-namespacing Connect
blocks, a block reaching a form that does not hold it, and Nova emitting text
Connect decodes differently.
"""

from proof.native.hq_support import hq_commit, write_evidence

FAMILIES = ("connect",)
SCENARIOS = ["learn-default", "learn-custom", "deliver-default", "deliver-custom", "absent"]
NOTHING = {"modules": [], "deliver": [], "tasks": []}


def _expected(name):
    """What Connect reads from each form of the scenario, by the form's file stem."""
    if name.startswith("learn"):
        return {
            name: {
                **NOTHING,
                "modules": [
                    {
                        "id": "lesson",
                        "name": "Health & care <雪>",
                        "description": "Read 'A' then \"B\"",
                        "time_estimate": 5,
                    }
                ],
            }
        }
    if name.startswith("deliver"):
        return {
            name: {**NOTHING, "deliver": [{"id": "visit", "name": "Home & clinic <雪>"}]},
            f"{name}.task": {
                **NOTHING,
                "tasks": [{"id": "follow_up", "name": "Record & review", "description": "Ask <then> listen"}],
            },
        }
    return {name: NOTHING}


def test_connect_reads_the_authored_metadata_from_every_path(native):
    result = native.step("connect")
    assert result["scenarios"] == SCENARIOS
    forms = []
    for record in result["records"]:
        expected = _expected(record["name"])
        assert sorted(record["metadata"]) == sorted(expected), (record["name"], sorted(record["metadata"]))
        for stem, paths in record["metadata"].items():
            assert sorted(paths) == ["ccz", "hq-regenerated", "hq-source"], (stem, sorted(paths))
            for path, actual in paths.items():
                assert actual == expected[stem], (stem, path, actual, expected[stem])
        forms.append(
            {
                "name": record["name"],
                "inputSha256": record["inputSha256"],
                "artifacts": record["artifacts"],
                "metadata": expected,
            }
        )
    write_evidence(
        native.family("connect"),
        "connect-emission",
        {
            "hqCommit": hq_commit(),
            "connectCommit": result["connectCommit"],
            "connectSourceSha256": result["connectSourceSha256"],
            "forms": forms,
            "limits": "Native HQ import and case/meta regeneration; native Connect metadata extraction over HQ "
            "source, CCZ and HQ-regenerated forms, each form of a scenario on its own. Connect is fetched at its "
            "pin; its database model, HQ API exception and HTTP client imports are stood in for only for its "
            "unused download paths. No opportunity initialization, database writes, Connect submission "
            "processing, full HQ build or Android installation.",
        },
    )
