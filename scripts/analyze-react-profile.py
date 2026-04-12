#!/usr/bin/env python3
"""
Analyze React DevTools profiler traces.

Parses the JSON exported from React DevTools Profiler tab and outputs
structured analysis of render commits, component durations, re-render
causes, and wasted renders.

Usage:
    python3 scripts/analyze-profile.py <file.json>                    # Summary of all commits
    python3 scripts/analyze-profile.py <file.json> --frame 47         # Detail for frame 47 (1-indexed)
    python3 scripts/analyze-profile.py <file.json> --frame 47 --ancestors BuilderSubheader
                                                                       # Ancestor chain for a component in that frame
    python3 scripts/analyze-profile.py <file.json> --component UploadToHqDialog
                                                                       # All frames where this component rendered
    python3 scripts/analyze-profile.py <file.json> --wasted           # Components with 100% wasted renders
    python3 scripts/analyze-profile.py <file.json> --top 30           # Top 30 most expensive components (cumulative)
"""

import json
import sys
from pathlib import Path


def load_profile(path: str) -> dict:
    with open(path) as f:
        return json.load(f)


def build_name_map(root: dict) -> dict[int, str]:
    """Extract fiber ID -> display name from snapshots."""
    names: dict[int, str] = {}
    for entry in root.get("snapshots", []):
        if isinstance(entry, list) and len(entry) >= 2:
            node = entry[1]
            if isinstance(node, dict):
                fid = node.get("id")
                name = node.get("displayName")
                if fid is not None and name:
                    names[fid] = name
    return names


def build_parent_map(root: dict) -> dict[int, int]:
    """Extract fiber ID -> parent fiber ID from snapshots."""
    parents: dict[int, int] = {}
    for entry in root.get("snapshots", []):
        if isinstance(entry, list) and len(entry) >= 2:
            node = entry[1]
            if isinstance(node, dict):
                fid = node.get("id")
                for child in node.get("children", []):
                    parents[child] = fid
    return parents


def parse_pairs(arr: list) -> dict:
    """Parse a list of [key, value] pairs into a dict."""
    result = {}
    for item in arr:
        if isinstance(item, list) and len(item) >= 2:
            result[item[0]] = item[1]
    return result


def format_change(ch: dict | None, rendered: bool = True) -> str:
    """Format a changeDescription dict into a human-readable string."""
    if not ch or not rendered:
        return ""
    if not isinstance(ch, dict):
        return str(ch)

    parts = []
    if ch.get("isFirstMount"):
        parts.append("FIRST MOUNT")
    if ch.get("props"):
        parts.append(f"props={ch['props']}")
    if ch.get("hooks"):
        parts.append(f"hooks={ch['hooks']}")
    if ch.get("didHooksChange"):
        parts.append("hooksChanged")
    if ch.get("state"):
        parts.append("state")
    if ch.get("context"):
        parts.append("context")
    if not parts and not ch.get("isFirstMount"):
        parts.append("parent cascade")
    return " | ".join(parts)


def analyze_commit(root: dict, names: dict[int, str], commit_idx: int) -> dict:
    """Analyze a single commit and return structured data."""
    commit = root["commitData"][commit_idx]
    actual = parse_pairs(commit.get("fiberActualDurations", []))
    self_dur = parse_pairs(commit.get("fiberSelfDurations", []))
    changes = parse_pairs(commit.get("changeDescriptions", []))

    components = []
    for fid, dur in actual.items():
        ch = changes.get(fid, {})
        components.append({
            "fid": fid,
            "name": names.get(fid, f"(unnamed-{fid})"),
            "actual": dur,
            "self": self_dur.get(fid, 0),
            "change": ch,
            "change_str": format_change(ch),
            "is_wasted": (
                isinstance(ch, dict)
                and not ch.get("isFirstMount")
                and not ch.get("props")
                and not ch.get("hooks")
                and not ch.get("didHooksChange")
                and not ch.get("state")
                and not ch.get("context")
            ),
        })

    components.sort(key=lambda c: c["actual"], reverse=True)
    return {
        "index": commit_idx,
        "timestamp": commit.get("timestamp", 0),
        "duration": commit.get("duration", 0),
        "priority": commit.get("priorityLevel", "?"),
        "component_count": len(components),
        "components": components,
    }


def print_commit_detail(commit_data: dict, min_duration: float = 0.05):
    """Print detailed analysis of a single commit."""
    print(f"\n{'='*70}")
    print(f"Frame {commit_data['index'] + 1} — {commit_data['duration']:.1f}ms "
          f"at {commit_data['timestamp']:.0f}ms "
          f"({commit_data['component_count']} components)")
    print(f"{'='*70}\n")

    for c in commit_data["components"]:
        if c["actual"] < min_duration:
            continue
        wasted = " [WASTED]" if c["is_wasted"] else ""
        change = f" — {c['change_str']}" if c["change_str"] else ""
        print(f"  {c['name']}: {c['actual']:.2f}ms (self={c['self']:.2f}ms){change}{wasted}")


def print_ancestor_chain(root: dict, names: dict[int, str], parents: dict[int, int],
                         commit_data: dict, target_name: str):
    """Print the ancestor chain for a component in a specific commit."""
    # Find the fiber ID for the target component
    target_fid = None
    for c in commit_data["components"]:
        if target_name.lower() in c["name"].lower():
            target_fid = c["fid"]
            break

    if target_fid is None:
        # Search all fibers, not just rendered ones
        for fid, name in names.items():
            if target_name.lower() in name.lower():
                target_fid = fid
                break

    if target_fid is None:
        print(f"\nComponent '{target_name}' not found.")
        return

    rendered_fids = {c["fid"] for c in commit_data["components"]}
    changes = {c["fid"]: c for c in commit_data["components"]}

    print(f"\n--- Ancestor chain for {names.get(target_fid, target_name)} (#{target_fid}) ---\n")

    fid = target_fid
    while fid is not None:
        name = names.get(fid, f"(unnamed-{fid})")
        rendered = fid in rendered_fids
        marker = "*" if rendered else " "
        info = ""
        if rendered and fid in changes:
            c = changes[fid]
            if c["change_str"]:
                info = f" — {c['change_str']}"
            if c["actual"] > 0:
                info += f" ({c['actual']:.1f}ms)"
        print(f"  {marker} {name} (#{fid}){info}")
        fid = parents.get(fid)


def print_component_history(root: dict, names: dict[int, str], target_name: str):
    """Print all commits where a component rendered."""
    commits = root["commitData"]
    print(f"\n--- All frames where '{target_name}' rendered ---\n")

    found_any = False
    for ci in range(len(commits)):
        commit_data = analyze_commit(root, names, ci)
        for c in commit_data["components"]:
            if target_name.lower() in c["name"].lower():
                found_any = True
                wasted = " [WASTED]" if c["is_wasted"] else ""
                change = f" — {c['change_str']}" if c["change_str"] else ""
                print(f"  Frame {ci + 1}: {c['actual']:.2f}ms{change}{wasted}")
                break

    if not found_any:
        print(f"  Component '{target_name}' did not render in any frame.")


def print_wasted_renders(root: dict, names: dict[int, str]):
    """Print components with the highest percentage of wasted renders."""
    commits = root["commitData"]

    # Track per-component: total renders, wasted renders, total duration
    stats: dict[str, dict] = {}
    for ci in range(len(commits)):
        commit_data = analyze_commit(root, names, ci)
        for c in commit_data["components"]:
            name = c["name"]
            if name not in stats:
                stats[name] = {"total": 0, "wasted": 0, "total_ms": 0, "wasted_ms": 0}
            stats[name]["total"] += 1
            stats[name]["total_ms"] += c["self"]
            if c["is_wasted"]:
                stats[name]["wasted"] += 1
                stats[name]["wasted_ms"] += c["self"]

    # Filter to components with at least 1 wasted render, sort by wasted count
    wasted = [(name, s) for name, s in stats.items() if s["wasted"] > 0]
    wasted.sort(key=lambda x: x[1]["wasted"], reverse=True)

    print(f"\n--- Components with wasted renders ---\n")
    print(f"  {'Component':<40} {'Wasted':>7} {'Total':>7} {'%':>6} {'Wasted ms':>10}")
    print(f"  {'─'*40} {'─'*7} {'─'*7} {'─'*6} {'─'*10}")
    for name, s in wasted:
        pct = (s["wasted"] / s["total"] * 100) if s["total"] > 0 else 0
        print(f"  {name:<40} {s['wasted']:>7} {s['total']:>7} {pct:>5.0f}% {s['wasted_ms']:>9.1f}ms")


def print_top_components(root: dict, names: dict[int, str], top_n: int = 20):
    """Print the most expensive components by cumulative actual duration."""
    commits = root["commitData"]

    stats: dict[str, dict] = {}
    for ci in range(len(commits)):
        commit_data = analyze_commit(root, names, ci)
        for c in commit_data["components"]:
            name = c["name"]
            if name not in stats:
                stats[name] = {"total_actual": 0, "total_self": 0, "renders": 0}
            stats[name]["total_actual"] += c["actual"]
            stats[name]["total_self"] += c["self"]
            stats[name]["renders"] += 1

    sorted_stats = sorted(stats.items(), key=lambda x: x[1]["total_self"], reverse=True)

    print(f"\n--- Top {top_n} components by cumulative self duration ---\n")
    print(f"  {'Component':<40} {'Self (ms)':>10} {'Actual (ms)':>12} {'Renders':>8} {'Avg self':>9}")
    print(f"  {'─'*40} {'─'*10} {'─'*12} {'─'*8} {'─'*9}")
    for name, s in sorted_stats[:top_n]:
        avg = s["total_self"] / s["renders"] if s["renders"] > 0 else 0
        print(f"  {name:<40} {s['total_self']:>9.1f} {s['total_actual']:>11.1f} {s['renders']:>8} {avg:>8.2f}")


def print_summary(root: dict, names: dict[int, str]):
    """Print a summary of all commits."""
    commits = root["commitData"]
    print(f"\n{'='*70}")
    print(f"Profile Summary — {len(commits)} commits, {len(names)} components tracked")
    print(f"{'='*70}\n")

    total_duration = sum(c.get("duration", 0) for c in commits)
    print(f"  Total render time: {total_duration:.1f}ms")

    # List commits sorted by duration
    print(f"\n  {'Frame':>6} {'Time (ms)':>10} {'Duration':>10} {'Components':>12}")
    print(f"  {'─'*6} {'─'*10} {'─'*10} {'─'*12}")
    for ci, commit in enumerate(commits):
        dur = commit.get("duration", 0)
        ts = commit.get("timestamp", 0)
        commit_data = analyze_commit(root, names, ci)
        n = commit_data["component_count"]
        marker = " **" if dur > 16.7 else ""  # Flag frames over 16.7ms (60fps budget)
        print(f"  {ci + 1:>6} {ts:>9.0f} {dur:>9.1f}ms {n:>12}{marker}")


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Analyze React DevTools profiler traces")
    parser.add_argument("file", help="Path to the profiler JSON file")
    parser.add_argument("--frame", type=int, help="Show detail for a specific frame (1-indexed)")
    parser.add_argument("--ancestors", type=str, help="Show ancestor chain for a component (use with --frame)")
    parser.add_argument("--component", type=str, help="Show all frames where a component rendered")
    parser.add_argument("--wasted", action="store_true", help="Show components with wasted renders")
    parser.add_argument("--top", type=int, help="Show top N most expensive components")
    parser.add_argument("--min-duration", type=float, default=0.05, help="Min duration to show in frame detail (default 0.05ms)")
    args = parser.parse_args()

    data = load_profile(args.file)
    root = data["dataForRoots"][0]
    names = build_name_map(root)
    parents = build_parent_map(root)

    if args.frame:
        idx = args.frame - 1  # Convert 1-indexed to 0-indexed
        if idx < 0 or idx >= len(root["commitData"]):
            print(f"Frame {args.frame} out of range (1-{len(root['commitData'])})")
            sys.exit(1)
        commit_data = analyze_commit(root, names, idx)
        print_commit_detail(commit_data, args.min_duration)
        if args.ancestors:
            print_ancestor_chain(root, names, parents, commit_data, args.ancestors)
    elif args.component:
        print_component_history(root, names, args.component)
    elif args.wasted:
        print_wasted_renders(root, names)
    elif args.top:
        print_top_components(root, names, args.top)
    else:
        print_summary(root, names)
        print_top_components(root, names, 20)
        print_wasted_renders(root, names)


if __name__ == "__main__":
    main()
