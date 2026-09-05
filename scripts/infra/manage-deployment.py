#!/usr/bin/env python3
"""Manage infrequently changed deployment infrastructure. Read-only by default.

Examples:
  python3 scripts/infra/manage-deployment.py check
  python3 scripts/infra/manage-deployment.py media [--apply]
  python3 scripts/infra/manage-deployment.py scheduler [--apply]
  python3 scripts/infra/manage-deployment.py cache [--apply]
  python3 scripts/infra/manage-deployment.py job --job NAME --image REPO@sha256:... [--apply]

The app pipeline checks prerequisites and admits the independent migration artifact.
Capture-worker image and schedule changes are explicit infrastructure maintenance.
IAM identities are managed by provision-deployment-identities.sh [--apply].
"""
from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path
import re
import shlex
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
PROJECT = "commcare-nova"
REGION = "us-central1"
MEDIA_BUCKET = "nova-multimedia-prod"
CACHE_BUCKET = "commcare-nova-build-cache"
CACHE_REPOSITORY = "nova-build-cache"
BUILD_ACCOUNT = f"nova-build@{PROJECT}.iam.gserviceaccount.com"
SCHEDULER = "commcare-nova-capture-cleanup"
SCHEDULER_ACCOUNT = f"nova-capture-scheduler@{PROJECT}.iam.gserviceaccount.com"
SCHEDULER_URI = f"https://run.googleapis.com/v2/projects/{PROJECT}/locations/{REGION}/jobs/{SCHEDULER}:run"
JOBS = json.loads((ROOT / "config/deployment-jobs.json").read_text())
MEDIA_POLICY = json.loads((ROOT / "config/media-bucket-policy.json").read_text())
_token: str | None = None


def command(*args: str) -> str:
    return subprocess.run(["gcloud", *args], check=True, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.strip()


def api(method: str, url: str, data: dict | None = None) -> dict:
    global _token
    if _token is None:
        _token = command("auth", "print-access-token")
    request = urllib.request.Request(url, method=method,
        data=None if data is None else json.dumps(data).encode(),
        headers={"Authorization": f"Bearer {_token}", "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def media_findings(actual: dict) -> list[str]:
    findings = []
    if sorted(map(canonical, actual.get("lifecycle", {}).get("rule", []))) != sorted(map(canonical, MEDIA_POLICY["lifecycle"]["rule"])):
        findings.append("temporary-object lifecycle rules")
    if str(actual.get("softDeletePolicy", {}).get("retentionDurationSeconds", "0")) != "0":
        findings.append("soft delete must be disabled")
    if actual.get("versioning", {}).get("enabled", False):
        findings.append("versioning must be disabled")
    if actual.get("defaultEventBasedHold", False):
        findings.append("default event holds must be disabled")
    if actual.get("retentionPolicy") is not None:
        findings.append("operator retention policy is present")
    def cors(rules: list[dict]) -> list[str]:
        return sorted(canonical({k: sorted(v) if isinstance(v, list) else v for k, v in r.items()}) for r in rules)
    if cors(actual.get("cors", [])) != cors(MEDIA_POLICY["cors"]):
        findings.append("signed-upload CORS")
    return findings


def media(apply: bool, check: bool = False) -> None:
    url = f"https://storage.googleapis.com/storage/v1/b/{MEDIA_BUCKET}"
    current = api("GET", url)
    findings = media_findings(current)
    if not findings:
        print("Media retention and CORS match the checked-in policy.")
        return
    if check:
        raise ValueError(f"Media policy drift: {', '.join(findings)}. Run python3 scripts/infra/manage-deployment.py media, then --apply.")
    if current.get("retentionPolicy") is not None:
        raise ValueError("An operator retention policy is present; refusing to remove it.")
    generation = current.get("metageneration")
    if not isinstance(generation, str) or not generation.isdecimal():
        raise ValueError("Media bucket metageneration is missing; refusing an unfenced update.")
    print("Media policy changes: " + ", ".join(findings))
    print(json.dumps(MEDIA_POLICY, indent=2))
    if apply:
        api("PATCH", f"{url}?ifMetagenerationMatch={generation}", MEDIA_POLICY)
        media(False, check=True)


def scheduler_facts() -> dict | None:
    try:
        return json.loads(command("scheduler", "jobs", "describe", SCHEDULER,
                                  f"--project={PROJECT}", f"--location={REGION}", "--format=json"))
    except subprocess.CalledProcessError as error:
        if re.search(r"NOT_FOUND|not found|does not exist", error.stderr, re.I):
            return None
        raise


def scheduler_findings(current: dict | None) -> list[str]:
    if current is None:
        return ["missing scheduled cleanup job"]
    target = current.get("httpTarget", {})
    oauth = target.get("oauthToken", {})
    findings = []
    for key, expected in (("schedule", "*/5 * * * *"), ("timeZone", "Etc/UTC"), ("state", "ENABLED")):
        if current.get(key) != expected:
            findings.append(key)
    if target.get("uri") != SCHEDULER_URI or target.get("httpMethod") != "POST":
        findings.append("HTTP target")
    if oauth.get("serviceAccountEmail") != SCHEDULER_ACCOUNT or oauth.get("scope") != "https://www.googleapis.com/auth/cloud-platform":
        findings.append("OAuth identity/scope")
    if base64.b64decode(target.get("body", "")).strip() != b"{}":
        findings.append("request body")
    headers = {k.lower(): v.lower() for k, v in target.get("headers", {}).items()}
    if headers.get("content-type") != "application/json":
        findings.append("content type")
    return findings


def run_or_plan(args: list[str], apply: bool) -> None:
    print(("APPLY " if apply else "PLAN ") + shlex.join(["gcloud", *args]), flush=True)
    if apply:
        command(*args)


def scheduler(apply: bool, check: bool = False) -> None:
    current = scheduler_facts()
    findings = scheduler_findings(current)
    if check:
        if findings:
            raise ValueError(f"Cleanup scheduler drift: {', '.join(findings)}. Run python3 scripts/infra/manage-deployment.py scheduler, then --apply.")
        print("Scheduled cleanup matches the checked-in contract.")
        return
    run_or_plan(["run", "jobs", "add-iam-policy-binding", SCHEDULER,
        f"--project={PROJECT}", f"--region={REGION}",
        f"--member=serviceAccount:{SCHEDULER_ACCOUNT}", "--role=roles/run.invoker"], apply)
    if findings:
        operation = "create" if current is None else "update"
        run_or_plan(["scheduler", "jobs", operation, "http", SCHEDULER,
            f"--project={PROJECT}", f"--location={REGION}", "--schedule=*/5 * * * *",
            "--time-zone=Etc/UTC", f"--uri={SCHEDULER_URI}", "--http-method=POST",
            "--message-body={}", f"--oauth-service-account-email={SCHEDULER_ACCOUNT}",
            "--oauth-token-scope=https://www.googleapis.com/auth/cloud-platform",
            ("--headers=" if current is None else "--update-headers=") + "Content-Type=application/json"], apply)
        # Paused state belongs to the operator; this explicit apply restores the
        # declared running schedule. The application pipeline never changes it.
        if current is not None and current.get("state") == "PAUSED":
            run_or_plan(["scheduler", "jobs", "resume", SCHEDULER,
                         f"--project={PROJECT}", f"--location={REGION}"], apply)
    if apply:
        scheduler(False, check=True)


def job_arguments(name: str, image: str) -> list[str]:
    if not re.fullmatch(r"[a-z0-9][a-z0-9._/-]+@sha256:[0-9a-f]{64}", image):
        raise ValueError("--image must be an immutable repository@sha256 reference")
    job = JOBS[name]
    args = ["run", "jobs", "deploy", name, f"--project={PROJECT}", f"--region={REGION}",
        f"--image={image}", f"--service-account={job['serviceAccount']}",
        "--command=" + ",".join(job["command"]), "--args=" + ",".join(job["args"]),
        f"--tasks={job['tasks']}", f"--parallelism={job['parallelism']}",
        f"--max-retries={job['maxRetries']}", f"--task-timeout={job['timeout']}",
        f"--cpu={job['cpu']}", f"--memory={job['memory']}",
        "--set-env-vars=" + ",".join(f"{key}={value}" for key, value in job["env"].items())]
    if job["vpc"]:
        args += ["--network=default", "--subnet=default", "--vpc-egress=private-ranges-only"]
    return args


def cache(apply: bool) -> None:
    url = f"https://storage.googleapis.com/storage/v1/b/{CACHE_BUCKET}"
    try:
        actual = api("GET", url)
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
        actual = None
    if actual is None:
        run_or_plan(["storage", "buckets", "create", f"gs://{CACHE_BUCKET}",
            f"--project={PROJECT}", f"--location={REGION}", "--uniform-bucket-level-access",
            "--public-access-prevention"], apply)
    policy = {"lifecycle": {"rule": [{"action": {"type": "Delete"}, "condition": {"age": 14}}]},
        "softDeletePolicy": {"retentionDurationSeconds": "0"}, "versioning": {"enabled": False},
        "iamConfiguration": {"uniformBucketLevelAccess": {"enabled": True}, "publicAccessPrevention": "enforced"}}
    print("Cache bucket policy: " + canonical(policy))
    if apply:
        actual = api("GET", url)
        api("PATCH", f"{url}?ifMetagenerationMatch={actual['metageneration']}", policy)
    run_or_plan(["storage", "buckets", "add-iam-policy-binding", f"gs://{CACHE_BUCKET}",
                 f"--member=serviceAccount:{BUILD_ACCOUNT}", "--role=roles/storage.objectAdmin"], apply)
    try:
        command("artifacts", "repositories", "describe", CACHE_REPOSITORY,
                f"--project={PROJECT}", f"--location={REGION}")
    except subprocess.CalledProcessError as error:
        if not re.search(r"NOT_FOUND|not found|does not exist", error.stderr, re.I):
            raise
        run_or_plan(["artifacts", "repositories", "create", CACHE_REPOSITORY,
            f"--project={PROJECT}", f"--location={REGION}", "--repository-format=docker",
            "--description=Private disposable Nova build caches"], apply)
    run_or_plan(["artifacts", "repositories", "add-iam-policy-binding", CACHE_REPOSITORY,
        f"--project={PROJECT}", f"--location={REGION}",
        f"--member=serviceAccount:{BUILD_ACCOUNT}", "--role=roles/artifactregistry.writer"], apply)
    with tempfile.TemporaryDirectory(prefix="nova-cache-policy-") as directory:
        policy_file = Path(directory) / "cleanup.json"
        policy_file.write_text(json.dumps([{"name": "expire-build-caches", "action": {"type": "Delete"},
            "condition": {"tagState": "any", "olderThan": "1209600s"}}]))
        print("Registry cache policy: " + policy_file.read_text())
        run_or_plan(["artifacts", "repositories", "set-cleanup-policies", CACHE_REPOSITORY,
            f"--project={PROJECT}", f"--location={REGION}",
            f"--policy={policy_file}", "--no-dry-run"], apply)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("operation", choices=("check", "media", "scheduler", "job", "cache"))
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--job", choices=tuple(JOBS))
    parser.add_argument("--image")
    args = parser.parse_args()
    if args.operation == "check":
        if args.apply:
            parser.error("check is always read only")
        media(False, check=True)
        scheduler(False, check=True)
    elif args.operation == "job":
        if args.job is None or args.image is None:
            parser.error("job requires --job and --image")
        run_or_plan(job_arguments(args.job, args.image), args.apply)
    else:
        {"media": media, "scheduler": scheduler, "cache": cache}[args.operation](args.apply)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, subprocess.CalledProcessError, urllib.error.URLError) as error:
        # Never print access-token responses or authorization headers.
        detail = error.stderr if isinstance(error, subprocess.CalledProcessError) else str(error)
        raise SystemExit(detail)
