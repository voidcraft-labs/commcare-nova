package nova.proof.android;

import android.content.SharedPreferences;

import org.commcare.AppUtils;
import org.commcare.CommCareApp;
import org.commcare.CommCareApplication;
import org.commcare.android.database.global.models.ApplicationRecord;
import org.commcare.preferences.HiddenPreferences;
import org.commcare.preferences.MainConfigurablePreferences;
import org.commcare.tasks.PurgeStaleArchivedFormsTask;
import org.commcare.update.UpdateHelper;
import org.commcare.utils.ChangeLocaleUtil;
import org.commcare.utils.PendingCalcs;
import org.commcare.utils.SyncDetailCalculations;
import org.javarosa.core.services.locale.Localization;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.lang.reflect.Method;
import java.util.Map;
import java.util.TreeMap;

/**
 * What Android reads of an installed app's profile: each reader the app's own code asks, called on the seated
 * app. A private reader is called by reflection, so the method that runs is the app's.
 */
final class Profile {
    /** The profile settings whose stored value is recorded beside what their readers give. */
    private static final String[] KEYS = {
            "cc-show-saved", "cc-show-incomplete", "cc-content-valid", "cc-gps-auto-capture-accuracy",
            "cc-login-duration-seconds", "logenabled", "cc-maps-default-layer", "cc-resize-images",
            "cc-inflation-target-density", "cc-label-required-questions-with-asterisk", "cc-fuzzy-search-enabled",
            "cc-enable-tts", "cc-autosync-freq", "cc-days-form-retain", "unsent-number-limit", "unsent-time-limit",
            "cc-autoup-freq", "cur_locale",
    };
    private static final long DAY = 24L * 60 * 60 * 1000;

    private Profile() {
    }

    static JSONObject read() throws Exception {
        CommCareApp app = CommCareApplication.instance().getCurrentApp();
        JSONObject found = new JSONObject();
        found.put("app", app(app));
        found.put("readers", readers(app));
        found.put("stored", stored(app.getAppPreferences()));
        found.put("locale", locale());
        return found;
    }

    private static JSONObject app(CommCareApp app) throws JSONException {
        ApplicationRecord record = app.getAppRecord();
        JSONObject found = new JSONObject();
        found.put("uniqueId", record.getUniqueId());
        found.put("displayName", record.getDisplayName());
        found.put("versionNumber", record.getVersionNumber());
        found.put("resourcesValidated", record.resourcesValidated());
        found.put("AppUtils.getAppById", AppUtils.getAppById(record.getUniqueId()) != null);
        found.put("installedApps", installed());
        return found;
    }

    static JSONArray installed() {
        JSONArray found = new JSONArray();
        for (ApplicationRecord record : AppUtils.getInstalledAppRecords()) {
            found.put(record.getUniqueId());
        }
        return found;
    }

    private static JSONObject readers(CommCareApp app) throws Exception {
        JSONObject found = new JSONObject();
        found.put("HiddenPreferences.isSavedFormsEnabled", HiddenPreferences.isSavedFormsEnabled());
        found.put("HiddenPreferences.isIncompleteFormsEnabled", HiddenPreferences.isIncompleteFormsEnabled());
        found.put("HiddenPreferences.getGpsAutoCaptureAccuracy", HiddenPreferences.getGpsAutoCaptureAccuracy());
        found.put("HiddenPreferences.getLoginDuration", HiddenPreferences.getLoginDuration());
        found.put("HiddenPreferences.getResizeMethod", HiddenPreferences.getResizeMethod());
        found.put("HiddenPreferences.isSmartInflationEnabled", HiddenPreferences.isSmartInflationEnabled());
        found.put("HiddenPreferences.shouldLabelRequiredQuestionsWithAsterisk",
                HiddenPreferences.shouldLabelRequiredQuestionsWithAsterisk());
        found.put("HiddenPreferences.getLogsEnabled", HiddenPreferences.getLogsEnabled());
        found.put("HiddenPreferences.isLoggingEnabled", HiddenPreferences.isLoggingEnabled());
        found.put("HiddenPreferences.getMapsDefaultLayer", String.valueOf(HiddenPreferences.getMapsDefaultLayer()));
        found.put("MainConfigurablePreferences.isFuzzySearchEnabled",
                MainConfigurablePreferences.isFuzzySearchEnabled());
        found.put("MainConfigurablePreferences.isTTSEnabled", MainConfigurablePreferences.isTTSEnabled());
        found.put("CommCareApp.areMMResourcesValidated", app.areMMResourcesValidated());
        found.put("UpdateHelper.getAutoUpdateFrequency",
                String.valueOf(call(UpdateHelper.class, "getAutoUpdateFrequency", new Class<?>[0])));
        found.put("UpdateHelper.isAutoUpdateOn", UpdateHelper.isAutoUpdateOn());
        found.put("UpdateHelper.getAutoUpdatePeriodicity", UpdateHelper.getAutoUpdatePeriodicity());
        found.put("PendingCalcs.getPendingSyncStatus", pendingSync());
        found.put("PurgeStaleArchivedFormsTask.getArchivedFormsValidityInDays",
                PurgeStaleArchivedFormsTask.getArchivedFormsValidityInDays(app));
        found.put("SyncDetailCalculations.unsentFormNumberLimitExceeded", numberLimit());
        found.put("SyncDetailCalculations.unsentFormTimeLimitExceeded", timeLimit());
        return found;
    }

    /**
     * Whether a sync is pending for a worker who has never synced (the reader's last attempt reads 0): true under
     * any period the profile sets, false only where it sets none.
     */
    private static boolean pendingSync() {
        return PendingCalcs.getPendingSyncStatus();
    }

    /** The fewest unsent forms the reader counts as over the limit. */
    private static int numberLimit() throws Exception {
        for (int count = 0; count <= 1000; count++) {
            if ((Boolean)call(SyncDetailCalculations.class, "unsentFormNumberLimitExceeded",
                    new Class<?>[]{int.class}, count)) {
                return count;
            }
        }
        return -1;
    }

    /** The fewest whole days since the last sync the reader counts as over the limit. */
    private static int timeLimit() throws Exception {
        long now = System.currentTimeMillis();
        for (int days = 0; days <= 400; days++) {
            // Half a day past each whole day, so the reader's own clock read lands on the same side.
            if ((Boolean)call(SyncDetailCalculations.class, "unsentFormTimeLimitExceeded",
                    new Class<?>[]{long.class}, now - days * DAY - DAY / 2)) {
                return days;
            }
        }
        return -1;
    }

    static Object call(Class<?> owner, String name, Class<?>[] types, Object... arguments) throws Exception {
        Method method = owner.getDeclaredMethod(name, types);
        method.setAccessible(true);
        return method.invoke(null, arguments);
    }

    private static JSONObject stored(SharedPreferences preferences) throws JSONException {
        Map<String, ?> all = new TreeMap<>(preferences.getAll());
        JSONObject found = new JSONObject();
        for (String key : KEYS) {
            found.put(key, all.containsKey(key) ? String.valueOf(all.get(key)) : JSONObject.NULL);
        }
        return found;
    }

    private static JSONObject locale() throws JSONException {
        JSONObject found = new JSONObject();
        found.put("Localization.getCurrentLocale", Localization.getCurrentLocale());
        found.put("ChangeLocaleUtil.getLocaleCodes", new JSONArray(ChangeLocaleUtil.getLocaleCodes()));
        found.put("ChangeLocaleUtil.getLocaleNames", new JSONArray(ChangeLocaleUtil.getLocaleNames()));
        return found;
    }
}
