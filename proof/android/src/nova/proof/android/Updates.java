package nova.proof.android;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;

import org.commcare.CommCareApplication;
import org.commcare.activities.FormEntryActivity;
import org.commcare.activities.HomeScreenBaseActivity;
import org.commcare.activities.StandardHomeActivity;
import org.commcare.android.database.user.models.FormRecord;
import org.commcare.android.mocks.FormAndDataSyncerFake;
import org.commcare.engine.resource.AppInstallStatus;
import org.commcare.tasks.InstallStagedUpdateTask;
import org.commcare.tasks.ResultAndError;
import org.commcare.tasks.TaskListener;
import org.commcare.update.UpdateTask;
import org.commcare.utils.RobolectricUtil;
import org.commcare.views.QuestionsView;
import org.commcare.views.widgets.QuestionWidget;
import org.commcare.views.widgets.StringWidget;
import org.json.JSONArray;
import org.json.JSONObject;
import org.robolectric.Robolectric;
import org.robolectric.Shadows;
import org.robolectric.shadows.ShadowActivity;
import org.robolectric.shadows.ShadowLooper;

/**
 * What Android holds after a worker's device updates from one archive of an app to the next: the profile as its
 * readers give it before and after, over a worker's own settings where the request names some, and, where the
 * request names a command ({@code incomplete}), a form the worker saved incomplete before the update and what
 * Android does when the worker reopens it after.
 *
 * The update is the app's own: UpdateTask stages the second archive's profile and InstallStagedUpdateTask
 * installs it, as the project's own update tests run them (UpdateUtils). The incomplete form is saved through
 * FormEntryActivity.saveFormToDisk, which the quit dialog's Save calls, and reopened by handing home the result
 * its incomplete-forms list hands it.
 */
final class Updates {
    private Updates() {
    }

    static JSONObject read(JSONObject request) throws Exception {
        JSONObject found = new JSONObject();
        AppInstallStatus status = Device.install(request.getString("archive"));
        found.put("install", String.valueOf(status));
        if (status != AppInstallStatus.Installed) {
            return found;
        }
        if (request.has("worker")) {
            Device.serve(request.getJSONObject("worker"));
        }
        if (Device.served()) {
            found.put("signIn", Device.signIn());
        } else {
            Device.login();
            if (request.has("restore")) {
                found.put("restore", Device.restore(request.getString("restore")));
            }
        }
        Device.prefer(request.optJSONObject("preferences"));
        // The worker's own settings the request made, by name, so a reader of the answer knows which were theirs.
        java.util.Set<String> own = new java.util.TreeSet<>();
        JSONArray names = request.optJSONObject("preferences") == null ? null
                : request.getJSONObject("preferences").names();
        for (int i = 0; names != null && i < names.length(); i++) {
            own.add(names.getString(i));
        }
        found.put("workerSettings", new JSONArray(own));
        Lists.brief = true;
        found.put("before", Profile.read());
        // The forms a worker left incomplete before the update: the command the request names, or, where it
        // asks for every form (``incompleteForms``), each form the installed suite gives an entry.
        java.util.Map<String, Integer> records = new java.util.LinkedHashMap<>();
        java.util.List<String> commands = new java.util.ArrayList<>();
        if (request.has("incomplete")) {
            commands.add(request.getString("incomplete"));
        }
        if (request.optBoolean("incompleteForms")) {
            for (String command : new java.util.TreeSet<>(
                    CommCareApplication.instance().getCommCarePlatform().getCommandToEntryMap().keySet())) {
                if (CommCareApplication.instance().getCommCarePlatform()
                        .getEntry(command).getXFormNamespace() != null) {
                    commands.add(command);
                }
            }
        }
        JSONObject incomplete = new JSONObject();
        for (String command : commands) {
            JSONObject saved = new JSONObject();
            incomplete.put(command, saved);
            Integer record;
            try {
                record = saveIncomplete(command, saved);
            } catch (Throwable raised) {
                saved.put("raised", Reader.raised(raised));
                record = null;
            }
            if (record != null && !records.containsValue(record)) {
                records.put(command, record);
            }
        }
        if (request.has("incomplete")) {
            found.put("incomplete", incomplete.get(request.getString("incomplete")));
        } else if (!commands.isEmpty()) {
            found.put("incompleteForms", incomplete);
        }

        String reference = Device.archiveReference(request.getString("update"));
        final Object[] staged = new Object[1];
        UpdateTask task = UpdateTask.getNewInstance();
        // An update from an archive, as UpdateActivity starts one (its isLocalUpdate).
        task.setLocalAuthority();
        task.registerTaskListener(new TaskListener<Integer, ResultAndError<AppInstallStatus>>() {
            @Override
            public void handleTaskUpdate(Integer... values) {
            }

            @Override
            public void handleTaskCompletion(ResultAndError<AppInstallStatus> result) {
                staged[0] = result.data;
            }

            @Override
            public void handleTaskCancellation() {
                staged[0] = "cancelled";
            }
        });
        task.execute(reference).get();
        ShadowLooper.idleMainLooper();
        found.put("staged", String.valueOf(staged[0]));
        found.put("updated", String.valueOf(InstallStagedUpdateTask.installStagedUpdate()));
        task.clearTaskInstance();
        found.put("after", Profile.read());

        if (request.has("incomplete")) {
            if (records.containsKey(request.getString("incomplete"))) {
                found.put("reopened", reopen(records.get(request.getString("incomplete"))));
            }
        } else if (!commands.isEmpty()) {
            JSONObject reopened = new JSONObject();
            for (java.util.Map.Entry<String, Integer> entry : records.entrySet()) {
                try {
                    reopened.put(entry.getKey(), reopen(entry.getValue()));
                } catch (Throwable raised) {
                    JSONObject failed = new JSONObject();
                    failed.put("raised", Reader.raised(raised));
                    reopened.put(entry.getKey(), failed);
                }
            }
            found.put("reopened", reopened);
        }
        return found;
    }

    static Integer saveIncomplete(String command, JSONObject saved) throws Exception {
        return save(command, saved, false);
    }

    /**
     * Opens the command's form through home, answers its first screen and saves it: incomplete, as the quit
     * dialog's Save does, or complete, as the end of the form does (FormEntryActivity.triggerUserFormComplete).
     * The incomplete record's id, where the save leaves one.
     */
    static Integer save(String command, JSONObject saved, boolean complete) throws Exception {
        final Integer[] record = new Integer[1];
        java.util.Set<Integer> before = new java.util.HashSet<>();
        for (FormRecord held : CommCareApplication.instance().getUserStorage(FormRecord.class)) {
            before.add(held.getID());
        }
        JSONObject walk = Screens.walk(command, (started, step, shadow) -> {
            FormEntryActivity activity = Forms.open(started);
            step.put("loaded", FormEntryActivity.mFormController != null);
            QuestionsView view = activity.getODKView();
            if (view != null) {
                for (QuestionWidget widget : view.getWidgets()) {
                    if (widget instanceof StringWidget) {
                        ((StringWidget)widget).setAnswer("1");
                    }
                }
            }
            if (complete) {
                java.lang.reflect.Method finish =
                        FormEntryActivity.class.getDeclaredMethod("triggerUserFormComplete");
                finish.setAccessible(true);
                finish.invoke(activity);
            } else {
                activity.saveFormToDisk(true);
            }
            RobolectricUtil.flushBackgroundThread(activity);
            ShadowLooper.idleMainLooper();
            ShadowActivity form = Shadows.shadowOf(activity);
            step.put("finishing", activity.isFinishing());
            step.put("resultCode", form.getResultCode());
            shadow.receiveResult(started, form.getResultCode(), form.getResultIntent());
            ShadowLooper.idleMainLooper();
            return false;
        });
        saved.put("walk", walk);
        saved.put("records", Forms.records());
        for (FormRecord candidate : CommCareApplication.instance().getUserStorage(FormRecord.class)) {
            if (FormRecord.STATUS_INCOMPLETE.equals(candidate.getStatus()) && !before.contains(candidate.getID())) {
                record[0] = candidate.getID();
            }
        }
        return record[0];
    }

    /** What home does with the incomplete record a worker picks from the incomplete-forms list. */
    private static JSONObject reopen(int record) throws Exception {
        JSONObject found = new JSONObject();
        found.put("records", Forms.records());
        // The session Android kept for the record, as it stored it (SessionStateDescriptor): what home loads
        // to open the form again. An id the device drew is written as one.
        for (org.commcare.android.database.user.models.SessionStateDescriptor kept
                : CommCareApplication.instance().getUserStorage(
                org.commcare.android.database.user.models.SessionStateDescriptor.class)) {
            if (kept.getFormRecordId() == record) {
                found.put("SessionStateDescriptor.getSessionDescriptor", kept.getSessionDescriptor().replaceAll(
                        "[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}",
                        "@device-uuid"));
            }
        }
        CommCareApplication.instance().getCurrentSessionWrapper().reset();
        StandardHomeActivity home = Robolectric.buildActivity(StandardHomeActivity.class, null).create().get();
        ShadowLooper.idleMainLooper();
        home.setFormAndDataSyncer(new FormAndDataSyncerFake());
        ShadowActivity shadow = Shadows.shadowOf(home);
        Screens.drain(shadow);
        try {
            home.onActivityResultSessionSafe(HomeScreenBaseActivity.GET_INCOMPLETE_FORM, Activity.RESULT_OK,
                    new Intent().putExtra("FORMRECORDS", record));
            ShadowLooper.idleMainLooper();
        } catch (Throwable raised) {
            found.put("homeRaised", Reader.raised(raised));
            return found;
        }
        Intent started = shadow.getNextStartedActivity();
        if (started == null) {
            found.put("screen", "home");
            found.put("alert", Screens.orNull(Views.alert(home)));
            return found;
        }
        String target = started.getComponent().getClassName();
        found.put("screen", target.substring(target.lastIndexOf('.') + 1));
        if (target.equals(FormEntryActivity.class.getName())) {
            try {
                JSONObject form = new JSONObject();
                found.put("form", form);
                FormEntryActivity activity = Forms.open(started);
                form.put("loaded", FormEntryActivity.mFormController != null);
                form.put("alert", Screens.orNull(Views.alert(activity)));
                if (FormEntryActivity.mFormController != null) {
                    Forms.describe(activity, started, form);
                }
            } catch (Throwable raised) {
                found.put("formEntryRaised", Reader.raised(raised));
            }
        }
        return found;
    }
}
