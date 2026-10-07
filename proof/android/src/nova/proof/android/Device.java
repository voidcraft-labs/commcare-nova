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

import java.io.File;

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
        return String.valueOf(outcome[0]) + (outcome[1] == null || "".equals(outcome[1]) ? "" : ": " + outcome[1]);
    }
}
