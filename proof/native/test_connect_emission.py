"""Connect's own extractor reads the same learn and deliver metadata from every path of Nova's Connect forms.

Contract: for each Connect scenario, Connect's metadata extractors at the
pinned commit (``commcare_connect/opportunity/app_xml.py``:
``extract_connect_blocks``, ``extract_deliver_units``,
``extract_task_units``) read exactly the modules, deliver units and tasks the
scenario authors (with its escaped and non-ASCII text) from HQ's imported
source, the CCZ form and HQ's regenerated form, and read nothing from the
scenario without Connect. ``ConnectRuntimeTest`` then computes the same
values in Core on both paths. The plausible failures: HQ's regeneration
dropping or re-namespacing Connect blocks, and Nova emitting text Connect
decodes differently.
"""

from proof.native.hq_support import hq_commit, write_evidence

FAMILIES = ("connect",)
SCENARIOS = ["learn-default", "learn-custom", "deliver-default", "deliver-custom", "absent"]


def _expected(name):
    return {
        "modules": (
            [{"id": "lesson", "name": "Health & care <雪>", "description": "Read 'A' then \"B\"", "time_estimate": 5}]
            if name.startswith("learn")
            else []
        ),
        "deliver": [{"id": "visit", "name": "Home & clinic <雪>"}] if name.startswith("deliver") else [],
        "tasks": (
            [{"id": "task", "name": "Record & review", "description": "Ask <then> listen"}]
            if name.startswith("deliver")
            else []
        ),
    }


def test_connect_reads_the_authored_metadata_from_every_path(native):
    result = native.step("connect")
    assert result["scenarios"] == SCENARIOS
    forms = []
    for record in result["records"]:
        expected = _expected(record["name"])
        for path, actual in record["metadata"].items():
            assert actual == expected, (record["name"], path, actual, expected)
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
            "source, CCZ and HQ-regenerated forms. Connect is fetched at its pin; its database model, HQ API "
            "exception and HTTP client imports are stood in for only for its unused download paths. No "
            "opportunity initialization, database writes, Connect submission processing, full HQ build or "
            "Android installation.",
        },
    )
