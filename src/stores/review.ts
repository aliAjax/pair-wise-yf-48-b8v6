import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import type { Draft, JudgeName, Op, SubmitOp, Viewer } from "../types";
import { criteria, judges, schemes } from "../ledger/data";
import {
  applyClientOps,
  computeRows,
  confirmConflict as serverConfirmConflict,
  getServerState,
  ledgerChannel,
  lockRankings as serverLockRankings,
  type ServerState
} from "../ledger/server";

/**
 * 本地优先的评审台账客户端：
 * - 草稿与待同步队列持久化在 sessionStorage（当前设备），刷新后仍在；
 * - 断网时照常填写维度与评审意见，提交进入本地队列；
 * - 联网后把队列并入主办方台账，并拉取最新台账与留档名次。
 */

const CLIENT_KEY = "pair-wise-yf-48/client";

interface ClientSnapshot {
  viewer: Viewer;
  manualOffline: boolean;
  drafts: Draft[];
  outbox: Op[];
}

function loadClient(): ClientSnapshot {
  try {
    const raw = sessionStorage.getItem(CLIENT_KEY);
    if (raw) return JSON.parse(raw) as ClientSnapshot;
  } catch {
    // 忽略损坏的本地快照，按全新设备处理
  }
  return { viewer: "评委-林策", manualOffline: false, drafts: [], outbox: [] };
}

export interface Outcome {
  ok: boolean;
  detail: string;
  /** 本次修改是否仅进入本地队列（离线） */
  queued?: boolean;
  /** 合并后仍积压在队列中的条数 */
  pending?: number;
  applied?: number;
  conflict?: number;
  duplicate?: number;
  rejected?: number;
}

export const useReviewStore = defineStore("review", () => {
  const saved = loadClient();
  const viewer = ref<Viewer>(saved.viewer);
  const manualOffline = ref(saved.manualOffline);
  const drafts = ref<Draft[]>(saved.drafts);
  const outbox = ref<Op[]>(saved.outbox);

  const server = ref<ServerState>(getServerState());
  const networkOn = ref(navigator.onLine);
  const syncing = ref(false);
  const lastSyncAt = ref<string | null>(null);

  const online = computed(() => networkOn.value && !manualOffline.value);
  const isOrganizer = computed(() => viewer.value === "主办方");
  const judge = computed<JudgeName | null>(() => (viewer.value === "主办方" ? null : viewer.value));
  /** 结果是否曾锁定发布过：发布后分值对主办方不再是秘密 */
  const revealed = computed(() => server.value.rankings.length > 0);
  const currentLock = computed(() => server.value.rankings.find((row) => row.id === server.value.currentLockId) ?? null);
  const liveRows = computed(() => computeRows(server.value.entries));
  const rankings = computed(() => server.value.rankings);
  const events = computed(() => server.value.events);
  const openConflicts = computed(() => server.value.conflicts.filter((item) => item.status === "未解决"));
  const visibleConflicts = computed(() => (isOrganizer.value ? server.value.conflicts : server.value.conflicts.filter((item) => item.judge === judge.value)));
  const pendingOps = computed(() => outbox.value);

  const progress = computed(() =>
    schemes.map((scheme) => {
      const entry = server.value.entries[scheme.id];
      const submittedCount = judges.filter((name) => entry?.scores.some((score) => score.judge === name && score.submitted)).length;
      const effective = entry?.scores.filter((score) => score.submitted && !score.coi).length ?? 0;
      const open = openConflicts.value.filter((item) => item.schemeId === scheme.id).length;
      return { scheme, submittedCount, judgeTotal: judges.length, effective, openConflicts: open, complete: submittedCount === judges.length };
    })
  );
  const canLock = computed(() => progress.value.every((item) => item.complete) && openConflicts.value.length === 0);

  function pull() {
    server.value = getServerState();
  }

  ledgerChannel.onmessage = () => {
    if (online.value) pull();
  };
  window.addEventListener("online", () => {
    networkOn.value = true;
    void syncNow();
  });
  window.addEventListener("offline", () => {
    networkOn.value = false;
  });

  watch(
    [viewer, manualOffline, drafts, outbox],
    () => {
      const snapshot: ClientSnapshot = { viewer: viewer.value, manualOffline: manualOffline.value, drafts: drafts.value, outbox: outbox.value };
      sessionStorage.setItem(CLIENT_KEY, JSON.stringify(snapshot));
    },
    { deep: true }
  );

  function setViewer(value: Viewer) {
    viewer.value = value;
  }

  function setManualOffline(value: boolean) {
    manualOffline.value = value;
    if (!value) void syncNow();
  }

  function entryOf(schemeId: string) {
    return server.value.entries[schemeId] ?? null;
  }
  function ownEntry(schemeId: string) {
    const name = judge.value;
    return name ? entryOf(schemeId)?.scores.find((score) => score.judge === name) ?? null : null;
  }
  function draftOf(schemeId: string) {
    const name = judge.value;
    return name ? drafts.value.find((draft) => draft.judge === name && draft.schemeId === schemeId) ?? null : null;
  }
  function pendingOf(schemeId: string) {
    const name = judge.value;
    return name ? outbox.value.find((op) => op.judge === name && op.schemeId === schemeId) ?? null : null;
  }
  function openConflictOf(schemeId: string) {
    const name = judge.value;
    return name ? openConflicts.value.find((item) => item.judge === name && item.schemeId === schemeId) ?? null : null;
  }

  function schemeStatus(schemeId: string): "待评分" | "评分中" | "已提交" | "已锁定" {
    if (currentLock.value) return "已锁定";
    const item = progress.value.find((row) => row.scheme.id === schemeId);
    if (item?.complete) return "已提交";
    if ((item?.submittedCount ?? 0) > 0 || draftOf(schemeId) || pendingOf(schemeId)) return "评分中";
    return "待评分";
  }

  /** 断网时照常保存：草稿只写本地，不并入台账 */
  function saveDraft(schemeId: string, values: Record<string, number>, comment: string, coi: boolean): Outcome {
    const name = judge.value;
    if (!name) return { ok: false, detail: "越权操作被拒绝：主办方身份不能填写评分" };
    const next: Draft = { judge: name, schemeId, values: { ...values }, comment, coi, updatedAt: new Date().toISOString() };
    drafts.value = [...drafts.value.filter((draft) => !(draft.judge === name && draft.schemeId === schemeId)), next];
    return { ok: true, detail: online.value ? "草稿已保存到本地" : "离线中：草稿已保存到本地，联网后可提交合并" };
  }

  /** 提交：先进本地队列（同方案待提交合并为一条），联网即合并到主办方台账 */
  async function submit(schemeId: string, values: Record<string, number>, comment: string, coi: boolean): Promise<Outcome> {
    const name = judge.value;
    if (!name) return { ok: false, detail: "越权提交被拒绝：主办方身份不能提交评分" };
    const baseRev = entryOf(schemeId)?.rev ?? 0;
    const pending = outbox.value.find((op): op is SubmitOp => op.kind === "submit" && op.judge === name && op.schemeId === schemeId);
    if (pending) {
      // 重复点击/反复修改只更新同一条待同步记录，请求号不变
      pending.values = { ...values };
      pending.comment = comment;
      pending.coi = coi;
      pending.baseRev = baseRev;
      pending.at = new Date().toISOString();
    } else {
      outbox.value.push({ kind: "submit", id: crypto.randomUUID(), judge: name, schemeId, values: { ...values }, comment, coi, baseRev, at: new Date().toISOString() });
    }
    drafts.value = drafts.value.filter((draft) => !(draft.judge === name && draft.schemeId === schemeId));
    if (online.value) return syncNow();
    return { ok: true, queued: true, detail: "已存入本地待同步队列，联网后自动合并到主办方台账" };
  }

  async function recall(schemeId: string): Promise<Outcome> {
    const name = judge.value;
    if (!name) return { ok: false, detail: "越权操作被拒绝：主办方身份不能退回评分" };
    outbox.value.push({ kind: "recall", id: crypto.randomUUID(), judge: name, schemeId, baseRev: entryOf(schemeId)?.rev ?? 0, at: new Date().toISOString() });
    if (online.value) return syncNow();
    return { ok: true, queued: true, detail: "退回请求已存入本地队列，联网后同步" };
  }

  /** 联网合并：推送本地队列并拉取主办方台账 */
  async function syncNow(): Promise<Outcome> {
    if (!online.value) {
      return { ok: false, pending: outbox.value.length, detail: "当前离线，修改已保存在本地，恢复联网后自动合并" };
    }
    if (syncing.value) {
      return { ok: true, detail: "正在合并主办方台账…" };
    }
    syncing.value = true;
    try {
      const results = applyClientOps(viewer.value, [...outbox.value]);
      const done = new Set(results.map((result) => result.op.id));
      outbox.value = outbox.value.filter((op) => !done.has(op.id));
      pull();
      lastSyncAt.value = new Date().toISOString();
      const count = (status: (typeof results)[number]["status"]) => results.filter((result) => result.status === status).length;
      const summary = { applied: count("applied"), conflict: count("conflict"), duplicate: count("duplicate"), rejected: count("rejected") };
      const parts: string[] = [];
      if (summary.applied) parts.push(`并入台账 ${summary.applied} 条`);
      if (summary.conflict) parts.push(`后到并发评分 ${summary.conflict} 条已留为冲突分`);
      if (summary.duplicate) parts.push(`忽略重复提交 ${summary.duplicate} 条`);
      if (summary.rejected) parts.push(`拒绝越权提交 ${summary.rejected} 条`);
      return {
        ok: summary.rejected === 0,
        ...summary,
        pending: outbox.value.length,
        detail: parts.length ? `已合并主办方台账：${parts.join("，")}` : "已与主办方台账合并，本地没有待同步的修改"
      };
    } finally {
      syncing.value = false;
    }
  }

  function resolveConflict(conflictId: string, decision: "withdraw" | "adopt"): Outcome {
    const result = serverConfirmConflict(viewer.value, conflictId, decision);
    pull();
    return result;
  }

  function lock(): Outcome {
    const result = serverLockRankings(viewer.value);
    pull();
    return result;
  }

  // 启动时若联网且有积压，立即合并一次
  if (online.value && outbox.value.length) void syncNow();

  return {
    viewer,
    manualOffline,
    online,
    networkOn,
    syncing,
    lastSyncAt,
    drafts,
    schemes,
    criteria,
    judges,
    isOrganizer,
    judge,
    revealed,
    currentLock,
    liveRows,
    rankings,
    events,
    openConflicts,
    visibleConflicts,
    pendingOps,
    progress,
    canLock,
    setViewer,
    setManualOffline,
    entryOf,
    ownEntry,
    draftOf,
    pendingOf,
    openConflictOf,
    schemeStatus,
    saveDraft,
    submit,
    recall,
    syncNow,
    resolveConflict,
    lock
  };
});
