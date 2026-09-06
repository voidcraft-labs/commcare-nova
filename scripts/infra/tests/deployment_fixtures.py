"""External-boundary fixtures for the real deployment and admission code."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import sys
import urllib.error

ROOT = Path(__file__).resolve().parents[3]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


deploy = load("nova_deploy", "scripts/rollout/deploy-cloud-run.py")
gate = load("nova_migration_gate", "scripts/rollout/migration-gate.py")
IMAGE = "us-central1-docker.pkg.dev/commcare-nova/repo/app@sha256:" + "a" * 64
JOB = "projects/commcare-nova/locations/us-central1/jobs/commcare-nova-migrate"
EXECUTION = JOB + "/executions/run-1"
OPERATION = "projects/commcare-nova/locations/us-central1/operations/run-1"


def job_fixture():
    # Independent API facts. Deriving these from JOB_TEMPLATE_CONTRACTS would
    # let an accidental authority or budget change update both sides.
    return {
        "name": JOB, "generation": "3", "observedGeneration": "3",
        "reconciling": False, "terminalCondition": {"state": "CONDITION_SUCCEEDED"},
        "etag": "generation-3",
        "template": {"taskCount": 1, "parallelism": 1, "template": {
            "containers": [{
                "image": IMAGE, "command": ["node"], "args": ["migrate.cjs"],
                "env": [{"name": key, "value": value} for key, value in {
                    "NOVA_DB_WORKLOAD": "migration",
                    "NOVA_DB_USER": "nova-migrate@commcare-nova.iam",
                    "NOVA_DB_INSTANCE_CONNECTION_NAME": "commcare-nova:us-central1:nova-cases",
                    "NOVA_DB_NAME": "nova_cases",
                    "NOVA_MIGRATION_DB_USER": "nova-migrate@commcare-nova.iam",
                    "NOVA_RUNTIME_DB_USER": "commcare-nova@commcare-nova.iam",
                    "NOVA_CAPTURE_CLEANUP_DB_USER": "nova-capture-cleanup@commcare-nova.iam",
                    "NOVA_AUDIT_DB_USER": "nova-audit@commcare-nova.iam",
                    "NODE_OPTIONS": "--max-old-space-size=7168",
                }.items()],
                "resources": {"limits": {"cpu": "4", "memory": "8Gi"}},
            }],
            "serviceAccount": "nova-migrate@commcare-nova.iam.gserviceaccount.com",
            "maxRetries": 0, "timeout": "3000s",
            "vpcAccess": {"egress": "PRIVATE_RANGES_ONLY", "networkInterfaces": [
                {"network": "default", "subnetwork": "default"},
            ]},
        }},
    }


def execution_fixture(image=IMAGE):
    task = copy.deepcopy(job_fixture()["template"]["template"])
    del task["vpcAccess"]  # Omitted by the Execution API, present on the Job.
    task["containers"][0]["image"] = image
    return {
        "name": EXECUTION, "job": "commcare-nova-migrate", "template": task,
        "taskCount": 1, "parallelism": 1, "succeededCount": 1,
        "completionTime": "2026-09-05T08:00:00Z",
    }


def completed_job_fixture():
    job = job_fixture()
    job["latestCreatedExecution"] = {
        "name": "run-1", "completionTime": "2026-09-05T08:00:00Z",
        "completionStatus": "EXECUTION_SUCCEEDED",
    }
    return job


def http_responses(*values):
    return [
        value if isinstance(value, BaseException) else io.BytesIO(json.dumps(value).encode())
        for value in values
    ]


def http_error(status):
    return urllib.error.HTTPError(
        "https://run.googleapis.com/v2/" + JOB, status, "fixture error", {},
        io.BytesIO(b'{"error":"fixture response"}'),
    )


def requests(mock):
    return [call.args[0] for call in mock.call_args_list]
