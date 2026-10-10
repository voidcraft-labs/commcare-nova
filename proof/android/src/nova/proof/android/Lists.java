package nova.proof.android;

import android.app.Activity;
import android.content.Intent;
import android.view.View;
import android.view.View.MeasureSpec;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ListView;

import org.commcare.CommCareApplication;
import org.commcare.activities.EntityDetailActivity;
import org.commcare.activities.EntitySelectActivity;
import org.commcare.adapters.EntityListAdapter;
import org.commcare.dalvik.R;
import org.commcare.preferences.MainConfigurablePreferences;
import org.commcare.suite.model.Detail;
import org.commcare.suite.model.EntityDatum;
import org.commcare.util.DatumUtil;
import org.commcare.views.dialogs.DialogChoiceItem;
import org.commcare.views.dialogs.PaneledChoiceDialog;
import org.json.JSONArray;
import org.json.JSONObject;
import org.robolectric.Robolectric;
import org.robolectric.Shadows;
import org.robolectric.shadows.ShadowActivity;
import org.robolectric.shadows.ShadowListView;
import org.robolectric.shadows.ShadowLooper;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * What Android's case list shows for the list home opened (EntitySelectActivity): its Sort menu
 * (getSortOptionsList) and the order each of its choices puts the rows in; its header row and every row as
 * EntityView or EntityViewTile lay them out, each cell with the width a 1000-pixel row gives it; and what a
 * search finds (EntityListAdapter.filterByString), with fuzzy search as the profile leaves it and then on and
 * off. The terms are the list's own: each word any row shows, and that word misspelled by its last letter, so a
 * list is searched for what a worker reads on it.
 *
 * The first case is then opened as a tap opens it (onEntitySelected): where the list has a case detail, the
 * detail screen (EntityDetailActivity) is read, each tab's fields as shown, and confirmed by its own button; the
 * list's result goes back to home.
 */
final class Lists {
    /** The width a row is measured at, so the widths Android gives its columns are comparable. */
    private static final int ROW_WIDTH = 1000;
    /** How long a list's filter thread may take before the reader gives up on the request. */
    private static final long FILTER_MILLIS = 120000;
    private static final String FUZZY = "cc-fuzzy-search-enabled";
    /** Terms the request names for every list, beside each list's own; null where it names none. */
    static JSONArray searches;
    /** Set where a request reads lists only to pass them (a form saved before an update): no Sort, no search. */
    static boolean brief;
    /** Set by the walk for the list it is about to read: the list's action to take there, or null. */
    static Integer action;
    /** How many actions the list last read offers. */
    static int offered;
    /** The lists (by the session's command and the case it asks for) a request has sorted and searched. */
    private static final Set<String> probed = new java.util.HashSet<>();

    private Lists() {
    }

    static boolean read(Intent started, JSONObject step, ShadowActivity home) throws Exception {
        offered = 0;
        EntitySelectActivity activity =
                Robolectric.buildActivity(EntitySelectActivity.class, started).setup().get();
        loaded(activity);
        ShadowActivity shadow = Shadows.shadowOf((Activity)activity);
        if (activity.isFinishing()) {
            // A list that answers home without showing itself (a case chosen for the worker).
            step.put("list", JSONObject.NULL);
            step.put("resultCode", shadow.getResultCode());
            home.receiveResult(started, shadow.getResultCode(), shadow.getResultIntent());
            ShadowLooper.idleMainLooper();
            return shadow.getResultCode() == Activity.RESULT_OK;
        }
        ListView listView = (ListView)((Activity)activity).findViewById(R.id.screen_entity_select_list);
        EntityListAdapter adapter;
        if (listView != null && listView.getAdapter() instanceof EntityListAdapter) {
            adapter = (EntityListAdapter)listView.getAdapter();
            ShadowListView shadowList = Shadows.shadowOf(listView);
            shadowList.populateItems();
        } else {
            adapter = (EntityListAdapter)Screens.field(activity, "adapter");
        }
        if (adapter == null) {
            step.put("list", JSONObject.NULL);
            step.put("alert", Screens.orNull(Views.alert(activity)));
            return false;
        }
        JSONObject list = new JSONObject();
        step.put("list", list);
        list.put("alert", Screens.orNull(Views.alert(activity)));

        // The header row and every row, measured, so each column has the width Android gives it.
        LinearLayout header = (LinearLayout)Screens.field(activity, "header");
        JSONArray headers = new JSONArray();
        for (int i = 0; header != null && i < header.getChildCount(); i++) {
            headers.put(Views.describe(measured(header.getChildAt(i))));
        }
        list.put("header", headers);
        list.put("count", adapter.getCurrentCount());
        JSONArray shown = new JSONArray();
        // The words searched for are the list's own, whatever order it shows its rows in: every word of every
        // row, in the words' own order.
        Set<String> words = new java.util.TreeSet<>();
        for (int i = 0; i < adapter.getCurrentCount(); i++) {
            JSONObject row = Views.describe(measured(adapter.getView(i, null, listView)));
            shown.put(row);
            words(row, words);
        }
        list.put("rows", shown);
        // The header and every row as a worker sees them on the device's screen, drawn: each row at the width the
        // screen gives the list (all of a phone's, the left pane of a tablet's), or a grid cell's where the list
        // lays its tiles out in a grid.
        JSONObject drawn = new JSONObject();
        Views.fillScreen((Activity)activity);
        View visible = (View)Screens.field(activity, "visibleView");
        int width = visible != null && visible.getWidth() > 0 ? visible.getWidth() : Views.screenWidth();
        if (header != null) {
            drawn.put("header", Views.drawn(header, width));
        }
        Detail shown_ = (Detail)Screens.field(activity, "shortSelect");
        int cell = shown_ != null && shown_.shouldBeLaidOutInGrid()
                ? width / Math.max(1, shown_.getNumEntitiesToDisplayPerRow()) : width;
        JSONArray drawnRows = new JSONArray();
        for (int i = 0; i < adapter.getCurrentCount(); i++) {
            drawnRows.put(Views.drawn(adapter.getView(i, null, listView), cell));
        }
        drawn.put("rows", drawnRows);
        list.put("drawn", drawn);
        // Which case each row is, in the order the list shows them: the value a tap on the row hands the
        // session (DatumUtil.getReturnValueFromSelection), so two lists compare row for row by the case.
        Object datum = Screens.field(activity, "selectDatum");
        if (datum instanceof EntityDatum) {
            JSONArray order = new JSONArray();
            for (int i = 0; i < adapter.getCurrentCount(); i++) {
                try {
                    order.put(Screens.orNull(Cases.unnamed(DatumUtil.getReturnValueFromSelection(adapter.getItem(i),
                            (EntityDatum)datum,
                            CommCareApplication.instance().getCurrentSessionWrapper().getEvaluationContext()))));
                } catch (RuntimeException raised) {
                    order.put("raised " + raised.getClass().getName());
                }
            }
            list.put("order", order);
        }

        list.put("EntitySelectActivity.getSortOptionsList", Views.choices(sortOptions(activity)));
        // What a worker's Sort choice and searches give, each on a list of its own opened as this one was, so
        // this one stays as it opened: the Sort menu's choices in turn, then the searches with fuzzy search as
        // installed, and on lists opened with the worker's own setting on and off (the list reads the setting
        // when it opens, EntityListAdapter). Once a request for each list a session asks for (the first time
        // a walk reaches it): the walks that pass the same list again read its rows and choose its case.
        if (!brief && probed.add(String.valueOf(step.opt("session")))) {
            list.put("sorted", sorted(started));
            list.put("searches", searched(started, words));
        }

        // The list's own actions (a search behind the list), each as its menu item names it.
        Detail shortSelect = (Detail)Screens.field(activity, "shortSelect");
        List<org.commcare.suite.model.Action> actions = shortSelect == null
                ? new ArrayList<>() : shortSelect.getCustomActions(activity.evalContext());
        JSONArray named = new JSONArray();
        for (org.commcare.suite.model.Action offer : actions) {
            named.put(Screens.orNull(offer.getDisplay() == null ? null : offer.getDisplay().evaluate().getName()));
        }
        list.put("actions", named);
        offered = actions.size();
        if (action != null) {
            list.put("took", action);
            if (action >= actions.size()) {
                list.put("offered", false);
                return false;
            }
            // The action, taken as its menu item takes it (EntitySelectActivity.onOptionsItemSelected).
            Method trigger = EntitySelectActivity.class.getDeclaredMethod("triggerDetailAction", int.class);
            trigger.setAccessible(true);
            trigger.invoke(activity, action);
            ShadowLooper.idleMainLooper();
            list.put("finishing", activity.isFinishing());
            if (!activity.isFinishing()) {
                list.put("alertAfterChoice", Screens.orNull(Views.alert(activity)));
                return false;
            }
            home.receiveResult(started, shadow.getResultCode(), shadow.getResultIntent());
            ShadowLooper.idleMainLooper();
            return true;
        }

        if (adapter.getCurrentCount() == 0) {
            return false;
        }
        // The first case, opened as a tap opens it.
        activity.onEntitySelected(0);
        ShadowLooper.idleMainLooper();
        Intent detail = shadow.getNextStartedActivity();
        if (detail != null && detail.getComponent() != null
                && EntityDetailActivity.class.getName().equals(detail.getComponent().getClassName())) {
            JSONObject shownDetail = new JSONObject();
            list.put("detail", shownDetail);
            ShadowActivity detailShadow = detail(detail, shownDetail);
            if (detailShadow == null) {
                return false;
            }
            shadow.receiveResult(detail, detailShadow.getResultCode(), detailShadow.getResultIntent());
            ShadowLooper.idleMainLooper();
        } else if (!activity.isFinishing() && Boolean.TRUE.equals(Screens.field(activity, "inAwesomeMode"))) {
            // A tablet in landscape shows the list and the chosen case's detail side by side
            // (EntitySelectActivity.setupLandscapeDualPaneView): the tap fills the right pane
            // (displayReferenceAwesome), which is read, and the worker presses its own confirm button there.
            JSONObject shownDetail = new JSONObject();
            list.put("detail", shownDetail);
            shownDetail.put("pane", "right");
            Intent selected = (Intent)Screens.field(activity, "selectedIntent");
            if (selected != null) {
                org.commcare.session.CommCareSession session =
                        CommCareApplication.instance().getCurrentSessionWrapper().getSession();
                Detail chosenDetail = session.getDetail(selected.getStringExtra(EntityDetailActivity.DETAIL_ID));
                org.javarosa.core.model.instance.TreeReference reference =
                        org.commcare.utils.SerializationUtil.deserializeFromIntent(selected,
                                EntityDetailActivity.CONTEXT_REFERENCE,
                                org.javarosa.core.model.instance.TreeReference.class);
                if (chosenDetail != null && reference != null) {
                    shownDetail.put("tabs", Details.read(activity, chosenDetail, reference));
                }
            }
            Button next = (Button)((Activity)activity).findViewById(R.id.entity_select_button);
            shownDetail.put("confirm", next == null || next.getVisibility() != View.VISIBLE ? JSONObject.NULL
                    : String.valueOf(next.getText()));
            if (next != null && next.getVisibility() == View.VISIBLE) {
                next.performClick();
                ShadowLooper.idleMainLooper();
            }
        } else {
            list.put("detail", JSONObject.NULL);
        }
        list.put("finishing", activity.isFinishing());
        if (!activity.isFinishing()) {
            list.put("alertAfterChoice", Screens.orNull(Views.alert(activity)));
            return false;
        }
        // Which case the tap chose: the value the list hands home for the session.
        Intent result = shadow.getResultIntent();
        list.put("chose", Screens.orNull(result == null ? null
                : Cases.unnamed(result.getStringExtra(org.commcare.session.SessionFrame.STATE_DATUM_VAL))));
        home.receiveResult(started, shadow.getResultCode(), result);
        ShadowLooper.idleMainLooper();
        return shadow.getResultCode() == Activity.RESULT_OK;
    }

    /**
     * Waits for the list's cases: the activity loads them on a task of its own (EntityLoaderTask) and shows the
     * list when the task's result reaches the main thread.
     */
    private static void loaded(EntitySelectActivity activity) throws Exception {
        for (int turn = 0; turn < 20; turn++) {
            ShadowLooper.idleMainLooper();
            Object loader = Screens.field(activity, "loader");
            if (loader == null) {
                return;
            }
            ((android.os.AsyncTask<?, ?, ?>)loader).get(120, java.util.concurrent.TimeUnit.SECONDS);
        }
        ShadowLooper.idleMainLooper();
    }

    /** The detail screen home itself opens (a case chosen for the worker, to confirm). */
    static boolean confirm(Intent started, JSONObject step, ShadowActivity home) throws Exception {
        JSONObject shown = new JSONObject();
        step.put("detail", shown);
        ShadowActivity shadow = detail(started, shown);
        if (shadow == null) {
            return false;
        }
        home.receiveResult(started, shadow.getResultCode(), shadow.getResultIntent());
        ShadowLooper.idleMainLooper();
        return shadow.getResultCode() == Activity.RESULT_OK;
    }

    /** Reads the detail screen and presses its confirm button; null where the screen does not then finish. */
    private static ShadowActivity detail(Intent started, JSONObject shown) throws Exception {
        EntityDetailActivity activity =
                Robolectric.buildActivity(EntityDetailActivity.class, started).setup().get();
        ShadowLooper.idleMainLooper();
        ShadowActivity shadow = Shadows.shadowOf((Activity)activity);
        if (!activity.isFinishing()) {
            Detail detail = (Detail)Screens.field(activity, "detail");
            shown.put("tabs", Details.read(activity, detail,
                    (org.javarosa.core.model.instance.TreeReference)Screens.field(activity, "mTreeReference")));
            shown.put("alert", Screens.orNull(Views.alert(activity)));
            Button next = (Button)((Activity)activity).findViewById(R.id.entity_select_button);
            shown.put("confirm", next == null || next.getVisibility() != View.VISIBLE ? JSONObject.NULL
                    : String.valueOf(next.getText()));
            if (next != null) {
                next.performClick();
                ShadowLooper.idleMainLooper();
            }
        }
        shown.put("finishing", activity.isFinishing());
        return activity.isFinishing() ? shadow : null;
    }

    private static DialogChoiceItem[] sortOptions(EntitySelectActivity activity) throws Exception {
        PaneledChoiceDialog dialog = new PaneledChoiceDialog(activity, "sort");
        Method sortOptions = EntitySelectActivity.class.getDeclaredMethod("getSortOptionsList",
                PaneledChoiceDialog.class);
        sortOptions.setAccessible(true);
        return (DialogChoiceItem[])sortOptions.invoke(activity, dialog);
    }

    /** A list opened as home's was, with its adapter; null where it shows none. */
    private static Object[] probe(Intent started) throws Exception {
        EntitySelectActivity activity =
                Robolectric.buildActivity(EntitySelectActivity.class, new Intent(started)).setup().get();
        loaded(activity);
        ListView listView = (ListView)((Activity)activity).findViewById(R.id.screen_entity_select_list);
        if (listView == null || !(listView.getAdapter() instanceof EntityListAdapter)) {
            return null;
        }
        Shadows.shadowOf(listView).populateItems();
        return new Object[]{activity, listView, listView.getAdapter()};
    }

    private static JSONArray sorted(Intent started) throws Exception {
        JSONArray sorted = new JSONArray();
        Object[] probe = probe(started);
        if (probe == null) {
            return sorted;
        }
        EntityListAdapter adapter = (EntityListAdapter)probe[2];
        for (DialogChoiceItem option : sortOptions((EntitySelectActivity)probe[0])) {
            JSONObject order = new JSONObject();
            order.put("option", option.text);
            try {
                option.listener.onClick(null);
                settle(adapter);
                order.put("rows", firstCells(adapter, (ListView)probe[1]));
            } catch (RuntimeException raised) {
                order.put("raised", raised.getClass().getName());
            }
            sorted.put(order);
        }
        return sorted;
    }

    private static JSONObject searched(Intent started, Set<String> words) throws Exception {
        List<String> terms = new ArrayList<>();
        for (int i = 0; searches != null && i < searches.length(); i++) {
            terms.add(searches.getString(i));
        }
        for (String word : words) {
            terms.add(word);
            terms.add(misspelled(word));
        }
        android.content.SharedPreferences preferences =
                CommCareApplication.instance().getCurrentApp().getAppPreferences();
        String held = preferences.getString(FUZZY, null);
        JSONObject found = new JSONObject();
        found.put("MainConfigurablePreferences.isFuzzySearchEnabled",
                MainConfigurablePreferences.isFuzzySearchEnabled());
        found.put("asInstalled", matches(started, terms));
        try {
            preferences.edit().putString(FUZZY, "yes").commit();
            found.put("fuzzyOn", matches(started, terms));
            preferences.edit().putString(FUZZY, "no").commit();
            found.put("fuzzyOff", matches(started, terms));
        } finally {
            if (held == null) {
                preferences.edit().remove(FUZZY).commit();
            } else {
                preferences.edit().putString(FUZZY, held).commit();
            }
        }
        return found;
    }

    private static JSONObject matches(Intent started, List<String> terms) throws Exception {
        JSONObject results = new JSONObject();
        Object[] probe = probe(started);
        if (probe == null) {
            return results;
        }
        EntityListAdapter adapter = (EntityListAdapter)probe[2];
        for (String term : terms) {
            adapter.filterByString(term);
            settle(adapter);
            results.put(term, firstCells(adapter, (ListView)probe[1]));
        }
        return results;
    }

    private static JSONArray firstCells(EntityListAdapter adapter, ListView listView) throws Exception {
        JSONArray matched = new JSONArray();
        for (int row = 0; row < adapter.getCurrentCount(); row++) {
            matched.put(Screens.orNull(firstText(Views.describe(adapter.getView(row, null, listView)))));
        }
        return matched;
    }

    /** A word with its last letter changed: one edit from the word, as a slip of the thumb is. */
    static String misspelled(String word) {
        char last = word.charAt(word.length() - 1);
        return word.substring(0, word.length() - 1) + (last == 'x' ? 'q' : 'x');
    }

    private static void words(JSONObject described, Set<String> words) throws Exception {
        if (described.has("text")) {
            for (String word : described.getString("text").split("[^\\p{L}\\p{Nd}]+")) {
                // Core matches a misspelling only for a term longer than three characters
                // (cases/util/StringUtils.fuzzyMatch).
                if (word.length() > 3) {
                    words.add(word.toLowerCase(java.util.Locale.ROOT));
                }
            }
        }
        JSONArray children = described.optJSONArray("children");
        for (int i = 0; children != null && i < children.length(); i++) {
            words(children.getJSONObject(i), words);
        }
    }

    /**
     * Waits for the list's filter, which Android runs on a thread of its own (EntityFiltererBase.start), and for
     * the result it posts back to the main thread.
     */
    private static void settle(EntityListAdapter adapter) throws Exception {
        Object filterer = Screens.field(adapter, "entityFilterer");
        if (filterer != null) {
            Thread thread = (Thread)Screens.field(filterer, "thread");
            if (thread != null) {
                thread.join(FILTER_MILLIS);
                if (thread.isAlive()) {
                    throw new IllegalStateException("The list's filter thread did not finish within "
                            + FILTER_MILLIS + " ms, so what the list shows is not settled.");
                }
            }
        }
        ShadowLooper.idleMainLooper();
    }

    private static String firstText(JSONObject described) throws Exception {
        if (described.has("text")) {
            return described.getString("text");
        }
        JSONArray children = described.optJSONArray("children");
        for (int i = 0; children != null && i < children.length(); i++) {
            String text = firstText(children.getJSONObject(i));
            if (text != null) {
                return text;
            }
        }
        return null;
    }

    static View measured(View view) {
        view.measure(MeasureSpec.makeMeasureSpec(ROW_WIDTH, MeasureSpec.EXACTLY),
                MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED));
        view.layout(0, 0, view.getMeasuredWidth(), view.getMeasuredHeight());
        return view;
    }
}
