"""Identify the forwarded submissions made by each actual phone and tablet on the release and local archive."""

from collections import defaultdict
from urllib.parse import parse_qs, urlsplit

AS_INSTALLED = "android@as-is"


def _receivers(network):
    """HQ's successful form-post address on each walk, after any delivery override. Exclude the device's log."""
    targets = defaultdict(list)
    for item in network or []:
        url = urlsplit(item.get("url") or "")
        if (
            item.get("method") == "POST"
            and item.get("url_name") == "receiver_post_with_app_id"
            and item.get("status") == 201
            and "force_logs" not in parse_qs(url.query)
        ):
            path = urlsplit(item.get("delivered") or item["url"]).path.rstrip("/")
            targets[item["walk"]].append(path.rsplit("/", 1)[-1])
    return targets


def _forwarded_to(payloads, receivers):
    targets = set(receivers or [])
    if targets not in ({"@app"}, {"@build"}) or not payloads:
        return False
    build = "@build" if targets == {"@build"} else None
    return all(p.get("app_id") == "@app" and "build_id" in p and p["build_id"] == build for p in payloads)


def record(state, get, *, local=False):
    """A new observation names each phone. On older records, join each run's payload to the receiver the
    Android peer logged: HQ addresses the app without a build ID and the released build with its build ID.
    A missing or ambiguous context is a refusal, and is never paired by its place in a list."""
    record = get(state["connect"]) if state.get("connect") else {}
    runs = record.get("runs") or {}
    tagged = not local or AS_INSTALLED in runs
    networks = {"android": {}}
    contexts = [
        ("android", "androidDelivered" if local else "android", ""),
        ("android", "androidDeliveredTablet" if local else "androidTablet", "@tablet"),
    ]
    if local:
        networks[AS_INSTALLED] = {}
        contexts.append((AS_INSTALLED, "android", ""))
    for reader, key, suffix in contexts:
        ref = (state.get(key) or {}).get("hq")
        if ref:
            networks[reader].update({walk + suffix: targets for walk, targets in _receivers(get(ref)).items()})
    grouped = {reader: defaultdict(list) for reader in networks}
    issues = []
    for bucket in networks:
        for run in runs.get(bucket, []):
            name = run["run"]
            reader = bucket
            if bucket == AS_INSTALLED and name.endswith("@tablet"):
                issues.append((f"{bucket}:{name}", "Only a phone opens the local archive as installed."))
                continue
            payloads = [post.get("payload") or {} for post in run.get("posts") or []]
            if not tagged and not name.endswith("@tablet"):
                matched = [role for role, routes in networks.items() if _forwarded_to(payloads, routes.get(name))]
                if len(matched) != 1:
                    issues.append((name, "The forwarded run does not identify exactly one phone's receiver."))
                    continue
                reader = matched[0]
            routes = networks[reader].get(name, [])
            successful = sum(item.get("status") == 201 for item in run.get("received") or [])
            if successful != len(routes):
                reason = f"HQ recorded {len(routes)} successful submissions; the forwarding run recorded {successful}."
                issues.append((f"{reader}:{name}", reason))
                continue
            if payloads and set(routes) in ({"@app"}, {"@build"}) and not _forwarded_to(payloads, routes):
                issues.append((f"{reader}:{name}", "The forwarded payload identifies a different receiver."))
                continue
            grouped[reader][name].append(run)
    separated = dict(runs)
    for reader, by_name in grouped.items():
        separated[reader] = []
        for name in sorted(set(by_name) | set(networks[reader])):
            values = by_name.get(name, [])
            if len(values) == 1:
                separated[reader].append(values[0])
            else:
                reason = f"Expected one forwarding run for this device walk, found {len(values)}."
                issues.append((f"{reader}:{name}", reason))
    return {**record, "runs": separated}, issues
