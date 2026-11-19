package nova.proof.core;

import org.commcare.cases.model.Case;
import org.commcare.cases.model.CaseIndex;
import org.commcare.cases.query.queryset.DualTableSingleMatchModelQuerySet;
import org.commcare.modern.engine.cases.CaseIndexTable;
import org.javarosa.core.services.storage.IStorageIterator;
import org.javarosa.core.services.storage.IStorageUtilityIndexed;

import java.util.Arrays;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.Vector;

/**
 * The case index table Core's case instance reads a case's indices through, answered from the case
 * storage itself.
 *
 * Each runtime keeps such a table beside its case table and gives it to the casedb instance:
 * Formplayer's FormplayerCaseIndexTable (one row an index: the indexing case's record id, the index's
 * name, and the target case's id) and Android's AndroidCaseIndexTable. Core's own
 * CommCareInstanceInitializer gives its CaseInstanceTreeElement none, so a query Core plans through a
 * case's indices, a predicate on index/<name> (CaseInstanceTreeElement.performCaseIndexQuery) or a list
 * reading each row's related case in bulk (CaseIndexQuerySetTransform), raises NullPointerException on
 * Core's plain engine where every runtime answers. This table answers each query from the cases the
 * storage holds when it is asked, in record id order, as the runtimes' tables answer from the rows
 * they keep in step with that storage, so it is never behind a submission and writes nothing.
 */
final class CaseIndexes implements CaseIndexTable {
    private final IStorageUtilityIndexed<Case> storage;

    CaseIndexes(IStorageUtilityIndexed<Case> storage) {
        this.storage = storage;
    }

    /** Each case's record id with the targets of its indices named indexName, in record id order. */
    private LinkedHashSet<Integer> casesIndexing(String indexName, Set<String> targets) {
        LinkedHashSet<Integer> found = new LinkedHashSet<>();
        for (IStorageIterator<Case> cases = storage.iterate(); cases.hasMore(); ) {
            Case c = cases.nextRecord();
            for (CaseIndex index : c.getIndices()) {
                if (index.getName().equals(indexName) && targets.contains(index.getTarget())) {
                    found.add(c.getID());
                }
            }
        }
        return found;
    }

    @Override
    public int loadIntoIndexTable(HashMap<String, Vector<Integer>> indexCache, String indexName) {
        int loaded = 0;
        for (IStorageIterator<Case> cases = storage.iterate(); cases.hasMore(); ) {
            Case c = cases.nextRecord();
            for (CaseIndex index : c.getIndices()) {
                if (!index.getName().equals(indexName)) {
                    continue;
                }
                loaded++;
                indexCache.computeIfAbsent(indexName + "|" + index.getTarget(), key -> new Vector<>()).add(c.getID());
            }
        }
        return loaded;
    }

    /**
     * For each cued case, the record id of the case its index indexName targets, as
     * FormplayerCaseIndexTable.bulkReadIndexToCaseIdMatch joins its index rows to the case table on the
     * target's case id.
     */
    @Override
    public DualTableSingleMatchModelQuerySet bulkReadIndexToCaseIdMatch(String indexName,
            Collection<Integer> cuedCases) {
        DualTableSingleMatchModelQuerySet set = new DualTableSingleMatchModelQuerySet();
        for (Integer recordId : cuedCases) {
            Case c = storage.read(recordId);
            for (CaseIndex index : c.getIndices()) {
                if (!index.getName().equals(indexName)) {
                    continue;
                }
                for (Integer target : storage.getIDsForValue(Case.INDEX_CASE_ID, index.getTarget())) {
                    set.loadResult(recordId, target);
                }
            }
        }
        return set;
    }

    @Override
    public LinkedHashSet<Integer> getCasesMatchingValueSet(String indexName, String[] valueSet) {
        return casesIndexing(indexName, new HashSet<>(Arrays.asList(valueSet)));
    }

    @Override
    public LinkedHashSet<Integer> getCasesMatchingIndex(String indexName, String value) {
        Set<String> target = new HashSet<>();
        target.add(value);
        return casesIndexing(indexName, target);
    }

    /** The table is read from the storage, so a case's indices need no row of their own. */
    @Override
    public void indexCase(Case c) {
    }

    @Override
    public void clearCaseIndices(Collection<Integer> idsToClear) {
    }

    @Override
    public void delete() {
    }

    @Override
    public boolean isStorageExists() {
        return true;
    }
}
