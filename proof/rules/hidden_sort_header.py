"""A Formplayer entity table can carry an empty header as a single no-break space in a hidden sort column.

Core's EntityListSubscreen.getHeaders supplies every field to Formplayer. The Web Apps table tests
columnVisible before emitting the header, its body tests styles[index].widthHint, and the column
preferences omit that index when ColumnConfigModel.getCanBeVisible reads zero. A tile list's own
Sort menu consumes the header independently and is outside this rule.
"""

from proof.rules import SpellingRule


def normalize(trace):
    for run in trace.get("runs") or ():
        for step in run.get("steps") or ():
            response = step.get("response") or {}
            if (
                response.get("type") != "entities"
                or response.get("usesCaseTiles") is not False
                or response.get("tiles") is not None
            ):
                continue
            headers = response.get("headers") or []
            widths = response.get("widthHints") or []
            styles = response.get("styles") or []
            if len(headers) != len(widths) or len(headers) != len(styles):
                continue
            for index in response.get("sortIndices") or ():
                if (
                    type(index) is int
                    and 0 <= index < len(headers)
                    and headers[index] == "\u00a0"
                    and type(widths[index]) is int
                    and widths[index] == 0
                    and isinstance(styles[index], dict)
                    and type(styles[index].get("widthHint")) is int
                    and styles[index]["widthHint"] == 0
                ):
                    headers[index] = ""
    return trace


PROOF = "test_web_apps_omits_both_blank_headers_for_a_zero_width_sort_column"
RULE = SpellingRule(
    "hidden-sort-header",
    "formplayer",
    "A table's blank hidden sort header. Its zero width removes it from Web Apps' table and column preferences.",
    normalize,
    readers=(("formplayer", PROOF), ("webapps", PROOF)),
)
