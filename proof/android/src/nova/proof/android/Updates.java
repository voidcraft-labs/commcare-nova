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
        Device.login();
        if (request.has("restore")) {
            found.put("restore", Device.restore(request.getString("restore")));
        }
        JSONObject preferences = request.optJSONObject("preferences");
        if (preferences != null) {
            SharedPreferences.Editor editor =
                    CommCareApplication.instance().getCurrentApp().getAppPreferences().edit();
            JSONArray names = preferences.names();
            for (int i = 0; names != null && i < names.length(); i++) {
                editor.putString(names.getString(i), preferences.getString(names.getString(i)));
            }
            editor.commit();
        }
        found.put("before", Profile.read());
        Integer record = null;
        if (request.has("incomplete")) {
            JSONObject saved = new JSONObject();
            found.put("incomplete", saved);
            record = saveIncomplete(request.getString("incomplete"), saved);
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

        if (record != null) {
            found.put("reopened", reopen(record));
        }
        return found;
    }

    private static JSONArray records() throws Exception {
        JSONArray found = new JSONArray();
        for (FormRecord record : CommCareApplication.instance().getUserStorage(FormRecord.class)) {
            JSONObject entry = new JSONObject();
            entry.put("status", record.getStatus());
            entry.put("xmlns", record.getFormNamespace());
            entry.put("FormRecord.getDisplayName", Screens.orNull(record.getDisplayName()));
            entry.put("AndroidCommCarePlatform.getFormDefId",
                    CommCareApplication.instance().getCommCarePlatform().getFormDefId(record.getFormNamespace()));
            found.put(entry);
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
        JSONObject walk = Screens.walk(command, null, (started, step, shadow) -> {
            FormEntryActivity activity =
                    Robolectric.buildActivity(FormEntryActivity.class, started).create().start().resume().get();
            RobolectricUtil.flushBackgroundThread(activity);
            ShadowLooper.idleMainLooper();
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
        });
        saved.put("walk", walk);
        saved.put("records", records());
        for (FormRecord candidate : CommCareApplication.instance().getUserStorage(FormRecord.class)) {
            if (FormRecord.STATUS_INCOMPLETE.equals(candidate.getStatus())) {
                record[0] = candidate.getID();
            }
        }
        return record[0];
    }

    /** What home does with the incomplete record a worker picks from the incomplete-forms list. */
    private static JSONObject reopen(int record) throws Exception {
        JSONObject found = new JSONObject();
        found.put("records", records());
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
                Forms.read(started, found);
            } catch (Throwable raised) {
                found.put("formEntryRaised", Reader.raised(raised));
            }
        }
        return found;
    }
}
