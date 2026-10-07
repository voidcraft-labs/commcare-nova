package nova.proof.android;

import android.content.Intent;

import androidx.test.core.app.ApplicationProvider;

import org.commcare.CommCareApp;
import org.commcare.CommCareApplication;
import org.commcare.CommCareTestApp;
import org.commcare.CommCareTestApplication;
import org.commcare.activities.InstallArchiveActivity;
import org.commcare.android.database.global.models.ApplicationRecord;
import org.commcare.android.util.TestAppInstaller;
import org.commcare.engine.resource.AppInstallStatus;
import org.commcare.models.database.user.DemoUserBuilder;
import org.commcare.network.LocalReferencePullResponseFactory;
import org.commcare.tasks.DataPullTask;
import org.commcare.tasks.ResourceEngineTask;
import org.commcare.tasks.ResultAndError;
import org.commcare.utils.RobolectricUtil;
import org.javarosa.core.util.PropertyUtils;
import org.robolectric.Robolectric;
import org.robolectric.Shadows;
import org.robolectric.shadows.ShadowLooper;

import org.commcare.AppUtils;
import org.commcare.activities.FormAndDataSyncer;
import org.commcare.activities.SyncCapableCommCareActivity;
import org.commcare.android.database.user.models.FormRecord;
import org.commcare.models.FormRecordProcessor;
import org.commcare.models.database.SqlStorage;
import org.commcare.utils.StorageUtils;
import org.javarosa.core.model.User;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * The device the reader's observations run on: commcare-android's own application under Robolectric
 * (CommCareTestApplication, the application the project's own tests run), with an archive installed through the
 * app's own archive install and a restore applied through its own data pull.
 *
 * An archive is installed the way a worker installs one from a file: InstallArchiveActivity unzips it (UnzipTask)
 * and registers the folder with the application's ArchiveFileRoot, and a ResourceEngineTask installs the profile
 * that reference names, as CommCareSetupActivity starts one (ResourceInstallUtils.startAppInstallAsync). The task
 * is the project's TestAppInstaller's, with two differences an observation needs: the install status is returned
 * rather than asserted, and the app is not marked as having its media validated, so
 * CommCareApp.areMMResourcesValidated reads what the profile gave it.
 */
final class Device {
    // A name no restore registers: Android keeps one user record a name, and the device's own worker is
    // made at login, before a restore brings the workers it registers.
    static final String USERNAME = "nova-proof-device";
    static final String PASSWORD = "123";
    /** Whether a walk changed what the worker's sandbox holds (a form's cases applied, a claim's sync). */
    static boolean dirty;
    private static String restorePath;
    private static String restoreReference;

    private Device() {
    }

    static CommCareTestApplication application() {
        return (CommCareTestApplication)CommCareApplication.instance();
    }

    /** The reference InstallArchiveActivity hands back for the archive at {@code path}, unzipped by the app. */
    static String archiveReference(String path) {
        Intent intent = new Intent(ApplicationProvider.getApplicationContext(), InstallArchiveActivity.class);
        intent.putExtra(InstallArchiveActivity.ARCHIVE_FILEPATH, path);
        InstallArchiveActivity activity =
                Robolectric.buildActivity(InstallArchiveActivity.class, intent).setup().get();
        RobolectricUtil.flushBackgroundThread(activity);
        ShadowLooper.idleMainLooper();
        Intent result = Shadows.shadowOf(activity).getResultIntent();
        if (result == null || !result.hasExtra(InstallArchiveActivity.ARCHIVE_JR_REFERENCE)) {
            throw new IllegalStateException("Android's archive install did not unzip " + path
                    + ": InstallArchiveActivity returned no archive reference.");
        }
        return result.getStringExtra(InstallArchiveActivity.ARCHIVE_JR_REFERENCE);
    }

    /** Installs the archive at {@code path} as a new app and returns Android's install status. */
    static AppInstallStatus install(String path) {
        String reference = archiveReference(path);
        ApplicationRecord record = new ApplicationRecord(PropertyUtils.genUUID().replace("-", ""),
                ApplicationRecord.STATUS_UNINITIALIZED);
        CommCareApp app = new CommCareTestApp(new CommCareApp(record));
        final AppInstallStatus[] status = new AppInstallStatus[1];
        final Exception[] failure = new Exception[1];
        ResourceEngineTask<Object> task = new ResourceEngineTask<Object>(app, -1, false, false) {
            @Override
            protected void deliverResult(Object receiver, AppInstallStatus result) {
                status[0] = result;
            }

            @Override
            protected void deliverUpdate(Object receiver, int[]... update) {
            }

            @Override
            protected void deliverError(Object receiver, Exception e) {
                failure[0] = e;
            }
        };
        task.connect(TestAppInstaller.fakeConnector);
        try {
            task.execute(reference).get();
        } catch (Exception e) {
            throw new IllegalStateException("Android's install task did not finish for " + path, e);
        }
        ShadowLooper.idleMainLooper();
        if (failure[0] != null) {
            throw new IllegalStateException("Android's install task raised for " + path, failure[0]);
        }
        return status[0];
    }

    /** A worker on the seated app, logged in, as the project's tests make one. */
    static void login() {
        CommCareApp app = CommCareApplication.instance().getCurrentApp();
        DemoUserBuilder.buildTestUser(ApplicationProvider.getApplicationContext(), app, USERNAME, PASSWORD);
        TestAppInstaller.login(USERNAME, PASSWORD);
    }

    /**
     * Applies the restore at {@code path} through Android's own data pull (DataPullTask), which reads the payload
     * from a reference where the test application's requester stands in for the server
     * (CommCareTestApplication.getDataPullRequester).
     */
    static String restore(String path) {
        File file = new File(path);
        String root = CommCareApplication.instance().getArchiveFileRoot().addArchiveFile(file.getParent());
        String reference = "jr://archive/" + root + "/" + file.getName();
        restorePath = path;
        restoreReference = reference;
        org.commcare.network.CommcareRequestEndpointsMock.setCaseFetchResponseCodes(new Integer[]{200});
        LocalReferencePullResponseFactory.setRequestPayloads(new String[]{reference});
        CommCareApplication.instance().getCurrentApp().getAppPreferences().edit()
                .putString("key_server", null).commit();
        final Object[] outcome = new Object[2];
        DataPullTask<Object> task = new DataPullTask<Object>(USERNAME, PASSWORD, null, "fake.server.com",
                ApplicationProvider.getApplicationContext(), LocalReferencePullResponseFactory.INSTANCE,
                false, false, false) {
            @Override
            protected void deliverResult(Object receiver, ResultAndError<PullTaskResult> result) {
                outcome[0] = result.data;
                outcome[1] = result.errorMessage;
            }

            @Override
            protected void deliverUpdate(Object receiver, Integer... update) {
            }

            @Override
            protected void deliverError(Object receiver, Exception e) {
                outcome[0] = e;
            }
        };
        task.connect(TestAppInstaller.fakeConnector);
        try {
            task.execute().get();
        } catch (Exception e) {
            throw new IllegalStateException("Android's data pull did not finish for " + path, e);
        }
        ShadowLooper.idleMainLooper();
        if (outcome[0] instanceof Exception) {
            throw new IllegalStateException("Android's data pull raised for " + path, (Exception)outcome[0]);
        }
        become();
        Cases.restored();
        return String.valueOf(outcome[0]) + (outcome[1] == null || "".equals(outcome[1]) ? "" : ": " + outcome[1]);
    }

    /**
     * The worker the restore registered becomes the device's worker, as the worker who logged in is on a real
     * device: there the first restore brings the worker's own record and the session starts with it
     * (DataPullTask, CommCareApplication.startUserSession reads the user by the key record's name). The test
     * application makes its worker before any restore, under a name of its own, so the session is started
     * again with the worker the restore brought, by the app's own call.
     */
    private static void become() {
        for (User user : CommCareApplication.instance().getUserStorage("USER", User.class)) {
            if (!USERNAME.equals(user.getUsername())) {
                user.setCachedPwd(PASSWORD);
                CommCareApplication.instance().getSession().startSession(user,
                        CommCareApplication.instance().getRecordForCurrentUser());
                return;
            }
        }
    }

    /** The reference a sync reads the server's restore from (the one the device was restored from), or null. */
    static String restoreReference() {
        return restoreReference;
    }

    /** A worker's own settings, written where Android's settings screen writes them. */
    static void prefer(JSONObject preferences) throws Exception {
        if (preferences == null) {
            return;
        }
        android.content.SharedPreferences.Editor editor =
                CommCareApplication.instance().getCurrentApp().getAppPreferences().edit();
        JSONArray names = preferences.names();
        for (int i = 0; names != null && i < names.length(); i++) {
            editor.putString(names.getString(i), preferences.getString(names.getString(i)));
        }
        editor.commit();
    }

    /**
     * The device as it was before any walk changed the worker's data: the worker's session closed and sandbox
     * wiped by the app's own calls (CommCareApplication.closeUserSession, AppUtils.wipeSandboxForUser, what the
     * app's Clear User Data runs), the worker made and logged in again, and the restore applied again.
     */
    static void reset() {
        CommCareApplication.instance().closeUserSession();
        AppUtils.wipeSandboxForUser(USERNAME);
        login();
        if (restorePath != null) {
            restore(restorePath);
        }
        dirty = false;
    }

    /**
     * What home is given in place of its own syncer. Where home starts sending the worker's unsent forms
     * (FormAndDataSyncer.processAndSendForms starts a ProcessAndSendTask), this applies each unsent form to the
     * device as that task first does, with the app's own processor (FormSubmissionHelper: FormRecordProcessor
     * .process), and sends nothing: there is no server. A sync is not run either, as the project's own fake
     * leaves it (FormAndDataSyncerFake).
     */
    static final class Syncer extends FormAndDataSyncer {
        static final List<String> processed = new ArrayList<>();

        @Override
        protected void processAndSendForms(SyncCapableCommCareActivity activity, boolean syncAfterwards,
                                           boolean userTriggered) {
            SqlStorage<FormRecord> storage = CommCareApplication.instance().getUserStorage(FormRecord.class);
            FormRecordProcessor processor = new FormRecordProcessor(activity);
            for (FormRecord record : StorageUtils.getUnsentRecordsForCurrentApp(storage)) {
                if (!FormRecord.STATUS_COMPLETE.equals(record.getStatus())) {
                    continue;
                }
                dirty = true;
                try {
                    FormRecord after = processor.process(record);
                    processed.add(String.valueOf(after.getStatus()));
                } catch (Exception raised) {
                    processed.add("raised " + raised.getClass().getName() + ": " + raised.getMessage());
                }
            }
        }

        @Override
        public void syncDataForLoggedInUser(SyncCapableCommCareActivity activity, boolean formsToSend,
                                            boolean userTriggeredSync) {
        }
    }
}
