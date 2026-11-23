package nova.proof.android;

import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;

import org.commcare.CommCareApplication;
import org.commcare.activities.MenuActivity;
import org.commcare.activities.StandardHomeActivity;
import org.commcare.engine.resource.AppInstallStatus;
import org.json.JSONArray;
import org.json.JSONObject;
import org.robolectric.Shadows;
import org.robolectric.shadows.ShadowActivity;
import org.robolectric.shadows.ShadowLooper;
import org.robolectric.shadows.ShadowPackageManager;

import java.lang.reflect.Method;

/** Press Start on Android home with the named companion apps installed on that device. */
final class RequiredApps {
    private RequiredApps() { }

    static JSONObject read(JSONObject request) throws Exception {
        AppInstallStatus status = Device.install(request.getString("archive"));
        JSONObject found = new JSONObject().put("install", String.valueOf(status));
        if (status != AppInstallStatus.Installed) return found;
        Device.login();

        ShadowPackageManager packages = Shadows.shadowOf(CommCareApplication.instance().getPackageManager());
        JSONArray installed = request.getJSONArray("installed");
        for (int i = 0; i < installed.length(); i++) {
            PackageInfo pkg = new PackageInfo();
            pkg.packageName = installed.getString(i);
            pkg.applicationInfo = new ApplicationInfo();
            pkg.applicationInfo.packageName = pkg.packageName;
            packages.installPackage(pkg);
        }
        try {
            StandardHomeActivity home = Opened.build(StandardHomeActivity.class, null).create().get();
            ShadowLooper.idleMainLooper();
            ShadowActivity activity = Shadows.shadowOf(home);
            while (activity.getNextStartedActivity() != null) {
                // Only the destination of this press answers whether Start opened the app.
            }
            // HomeButtons' Start listener invokes this package-private method.
            Method start = StandardHomeActivity.class.getDeclaredMethod("enterRootModule");
            start.setAccessible(true);
            start.invoke(home);
            ShadowLooper.idleMainLooper();
            boolean opened = false;
            for (Intent intent = activity.getNextStartedActivity(); intent != null; intent = activity.getNextStartedActivity()) {
                if (intent.getComponent() != null && MenuActivity.class.getName().equals(intent.getComponent().getClassName()))
                    opened = true;
            }
            found.put("openedMenu", opened);
            found.put("dialog", Views.alert(home));
            return found;
        } finally {
            Opened.end();
        }
    }
}
