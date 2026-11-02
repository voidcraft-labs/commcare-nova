package nova.compatibility;

import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.Vector;
import org.commcare.cases.model.Case;
import org.commcare.cases.query.queryset.DualTableSingleMatchModelQuerySet;
import org.commcare.modern.engine.cases.CaseIndexTable;
import org.javarosa.core.services.storage.IStorageIterator;
import org.javarosa.core.services.storage.IStorageUtilityIndexed;

/**
 * The case-index reads Core's casedb makes, answered from the native Case records of one storage. Core's stock
 * TestInstanceInitializer supplies no physical case-index table, and a casedb predicate on an index
 * ({@code [index/parent = ...]}) reads one ({@code CaseInstanceTreeElement.performCaseIndexQuery}); Core still
 * parses, plans and evaluates every emitted XPath and processes the submission itself. The bulk paths Core takes
 * only over hundreds of cases are refused by name, so a run that reaches one fails rather than reading nothing.
 */
final class StorageCaseIndexTable implements CaseIndexTable {
    private final IStorageUtilityIndexed<Case> storage;

    StorageCaseIndexTable(IStorageUtilityIndexed<Case> storage) { this.storage = storage; }

    public LinkedHashSet<Integer> getCasesMatchingIndex(String name, String value) {
        LinkedHashSet<Integer> matches = new LinkedHashSet<>();
        for (IStorageIterator it = storage.iterate(false); it.hasMore();) {
            int id = it.nextID();
            if (value.equals(storage.read(id).getMetaData(Case.INDEX_CASE_INDEX_PRE + name))) matches.add(id);
        }
        return matches;
    }

    public LinkedHashSet<Integer> getCasesMatchingValueSet(String name, String[] values) {
        LinkedHashSet<Integer> matches = new LinkedHashSet<>();
        for (String value : values) matches.addAll(getCasesMatchingIndex(name, value));
        return matches;
    }

    public int loadIntoIndexTable(HashMap<String, Vector<Integer>> cache, String name) { throw new AssertionError("Unexpected bulk index read"); }
    public DualTableSingleMatchModelQuerySet bulkReadIndexToCaseIdMatch(String name, Collection<Integer> cases) { throw new AssertionError("Unexpected bulk join"); }
    public void indexCase(Case record) { throw new AssertionError("Unexpected index write"); }
    public void clearCaseIndices(Collection<Integer> ids) { throw new AssertionError("Unexpected index clear"); }
    public void delete() { throw new AssertionError("Unexpected index delete"); }
    public boolean isStorageExists() { return true; }
}
