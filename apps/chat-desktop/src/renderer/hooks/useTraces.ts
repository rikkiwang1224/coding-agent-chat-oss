import { useCallback, useEffect, useState } from "react";
import { getDesktopConfig } from "@/hooks/useDesktopConfig";
import type { DesktopTraceDetail, TraceSummary } from "@/types";

export interface SelectedTrace {
  workspaceRoot: string;
  sessionId: string;
}

export function useTraces() {
  const [summaries, setSummaries] = useState<TraceSummary[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [selected, setSelected] = useState<SelectedTrace | null>(null);
  const [detail, setDetail] = useState<DesktopTraceDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const refreshList = useCallback(async () => {
    const config = getDesktopConfig();
    const listFn = config.listAllTraces ?? config.listTraces;
    if (!listFn) {
      setListError("Trace API unavailable");
      return;
    }
    setLoadingList(true);
    setListError(null);
    try {
      const items = config.listAllTraces ? await config.listAllTraces() : await config.listTraces!();
      setSummaries(items);
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Failed to load traces");
      setSummaries([]);
    } finally {
      setLoadingList(false);
    }
  }, []);

  const loadDetail = useCallback(async (workspaceRoot: string, sessionId: string) => {
    const config = getDesktopConfig();
    if (!config.loadTrace) {
      setDetailError("Trace API unavailable");
      return;
    }
    setSelected({ workspaceRoot, sessionId });
    setLoadingDetail(true);
    setDetailError(null);
    setDetail(null);
    try {
      const result = await config.loadTrace(workspaceRoot, sessionId);
      if (!result) {
        setDetailError("Trace file not found");
        return;
      }
      setDetail(result);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : "Failed to load trace");
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  useEffect(() => {
    void refreshList();
    setSelected(null);
    setDetail(null);
  }, [refreshList]);

  return {
    summaries,
    loadingList,
    listError,
    refreshList,
    selected,
    detail,
    loadingDetail,
    detailError,
    loadDetail,
    setSelected,
  };
}
