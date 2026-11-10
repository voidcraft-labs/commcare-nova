"""Policy tests cross the real JSON/HTTP boundary without contacting Google."""
import base64
import copy
from contextlib import redirect_stdout
import io
import json
import unittest
import urllib.error
from unittest.mock import patch

from deployment_fixtures import (
    deploy, gate, IMAGE, JOB, EXECUTION, OPERATION, job_fixture,
    completed_job_fixture, execution_fixture, http_responses, http_error, requests,
)


class JobExecutionTests(unittest.TestCase):
    def execute(self):
        return deploy._execute_job_exact(
            project="commcare-nova", region="us-central1", job="commcare-nova-migrate",
            expected_image=IMAGE, execution_args=[], wait_seconds=10,
        )

    def test_completed_execution_uses_etag_and_exact_immutable_snapshot(self):
        execution = execution_fixture()
        with patch.object(deploy, "_access_token", return_value="synthetic"), patch(
            "urllib.request.urlopen", side_effect=http_responses(
                job_fixture(), {"name": OPERATION}, {"done": True, "response": execution}, execution,
            ),
        ) as http:
            self.assertEqual(self.execute(), execution)
        sent = requests(http)
        self.assertEqual([request.get_method() for request in sent], ["GET", "POST", "GET", "GET"])
        self.assertEqual(sent[1].full_url, "https://run.googleapis.com/v2/" + JOB + ":run")
        self.assertEqual(json.loads(sent[1].data), {"etag": "generation-3"})
        self.assertEqual(sent[1].get_header("Content-type"), "application/json")
        self.assertEqual(sent[1].get_header("Authorization"), "Bearer synthetic")
        self.assertEqual(sent[-1].full_url, "https://run.googleapis.com/v2/" + EXECUTION)

    def test_job_drift_refuses_before_any_execution_request(self):
        mutations = {
            "image": lambda job: job["template"]["template"]["containers"][0].update(image=IMAGE.replace("a" * 64, "b" * 64)),
            "authority": lambda job: job["template"]["template"].update(serviceAccount="wrong@example.com"),
            "environment": lambda job: job["template"]["template"]["containers"][0]["env"][0].update(value="wrong-database"),
            "network": lambda job: job["template"]["template"]["vpcAccess"].update(egress="ALL_TRAFFIC"),
            "missing-network": lambda job: job["template"]["template"].pop("vpcAccess"),
            "generation": lambda job: job.update(generation="4"),
            "retries": lambda job: job["template"]["template"].update(maxRetries=1),
            "cpu": lambda job: job["template"]["template"]["containers"][0]["resources"]["limits"].update(cpu="1"),
            "command": lambda job: job["template"]["template"]["containers"][0].update(command=["sh"]),
            "args": lambda job: job["template"]["template"]["containers"][0].update(args=["unexpected.cjs"]),
            "task-count": lambda job: job["template"].update(taskCount=2),
        }
        for name, mutate in mutations.items():
            job = job_fixture()
            mutate(job)
            with self.subTest(name=name), patch.object(deploy, "_access_token", return_value="synthetic"), patch(
                "urllib.request.urlopen", side_effect=http_responses(job),
            ) as http:
                with self.assertRaises(deploy.DeploymentPolicyError):
                    self.execute()
                self.assertEqual([request.get_method() for request in requests(http)], ["GET"])

    def test_post_is_sent_once_for_http_and_transport_failures(self):
        for error in (http_error(503), urllib.error.URLError("connection lost"), TimeoutError("timeout")):
            with self.subTest(error=type(error)), patch.object(deploy, "_access_token", return_value="synthetic"), patch(
                "urllib.request.urlopen", side_effect=http_responses(job_fixture(), error),
            ) as http:
                with self.assertRaises(deploy.TerminalDeploymentPolicyError):
                    self.execute()
                self.assertEqual([request.get_method() for request in requests(http)], ["GET", "POST"])
                self.assertEqual(json.loads(requests(http)[1].data), {"etag": "generation-3"})

    def test_transient_reads_retry_without_repeating_the_execution_post(self):
        execution = execution_fixture()
        with patch.object(deploy, "_access_token", return_value="synthetic"), patch(
            "urllib.request.urlopen", side_effect=http_responses(
                http_error(503), job_fixture(), {"name": OPERATION},
                http_error(429), {"done": True, "response": execution},
                urllib.error.URLError("connection reset"), execution,
            ),
        ) as http, patch.object(deploy.time, "sleep") as sleep:
            self.assertEqual(self.execute(), execution)
        self.assertEqual([request.get_method() for request in requests(http)], ["GET", "GET", "POST", "GET", "GET", "GET", "GET"])
        self.assertEqual(sleep.call_count, 3)

    def test_authorization_failure_is_terminal_without_sleep_or_write(self):
        with patch.object(deploy, "_access_token", return_value="synthetic"), patch(
            "urllib.request.urlopen", side_effect=http_responses(http_error(403)),
        ) as http, patch.object(deploy.time, "sleep") as sleep:
            with self.assertRaises(deploy.TerminalDeploymentPolicyError):
                self.execute()
        self.assertEqual([request.get_method() for request in requests(http)], ["GET"])
        sleep.assert_not_called()

    def test_polling_stops_at_its_deadline(self):
        with patch("urllib.request.urlopen", side_effect=http_responses(http_error(503))) as http, patch.object(
            deploy.time, "monotonic", side_effect=[10, 12],
        ), patch.object(deploy.time, "sleep") as sleep:
            with self.assertRaisesRegex(deploy.DeploymentPolicyError, "Timed out"):
                deploy._wait_for("read", lambda: deploy._run_api_request("synthetic", "GET", JOB), timeout_seconds=1)
        self.assertEqual(len(requests(http)), 1)
        sleep.assert_not_called()

    def test_immutable_execution_failures_never_count_as_success_or_poll_again(self):
        for mutation in (
            {"failedCount": 1}, {"cancelledCount": 1}, {"succeededCount": 0},
            {"name": "projects/foreign/locations/r/jobs/other/executions/run-1"},
        ):
            execution = {**execution_fixture(), **mutation}
            with self.subTest(mutation=mutation), patch.object(deploy, "_access_token", return_value="synthetic"), patch(
                "urllib.request.urlopen", side_effect=http_responses(
                    job_fixture(), {"name": OPERATION}, {"done": True, "response": execution}, execution,
                ),
            ) as http, patch.object(deploy.time, "sleep") as sleep:
                with self.assertRaises(deploy.TerminalDeploymentPolicyError):
                    self.execute()
                self.assertEqual(len(requests(http)), 4)
                sleep.assert_not_called()

    def test_execution_vpc_is_optional_but_if_present_must_match(self):
        execution = execution_fixture()
        self.assertEqual(deploy._assert_exact_execution_succeeded(execution, JOB, IMAGE, ["migrate.cjs"]), execution)
        execution["template"]["vpcAccess"] = {"egress": "ALL_TRAFFIC"}
        with self.assertRaises(deploy.TerminalDeploymentPolicyError):
            deploy._assert_exact_execution_succeeded(execution, JOB, IMAGE, ["migrate.cjs"])

    def test_override_operations_are_exact_and_default_to_scan(self):
        operations = [
            ("commcare-nova-historical-repair", ["case-expression-index-scan.cjs"]),
            ("commcare-nova-historical-repair", ["case-expression-index-retirement.cjs", "--scan-digest", "a" * 64, "--writers-stopped"]),
            ("commcare-nova-legacy-preplan-repair", ["legacy-preplan-repair.cjs", "--execute"]),
            ("commcare-nova-case-type-schema-retirement", ["schema-drift.cjs", "--execute", "--app", "app_123"]),
            ("commcare-nova-case-parent-relationship-repair",
             ["case-parent-relationship-repair.cjs", "--execute", "--confirm-old-revision-drained", "--app", "app_123"]),
        ]
        self.assertEqual(deploy._effective_execution_args(JOB, []), ("migrate.cjs",))
        for name, args in operations:
            self.assertEqual(deploy._effective_execution_args(name, args), tuple(args))
        for args in (["arbitrary.cjs"], ["migrate.cjs", "--terminate-runtime-sessions-only"], ["migrate.cjs", "--finalize-better-auth-17"]):
            with self.assertRaises(deploy.DeploymentPolicyError):
                deploy._effective_execution_args(JOB, args)

    def test_index_retirement_requires_digest_and_stopped_writer_assertion(self):
        for args in (
            ["case-expression-index-retirement.cjs"],
            ["case-expression-index-retirement.cjs", "--scan-digest", "a" * 64],
            ["case-expression-index-retirement.cjs", "--scan-digest", "not-a-digest", "--writers-stopped"],
            ["case-expression-index-retirement.cjs", "--scan-digest", "a" * 64, "--writers-stopped", "--extra"],
        ):
            with self.assertRaises(deploy.DeploymentPolicyError):
                deploy._effective_execution_args("commcare-nova-historical-repair", args)

    def test_choice_repair_preserves_plan_and_execute_intent_through_the_job_fence(self):
        name = "commcare-nova-historical-repair"
        job_name = JOB.rsplit("/", 1)[0] + "/" + name
        encoded = base64.b64encode(b'[{"appId":"reviewed-app"}]').decode()
        for args in (
            ["conversation-source-scan.cjs", "--bucket", "synthetic-media"],
            ["conversation-source-cutover.cjs", "--scan-digest", "c" * 64, "--bucket", "synthetic-media"],
            ["conversation-source-cutover.cjs", "--scan-digest", "c" * 64, "--bucket", "synthetic-media", "--execute"],
            ["thread-storage-scan.cjs"],
            ["thread-storage-cutover.cjs", "--scan-digest", "b" * 64],
            ["thread-storage-cutover.cjs", "--scan-digest", "b" * 64, "--execute"],
            ["select-starting-value-scan.cjs"],
            ["select-starting-value-scan.cjs", "--app", "app_123"],
            ["select-starting-value-repair.cjs", "--plan-base64", encoded],
            ["select-starting-value-repair.cjs", "--plan-base64", encoded, "--execute"],
        ):
            job = job_fixture()
            job["name"] = job_name
            job["template"]["template"]["containers"][0]["args"] = ["language-identity-repair.cjs"]
            execution = execution_fixture()
            execution["name"] = job_name + "/executions/run-1"
            execution["job"] = name
            execution["template"]["containers"][0]["args"] = args
            with self.subTest(args=args), patch.object(deploy, "_access_token", return_value="synthetic"), patch(
                "urllib.request.urlopen", side_effect=http_responses(
                    job, {"name": OPERATION}, {"done": True, "response": execution}, execution,
                ),
            ) as http:
                self.assertEqual(deploy._execute_job_exact(
                    project="commcare-nova", region="us-central1", job=name,
                    expected_image=IMAGE, execution_args=args, wait_seconds=10,
                ), execution)
            sent = requests(http)
            self.assertEqual([request.get_method() for request in sent], ["GET", "POST", "GET", "GET"])
            self.assertEqual(sent[1].full_url, "https://run.googleapis.com/v2/" + job_name + ":run")
            self.assertEqual(json.loads(sent[1].data), {
                "etag": "generation-3", "overrides": {"containerOverrides": [{"args": args}]},
            })

    def test_choice_repair_refuses_missing_plans_extra_flags_and_other_jobs(self):
        encoded = base64.b64encode(b'[{"appId":"reviewed-app"}]').decode()
        for args in (
            ["conversation-source-scan.cjs", "--bucket", "synthetic-media", "--execute"],
            ["conversation-source-cutover.cjs", "--scan-digest", "bad", "--bucket", "synthetic-media", "--execute"],
            ["conversation-source-cutover.cjs", "--scan-digest", "c" * 64, "--bucket", "synthetic-media", "--execute", "--extra"],
            ["thread-storage-scan.cjs", "--execute"],
            ["thread-storage-cutover.cjs", "--execute"],
            ["thread-storage-cutover.cjs", "--scan-digest", "not-a-digest"],
            ["thread-storage-cutover.cjs", "--scan-digest", "b" * 64, "--execute", "--extra"],
            ["select-starting-value-scan.cjs", "--execute"],
            ["select-starting-value-scan.cjs", "--app", "../app"],
            ["select-starting-value-repair.cjs", "--execute"],
            ["select-starting-value-repair.cjs", "--plan", "/tmp/plan.json", "--execute"],
            ["select-starting-value-repair.cjs", "--plan-base64", ""],
            ["select-starting-value-repair.cjs", "--plan-base64", "not base64"],
            ["select-starting-value-repair.cjs", "--plan-base64", encoded, "--execute", "--extra"],
        ):
            with self.subTest(args=args), self.assertRaises(deploy.DeploymentPolicyError):
                deploy._effective_execution_args("commcare-nova-historical-repair", args)
        with self.assertRaises(deploy.DeploymentPolicyError):
            deploy._effective_execution_args(JOB, ["select-starting-value-repair.cjs", "--plan-base64", encoded, "--execute"])


class MigrationAdmissionTests(unittest.TestCase):
    def admit(self, image=IMAGE):
        return gate.admit_migration(
            project="commcare-nova", region="us-central1", job="commcare-nova-migrate",
            image=image, wait_seconds=10,
        )

    def test_identical_successful_artifact_uses_only_read_evidence(self):
        job, execution = completed_job_fixture(), execution_fixture()
        with patch.object(gate.policy, "_access_token", return_value="synthetic"), patch(
            "urllib.request.urlopen", side_effect=http_responses(job, execution, job),
        ) as http:
            result = self.admit()
        self.assertEqual(result, {"mode": "reused", "image": IMAGE, "execution": EXECUTION})
        self.assertEqual([request.get_method() for request in requests(http)], ["GET", "GET", "GET"])

    def test_job_or_latest_execution_change_refuses_cached_success(self):
        for change in ("etag", "latest"):
            job = completed_job_fixture()
            after = copy.deepcopy(job)
            if change == "etag":
                after["etag"] = "generation-4"
            else:
                after["latestCreatedExecution"]["name"] = "run-2"
            with self.subTest(change=change), patch.object(gate.policy, "_access_token", return_value="synthetic"), patch(
                "urllib.request.urlopen", side_effect=http_responses(job, execution_fixture(), after),
            ) as http:
                with self.assertRaises(gate.policy.TerminalDeploymentPolicyError):
                    self.admit()
                self.assertEqual([request.get_method() for request in requests(http)], ["GET", "GET", "GET"])

    def test_changed_artifact_patches_with_etag_and_then_executes_the_new_snapshot(self):
        job = completed_job_fixture()
        job.update(labels={"team": "nova"}, annotations={"example.com/owner": "deployment"},
                   binaryAuthorization={"useDefault": True}, startExecutionToken="never-replay-this")
        image = IMAGE.replace("a" * 64, "b" * 64)
        updated = copy.deepcopy(job)
        updated["template"]["template"]["containers"][0]["image"] = image
        updated["etag"] = "generation-4"
        execution = execution_fixture(image)
        with patch.object(gate.policy, "_access_token", return_value="synthetic"), patch(
            "urllib.request.urlopen", side_effect=http_responses(
                job, {}, updated, updated, {"name": OPERATION}, {"done": True, "response": execution}, execution,
            ),
        ) as http:
            self.assertEqual(self.admit(image), {"mode": "executed", "image": image, "execution": EXECUTION})
        sent = requests(http)
        self.assertEqual([request.get_method() for request in sent], ["GET", "PATCH", "GET", "GET", "POST", "GET", "GET"])
        update = json.loads(sent[1].data)
        self.assertEqual(update, {
            "name": JOB, "etag": "generation-3", "template": updated["template"],
            "labels": {"team": "nova"}, "annotations": {"example.com/owner": "deployment"},
            "binaryAuthorization": {"useDefault": True},
        })
        self.assertEqual(sent[1].full_url, "https://run.googleapis.com/v2/" + JOB)
        self.assertEqual(json.loads(sent[4].data), {"etag": "generation-4"})

    def test_patch_failure_never_retries_or_executes_the_job(self):
        with patch.object(gate.policy, "_access_token", return_value="synthetic"), patch(
            "urllib.request.urlopen", side_effect=http_responses(completed_job_fixture(), http_error(503)),
        ) as http:
            with self.assertRaises(gate.policy.TerminalDeploymentPolicyError):
                self.admit(IMAGE.replace("a" * 64, "b" * 64))
        self.assertEqual([request.get_method() for request in requests(http)], ["GET", "PATCH"])

    def test_failed_or_pruned_execution_requires_an_actual_new_execution(self):
        failed = execution_fixture()
        failed.update(succeededCount=0, failedCount=1)
        for prior in (failed, http_error(404)):
            execution = execution_fixture()
            execution["name"] = JOB + "/executions/run-2"
            with self.subTest(prior=type(prior)), patch.object(gate.policy, "_access_token", return_value="synthetic"), patch(
                "urllib.request.urlopen", side_effect=http_responses(
                    completed_job_fixture(), prior, job_fixture(), {"name": OPERATION},
                    {"done": True, "response": execution}, execution,
                ),
            ) as http:
                result = self.admit()
            self.assertEqual(result["mode"], "executed")
            self.assertEqual(result["execution"], JOB + "/executions/run-2")
            self.assertEqual([request.get_method() for request in requests(http)], ["GET", "GET", "GET", "POST", "GET", "GET"])

    def test_active_different_artifact_is_not_overwritten(self):
        job = completed_job_fixture()
        del job["latestCreatedExecution"]["completionTime"]
        execution = execution_fixture()
        del execution["completionTime"]
        with patch.object(gate.policy, "_access_token", return_value="synthetic"), patch(
            "urllib.request.urlopen", side_effect=http_responses(job, execution),
        ) as http:
            with self.assertRaises(gate.policy.DeploymentPolicyError):
                self.admit(IMAGE.replace("a" * 64, "b" * 64))
        self.assertEqual([request.get_method() for request in requests(http)], ["GET", "GET"])

    def test_active_same_artifact_is_joined_and_rechecked_without_another_post(self):
        job = completed_job_fixture()
        del job["latestCreatedExecution"]["completionTime"]
        active = execution_fixture()
        del active["completionTime"]
        complete = execution_fixture()
        with patch.object(gate.policy, "_access_token", return_value="synthetic"), patch(
            "urllib.request.urlopen", side_effect=http_responses(job, active, active, complete, job),
        ) as http, patch.object(gate.policy.time, "sleep"):
            self.assertEqual(self.admit(), {"mode": "reused", "image": IMAGE, "execution": EXECUTION})
        self.assertEqual([request.get_method() for request in requests(http)], ["GET"] * 5)


SERVICE = "projects/commcare-nova/locations/us-central1/services/commcare-nova"
OLD = SERVICE + "/revisions/old"
CANDIDATE = SERVICE + "/revisions/new"
UNUSED = SERVICE + "/revisions/unused"


def service_fixture(revision=OLD):
    return {
        "name": SERVICE, "latestReadyRevision": revision, "latestCreatedRevision": revision,
        "terminalCondition": {"state": "CONDITION_SUCCEEDED"}, "reconciling": False,
        "scaling": {"scalingMode": "AUTOMATIC", "minInstanceCount": 1, "maxInstanceCount": 4},
        "traffic": [{"revision": revision, "percent": 100}],
        "trafficStatuses": [{"revision": revision, "percent": 100}],
    }


class ServicePolicyTests(unittest.TestCase):
    def test_automatic_scaling_requires_canonical_bounds_and_no_manual_override(self):
        deploy.assert_scaling(service_fixture(), "automatic", expected_min=1, expected_max=4)
        for scaling in (
            {"scalingMode": "MANUAL", "manualInstanceCount": 0},
            {"scalingMode": "MANUAL", "manualInstanceCount": 1},
            {"scalingMode": "AUTOMATIC", "manualInstanceCount": 1},
            {"scalingMode": "AUTOMATIC"},
            {"scalingMode": "AUTOMATIC", "minInstanceCount": True, "maxInstanceCount": 4},
            {"scalingMode": "AUTOMATIC", "minInstanceCount": "01", "maxInstanceCount": 4},
            {"scalingMode": "AUTOMATIC", "minInstanceCount": 1, "maxInstanceCount": 5},
        ):
            with self.subTest(scaling=scaling), self.assertRaises(deploy.DeploymentPolicyError):
                deploy.assert_scaling({"scaling": scaling}, "automatic", expected_min=1, expected_max=4)

    def test_latest_and_short_revision_traffic_resolve_to_the_same_candidate(self):
        service = service_fixture(CANDIDATE)
        service["traffic"] = [{"type": "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", "percent": 100},
                              {"revision": "old", "percent": 0}]
        deploy.assert_candidate_traffic(service, CANDIDATE)
        service["traffic"] = [{"revision": "new", "percent": 100}]
        deploy.assert_candidate_traffic(service, CANDIDATE)

    def test_observed_latest_traffic_is_owned_by_the_revision_it_names(self):
        # Cloud Run's observed status names the revision serving a LATEST target.
        service = service_fixture(CANDIDATE)
        service["traffic"] = [{"type": "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", "percent": 100}]
        service["trafficStatuses"] = [
            {"type": "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", "revision": "new", "percent": 100},
        ]
        deploy.assert_candidate_traffic(service, CANDIDATE)
        # Observed traffic still on the previous revision is not the candidate's,
        # even while latestReadyRevision already names the candidate.
        service["trafficStatuses"] = [
            {"type": "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", "revision": "old", "percent": 100},
        ]
        with self.assertRaises(deploy.DeploymentPolicyError):
            deploy.assert_candidate_traffic(service, CANDIDATE)

    def test_traffic_targets_with_unknown_types_or_malformed_revisions_are_refused(self):
        for target in (
            {"type": "TRAFFIC_TARGET_ALLOCATION_TYPE_SPLIT", "revision": "new", "percent": 100},
            {"type": "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION", "percent": 100},
            {"type": "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", "revision": 7, "percent": 100},
        ):
            service = service_fixture(CANDIDATE)
            service["trafficStatuses"] = [target]
            with self.subTest(target=target), self.assertRaises(deploy.DeploymentPolicyError):
                deploy.assert_candidate_traffic(service, CANDIDATE)

    def test_both_desired_and_observed_traffic_must_fully_belong_to_untagged_candidate(self):
        for field in ("traffic", "trafficStatuses"):
            for targets in (
                [{"revision": CANDIDATE, "percent": 100, "tag": "preview"}],
                [{"revision": CANDIDATE, "percent": 99}, {"revision": OLD, "percent": 1}],
                [{"revision": CANDIDATE, "percent": 101}],
                [{"revision": CANDIDATE, "percent": True}],
                [],
            ):
                service = service_fixture(CANDIDATE)
                service[field] = targets
                with self.subTest(field=field, targets=targets), self.assertRaises(deploy.DeploymentPolicyError):
                    deploy.assert_candidate_traffic(service, CANDIDATE)

    def test_only_unused_untagged_revisions_may_disappear_and_exactly_one_candidate_may_appear(self):
        before = service_fixture()
        self.assertEqual(deploy.assert_revision_transition(
            before_service=before, before_revisions=frozenset([OLD, UNUSED]),
            after_revisions=frozenset([OLD, CANDIDATE]), expected_additions=frozenset([CANDIDATE]),
        ), frozenset([UNUSED]))
        for after in (frozenset([CANDIDATE]), frozenset([OLD, CANDIDATE, UNUSED]), frozenset([OLD])):
            with self.assertRaises(deploy.DeploymentPolicyError):
                deploy.assert_revision_transition(
                    before_service=before, before_revisions=frozenset([OLD]),
                    after_revisions=after, expected_additions=frozenset([CANDIDATE]),
                )
        before["trafficStatuses"].append({"revision": UNUSED, "percent": 0, "tag": "kept"})
        with self.assertRaises(deploy.DeploymentPolicyError):
            deploy.assert_revision_transition(
                before_service=before, before_revisions=frozenset([OLD, UNUSED]),
                after_revisions=frozenset([OLD, CANDIDATE]), expected_additions=frozenset([CANDIDATE]),
            )

    def test_mutable_images_and_policy_overrides_refuse_before_accessing_google(self):
        arguments = ["--project=commcare-nova", "--region=us-central1", "--service=commcare-nova",
                     "--expected-min=1", "--expected-max=4"]
        with patch("subprocess.run") as process, patch("urllib.request.urlopen") as http:
            for image in ("registry/app:latest", "registry/app@sha256:" + "g" * 64):
                with self.assertRaises(deploy.DeploymentPolicyError):
                    deploy.main([*arguments, "--image=" + image])
            for override in ("--scaling=auto", "--image=other", "--no-traffic", "--tag=preview", "--project=other", "--region=other"):
                with self.subTest(override=override), self.assertRaises(deploy.DeploymentPolicyError):
                    deploy.main([*arguments, "--image=" + IMAGE, "--", override])
            process.assert_not_called()
            http.assert_not_called()

    def test_deploy_executes_once_and_verifies_the_new_ready_image_and_traffic(self):
        import subprocess
        candidate = {
            "spec": {"containers": [{"image": IMAGE}]},
            "status": {"imageDigest": IMAGE, "conditions": [{"type": "Ready", "status": "True"}]},
        }

        def gcloud(command, **kwargs):
            output = "synthetic" if command[1:3] == ["auth", "print-access-token"] else json.dumps(candidate)
            return subprocess.CompletedProcess(command, 0, stdout=output)

        with patch("subprocess.run", side_effect=gcloud) as process, patch(
            "urllib.request.urlopen", side_effect=http_responses(
                service_fixture(), {"revisions": [{"name": OLD}]},
                service_fixture(CANDIDATE), {"revisions": [{"name": OLD}, {"name": CANDIDATE}]},
            ),
        ) as http, redirect_stdout(io.StringIO()) as output:
            deploy.main(["--project=commcare-nova", "--region=us-central1", "--service=commcare-nova",
                         "--expected-min=1", "--expected-max=4", "--image=" + IMAGE, "--", "--timeout=3600s"])
        commands = [call.args[0] for call in process.call_args_list]
        self.assertEqual([command[1:3] for command in commands], [
            ["auth", "print-access-token"], ["run", "deploy"], ["run", "revisions"],
        ])
        self.assertIn("--image=" + IMAGE, commands[1])
        self.assertIn("--timeout=3600s", commands[1])
        self.assertEqual([request.get_method() for request in requests(http)], ["GET"] * 4)
        report = json.loads(output.getvalue().split("NOVA_DEPLOY_RESULT=")[1])
        self.assertEqual(report, {"candidateRevision": CANDIDATE, "image": IMAGE, "finalScaling": "automatic"})

    def test_disabled_release_proves_candidate_before_etag_fenced_resume(self):
        import subprocess
        for failure in (None, "image", "traffic", "etag"):
            with self.subTest(failure=failure):
                before = service_fixture()
                installed = service_fixture(CANDIDATE)
                for service in (before, installed):
                    service["scaling"].update(scalingMode="MANUAL", manualInstanceCount=0)
                    service["etag"] = "disabled-candidate"
                if failure == "traffic":
                    installed["trafficStatuses"] = [{"revision": OLD, "percent": 100}]
                fact = {"spec": {"containers": [{"image": IMAGE}]}, "status": {
                    "imageDigest": IMAGE if failure != "image" else IMAGE.replace("a" * 64, "b" * 64),
                    "conditions": [{"type": "Ready", "status": "True"}],
                }}
                observed = []
                def gcloud(command, **kwargs):
                    observed.append(command)
                    output = "synthetic" if command[1:3] == ["auth", "print-access-token"] else json.dumps(fact)
                    return subprocess.CompletedProcess(command, 0, stdout=output)
                responses = http_responses(
                    before, {"revisions": [{"name": OLD}]}, installed,
                    {"revisions": [{"name": OLD}, {"name": CANDIDATE}]},
                    *([http_error(409)] if failure == "etag" else []),
                    *([{"name": OPERATION}, service_fixture(CANDIDATE),
                       {"revisions": [{"name": OLD}, {"name": CANDIDATE}]}] if failure is None else []),
                )
                def respond(request, **kwargs):
                    observed.append(request.get_method())
                    value = responses.pop(0)
                    if isinstance(value, BaseException):
                        raise value
                    return value
                with patch("subprocess.run", side_effect=gcloud), patch(
                    "urllib.request.urlopen", side_effect=respond,
                ) as http, patch.object(deploy.time, "monotonic", side_effect=[0, 1000]), redirect_stdout(io.StringIO()):
                    arguments = ["--project=commcare-nova", "--region=us-central1", "--service=commcare-nova",
                                 "--expected-min=1", "--expected-max=4", "--expected-scaling=disabled", "--image=" + IMAGE]
                    if failure:
                        with self.assertRaises(deploy.DeploymentPolicyError):
                            deploy.main(arguments)
                    else:
                        deploy.main(arguments)
                commands = [event for event in observed if isinstance(event, list)]
                self.assertIn("--scaling=0", commands[1])
                self.assertFalse(any("--scaling=auto" in command for command in commands))
                writes = [request for request in requests(http) if request.get_method() != "GET"]
                if failure in ("image", "traffic"):
                    self.assertEqual(writes, [])
                else:
                    self.assertEqual(len(writes), 1)
                    self.assertEqual(writes[0].full_url, "https://run.googleapis.com/v2/" + SERVICE + "?updateMask=scaling")
                    self.assertEqual(json.loads(writes[0].data), {
                        "name": SERVICE, "etag": "disabled-candidate",
                        "scaling": {"scalingMode": "AUTOMATIC", "minInstanceCount": 1, "maxInstanceCount": 4},
                    })
                    image_check = next(i for i, event in enumerate(observed) if isinstance(event, list) and event[1:3] == ["run", "revisions"])
                    self.assertLess(image_check, observed.index("PATCH"))

    def test_disabled_service_requires_explicit_release_mode_and_has_no_tag_escape(self):
        before = service_fixture()
        before["scaling"].update(scalingMode="MANUAL", manualInstanceCount=0)
        for explicit in (False, True):
            if explicit:
                before["trafficStatuses"][0]["tag"] = "old"
            with self.subTest(explicit=explicit), patch.object(deploy, "_access_token", return_value="synthetic"), patch(
                "urllib.request.urlopen", side_effect=http_responses(before),
            ) as http, patch("subprocess.run") as process:
                with self.assertRaises(deploy.DeploymentPolicyError):
                    deploy.main(["--read-scaling-prestate", "--project=commcare-nova", "--region=us-central1", "--service=commcare-nova",
                                 *(["--expected-scaling=disabled"] if explicit else [])])
                process.assert_not_called()
                self.assertEqual([request.get_method() for request in requests(http)], ["GET"])

    def test_candidate_proof_rejects_a_wrong_digest_repository_or_readiness(self):
        import subprocess
        for change in ("digest", "repository", "ready"):
            fact = {"spec": {"containers": [{"image": IMAGE}]},
                    "status": {"imageDigest": IMAGE, "conditions": [{"type": "Ready", "status": "True"}]}}
            if change == "digest":
                fact["status"]["imageDigest"] = IMAGE.replace("a" * 64, "b" * 64)
            elif change == "repository":
                fact["spec"]["containers"][0]["image"] = IMAGE.replace("/repo/", "/different/")
            else:
                fact["status"]["conditions"][0]["status"] = "False"
            with self.subTest(change=change), patch("subprocess.run", return_value=subprocess.CompletedProcess(
                ["gcloud"], 0, stdout=json.dumps(fact),
            )), self.assertRaises(deploy.DeploymentPolicyError):
                deploy._candidate_revision_fact(CANDIDATE, "us-central1", "commcare-nova", IMAGE, "sha256:" + "a" * 64)
