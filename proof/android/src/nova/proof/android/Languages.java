package nova.proof.android;

import android.view.MenuItem;
import android.widget.AdapterView;

import org.commcare.activities.StandardHomeActivity;
import org.commcare.dalvik.R;
import org.commcare.utils.ChangeLocaleUtil;
import org.commcare.views.dialogs.AlertDialogFragment;
import org.commcare.views.dialogs.CommCareAlertDialog;
import org.commcare.views.dialogs.DialogChoiceItem;
import org.javarosa.core.services.locale.Localization;
import org.json.JSONArray;
import org.json.JSONObject;
import org.robolectric.fakes.RoboMenu;
import org.robolectric.shadows.ShadowLooper;

import java.lang.reflect.Field;
import java.util.Arrays;
import java.util.List;

/**
 * A language chosen as a worker chooses it on the device: the home screen's menu item "Change Language"
 * (StandardHomeActivity.onOptionsItemSelected, action_change_language), whose dialog lists the languages the
 * installed app holds (HomeScreenBaseActivity.showLocaleChangeMenu, ChangeLocaleUtil.getLocaleCodes) and sets the
 * one tapped as the app's language for every screen after (Localization.setLocale, and the app's own setting,
 * MainConfigurablePreferences.setCurrentLocale).
 */
final class Languages {
    private Languages() {
    }

    /** Chooses {@code code} on home's own dialog; what the dialog offered, and the language the app then shows. */
    static JSONObject choose(StandardHomeActivity home, String code) throws Exception {
        JSONObject found = new JSONObject();
        List<String> codes = Arrays.asList(ChangeLocaleUtil.getLocaleCodes());
        found.put("chose", code);
        found.put("offered", new JSONArray(codes));
        int position = codes.indexOf(code);
        if (position < 0) {
            // The installed app holds no such language: the worker finds nothing to choose.
            found.put("unoffered", true);
            return found;
        }
        // The worker opens home's options menu, which Android makes and prepares as it opens, and taps the item.
        RoboMenu menu = new RoboMenu(home);
        home.onCreateOptionsMenu(menu);
        home.onPrepareOptionsMenu(menu);
        MenuItem item = menu.findItem(R.id.action_change_language);
        found.put("item", item == null ? JSONObject.NULL : String.valueOf(item.getTitle()));
        if (item == null || !item.isVisible()) {
            found.put("unoffered", true);
            return found;
        }
        home.onOptionsItemSelected(item);
        ShadowLooper.idleMainLooper();
        home.getSupportFragmentManager().executePendingTransactions();
        AlertDialogFragment fragment = home.getCurrentAlertDialog();
        if (fragment == null) {
            // Home not in front keeps the dialog to show as it returns (CommCareActivity.showAlertDialog), where
            // the walk's home, made for the session it starts, is.
            fragment = (AlertDialogFragment)Screens.field(home, "alertDialogToShowOnResume");
        }
        if (fragment == null) {
            throw new IllegalStateException("Home's Change Language item showed no dialog.");
        }
        Field held = AlertDialogFragment.class.getDeclaredField("underlyingDialog");
        held.setAccessible(true);
        CommCareAlertDialog dialog = (CommCareAlertDialog)held.get(fragment);
        // The rows the dialog lists (each language's name), and the worker's tap on the language's row: the
        // dialog's own row listener, which its list calls with the row tapped (PaneledChoiceDialog
        // .setupListAdapter), called as the list calls it. The dialog is home's to show as home comes to the
        // front; its rows and listener are made with it, whatever is drawn.
        JSONArray rows = new JSONArray();
        for (DialogChoiceItem row : (DialogChoiceItem[])Screens.field(dialog, "choiceItems")) {
            rows.put(String.valueOf(row.text));
        }
        found.put("rows", rows);
        AdapterView.OnItemClickListener tap = (AdapterView.OnItemClickListener)Screens.field(dialog,
                "listClickListener");
        tap.onItemClick(null, null, position, position);
        ShadowLooper.idleMainLooper();
        found.put("Localization.getCurrentLocale", Screens.orNull(Localization.getCurrentLocale()));
        return found;
    }
}
