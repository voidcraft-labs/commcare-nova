"""Native editor forks observed by separate workers and reassembled in HQ's order.

A worker repeats B's baseline and the complete inventory. A view owns all its
sections and a Vellum form owns both saves. The ordinary B record is written
only after the workers agree on everything they observed in common.
"""

from __future__ import annotations

import copy
import hashlib

from proof.observe.record import canonical


def key_for(parent, index, total):
    if total != 2 or type(index) is not int or not 1 <= index <= total:
        raise ValueError(f"Expected one of two editor partitions, got {index} of {total}.")
    return hashlib.sha256(canonical(["editor-partition", 1, parent.hex(), index, total])).digest()


def owner(kind, index, forms):
    # Keep all page saves together. The later worker carries the larger half of the forms.
    return 1 if kind == "views" or index < forms // 2 else 2


class Capture:
    def __init__(self, parent, index, total):
        self.key = key_for(parent, index, total)
        self.index = index
        self.parent = parent.hex()
        self.inventory = {}
        self.entries = {"views": [], "vellum": []}
        self.served_keys = set()

    def plan(self, views, forms):
        if len(forms) < 2:
            raise ValueError("Dividing an editor observation requires at least two forms.")
        self.inventory = {
            "views": [{"view": view, "target": target, "scope": scope} for view, target, scope in views],
            "vellum": [{"target": target, "scope": [m, f]} for m, f, target in forms],
        }

    def owns(self, kind, index):
        return owner(kind, index, len(self.inventory["vellum"])) == self.index

    def run(self, kind, index, log, function, *args):
        # Remove only this complete fork's actual receipts from the common outer log. The unit and its
        # operation scopes keep all their normal calls, writes, flags and branch keys.
        start, requests = len(log.log), len(log.requests)
        result = function(*args)
        self.entries[kind].append(
            {
                "index": index,
                "record": result,
                "operations": log.log[start:],
                "requests": log.requests[requests:],
            }
        )
        del log.log[start:]
        del log.requests[requests:]

    def fragment(self, base, blobs):
        if not self.inventory or "proof4" not in base:
            raise ValueError("The native B state did not produce a complete editor inventory.")
        result = {
            "parent": self.parent,
            "index": self.index,
            "total": 2,
            "common": base,
            "inventory": self.inventory,
            "entries": self.entries,
            "servedKeys": sorted(self.served_keys),
        }
        named = blobs.named_by(result)
        result["blobIds"] = named.refs()
        return result, named


def _complete_fork(kind, row):
    # The normal native observer returns one report per offered section and both Vellum runs, or its
    # explicit reason for an unopened form or second save. A truncated fragment cannot seal an ordinary B.
    if kind == "views":
        offered = [offer["section"] for offer in row["offers"] if offer["offer"] == "offered"]
        return offered == [section["section"] for section in row["sections"]]
    if row["offer"] == "skipped":
        return bool(row.get("reason")) and "runs" not in row
    if row["offer"] != "offered":
        return False
    again = row.get("again")
    if again is None:
        return len(row["runs"]) == 2
    return len(row["runs"]) == 1 and again.get("offer") == "skipped" and bool(again.get("reason"))


def merge(parent, fragments):
    if len(fragments) != 2:
        raise ValueError("Joining the editor observation requires both workers.")
    first = fragments[0]
    inventory = first["inventory"]
    if set(inventory) != {"views", "vellum"} or len(inventory["vellum"]) < 2:
        raise ValueError("Invalid native editor inventory.")
    record = copy.deepcopy(first["common"])
    if not isinstance(record.get("proof4"), dict) or any(k in record["proof4"] for k in inventory):
        raise ValueError("The common B record must hold its baseline alone.")
    if set(fragments[0]["servedKeys"]) & set(fragments[1]["servedKeys"]):
        # Serving a saved build for the first time issues real HQ requests. The ordinary observer memoizes
        # the next identical state without those requests. Cold workers cannot concatenate those receipts.
        raise ValueError("A saved native reader state spans both partitions; observe this configuration whole.")
    requests = record.pop("requests", [])
    for index, part in enumerate(fragments, 1):
        if (part["parent"], part["index"], part["total"]) != (parent.hex(), index, 2):
            raise ValueError("A worker presented a different B parent or partition identity.")
        if part["inventory"] != inventory or part["common"] != first["common"]:
            raise ValueError("Editor workers disagree on their native baseline, receipts or complete inventory.")
        if set(part["entries"]) != set(inventory):
            raise ValueError("An editor partition omitted a native scope family.")
    for kind in ("views", "vellum"):
        expected = inventory[kind]
        rows = []
        for part in fragments:
            indices = [i for i in range(len(expected)) if owner(kind, i, len(inventory["vellum"])) == part["index"]]
            entries = part["entries"][kind]
            if [entry["index"] for entry in entries] != indices:
                raise ValueError(f"An editor partition missed, repeated or reordered a {kind} scope.")
            for i, entry in zip(indices, entries, strict=True):
                result = entry["record"]
                if any(result.get(k) != v for k, v in expected[i].items()) or not expected[i].keys() <= result.keys():
                    raise ValueError(f"The observed {kind} scope {i} differs from HQ's native inventory.")
                if not _complete_fork(kind, result):
                    raise ValueError(f"The native {kind} scope {i} omitted a section or save.")
                rows.append(result)
                record["operations"].extend(entry["operations"])
                requests.extend(entry["requests"])
        record["proof4"][kind] = rows
    if requests:
        record["requests"] = sorted(requests, key=canonical)
    return record
