import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import type {
  ConflictResolution,
  Criterion,
  JudgeState,
  RankingRow,
  RankingSnapshot,
  ReviewEvent,
  Scheme,
  SchemeStatus,
  ScoreDiff,
  ScoreRecord,
  Viewer,
} from "../types";

const KEY = "pair-wise-yf-48/ledger";
const judges: Viewer[] = ["评委-林策", "评委-周筑"];
const seedSchemes: Scheme[] = [
  { id: "a", code: "S-01", title: "潮间带公共客厅", synopsis: "通过退台屋面把社区活动引向水岸，底层保留可被潮水短暂侵入的公共空间。", publicNo: "投递号 7182", status: "待评分" },
  { id: "b", code: "S-02", title: "风廊共生院", synopsis: "以双庭院组织低能耗社区中心，利用贯穿体量连接既有街巷。", publicNo: "投递号 6610", status: "待评分" },
  { id: "c", code: "S-03", title: "折线工坊", synopsis: "保留旧修理厂桁架，置入可拆装工坊和培训空间。", publicNo: "投递号 8024", status: "待评分" },
];
const criteria: Criterion[] = [
  { id: "site", name: "场地回应", description: "与气候、地貌和周边公共空间的关系", weight: 30, max: 100 },
  { id: "program", name: "功能组织", description: "空间组织、流线和公共性", weight: 25, max: 100 },
  { id: "structure", name: "结构与建造", description: "结构逻辑、材料和建造可行性", weight: 25, max: 100 },
  { id: "sustain", name: "环境策略", description: "节能、碳排和长期维护", weight: 20, max: 100 },
];

function uid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

function scoreId(judge: Viewer, schemeId: string): string {
  return `${judge}::${schemeId}`;
}

function emptyScore(judge: Viewer, schemeId: string): ScoreRecord {
  return {
    id: scoreId(judge, schemeId),
    judge,
    schemeId,
    values: Object.fromEntries(criteria.map((item) => [item.id, 60])),
    comment: "",
    recused: false,
    submitted: false,
    updatedAt: new Date().toISOString(),
    version: 1,
    baseVersion: 0,
    sync: "pending",
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

interface PersistShape {
  online: boolean;
  ledger: Record<string, ScoreRecord>;
  conflicts: Record<string, ScoreRecord>;
  local: Record<string, Record<string, ScoreRecord>>;
  events: ReviewEvent[];
  locked: boolean;
  lockedSnapshot: RankingRow[] | null;
  archive: RankingSnapshot[];
  viewer: Viewer;
  lastSyncAt: string | null;
}

function load(): PersistShape {
  const fallback: PersistShape = {
    online: true,
    ledger: {},
    conflicts: {},
    local: {},
    events: [],
    locked: false,
    lockedSnapshot: null,
    archive: [],
    viewer: "评委-林策",
    lastSyncAt: null,
  };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PersistShape>;
    return { ...fallback, ...parsed };
  } catch {
    return fallback;
  }
}

export const useReviewStore = defineStore("review", () => {
  const initial = load();

  const viewer = ref<Viewer>(initial.viewer);
  const online = ref<boolean>(initial.online);
  const schemes = ref<Scheme[]>(seedSchemes.map((scheme) => ({ ...scheme })));
  /** 主办方台账：合并后的权威有效版本 */
  const ledger = ref<Record<string, ScoreRecord>>(initial.ledger);
  /** 主办方台账中的冲突分（后到、未决） */
  const conflicts = ref<Record<string, ScoreRecord>>(initial.conflicts);
  /** 各位评委的本地台账（断网可写） */
  const local = ref<Record<string, Record<string, ScoreRecord>>>(initial.local);
  const events = ref<ReviewEvent[]>(initial.events);
  const locked = ref<boolean>(initial.locked);
  const lockedSnapshot = ref<RankingRow[] | null>(initial.lockedSnapshot);
  const archive = ref<RankingSnapshot[]>(initial.archive);
  const lastSyncAt = ref<string | null>(initial.lastSyncAt);

  const isOrganizer = computed(() => viewer.value === "主办方");
  const judge = computed<Viewer | null>(() => (viewer.value.startsWith("评委-") ? (viewer.value as Viewer) : null));

  /** 主办方锁定前只能看到提交进度，看不到任何分值 */
  const visibleScores = computed<ScoreRecord[]>(() => {
    if (isOrganizer.value) return [];
    const mine = local.value[viewer.value] ?? {};
    return Object.values(mine);
  });

  function currentJudge(): Viewer | null {
    return viewer.value.startsWith("评委-") ? (viewer.value as Viewer) : null;
  }

  /** 越权提交一律拒绝 */
  function requireJudge(): Viewer {
    const j = currentJudge();
    if (!j) throw new Error("主办方不能提交或修改评分");
    return j;
  }

  function log(action: string, detail: string) {
    events.value.unshift({ id: uid(), time: new Date().toISOString(), actor: viewer.value, action, detail });
  }

  function schemeCode(schemeId: string): string {
    return schemes.value.find((s) => s.id === schemeId)?.code ?? schemeId;
  }

  /** 取当前评委在某方案上的本地记录（不存在则建空稿）；主办方返回 undefined */
  function record(schemeId: string): ScoreRecord | undefined {
    const j = currentJudge();
    if (!j) return undefined;
    const id = scoreId(j, schemeId);
    if (!local.value[j]) local.value[j] = {};
    if (!local.value[j][id]) local.value[j][id] = emptyScore(j, schemeId);
    return local.value[j][id];
  }

  /** 评委只能改自己的评分：校验记录归属 */
  function ensureOwn(rec: ScoreRecord) {
    const j = requireJudge();
    if (rec.judge !== j || rec.id !== scoreId(j, rec.schemeId)) {
      throw new Error("越权：不能修改其他评委的评分");
    }
  }

  function touchScheme(schemeId: string) {
    const scheme = schemes.value.find((s) => s.id === schemeId);
    if (!scheme) return;
    if (locked.value) {
      scheme.status = "已锁定";
      return;
    }
    scheme.status = statusFor(schemeId) === "已提交" ? "已提交" : "评分中";
  }

  function saveDraft(schemeId: string, values: Record<string, number>, comment: string, recused: boolean) {
    const rec = record(schemeId);
    if (!rec) return { ok: false as const, reason: "主办方不能保存评分" };
    ensureOwn(rec);
    if (rec.submitted) return { ok: false as const, reason: "评分已提交，请先退回修改" };
    rec.values = { ...values };
    rec.comment = comment;
    rec.recused = recused;
    rec.version += 1;
    rec.updatedAt = new Date().toISOString();
    rec.sync = "pending";
    touchScheme(schemeId);
    log("保存评分草稿", `${schemeCode(schemeId)}${recused ? "，声明利益冲突回避" : ""}（本地待同步）`);
    return { ok: true as const };
  }

  function submit(schemeId: string, values: Record<string, number>, comment: string, recused: boolean) {
    const rec = record(schemeId);
    if (!rec) return { ok: false as const, reason: "主办方不能提交评分" };
    ensureOwn(rec);
    // 幂等：同一 (judge, scheme) 始终是同一条记录，重复提交只更新不新增
    const wasSubmitted = rec.submitted;
    rec.values = { ...values };
    rec.comment = comment;
    rec.recused = recused;
    rec.submitted = true;
    rec.version += 1;
    rec.updatedAt = new Date().toISOString();
    rec.sync = "pending";
    touchScheme(schemeId);
    log(wasSubmitted ? "更新评分提交" : "提交评分", `${schemeCode(schemeId)}${recused ? "，利益冲突回避" : ""}（本地待同步）`);
    if (locked.value) invalidate("评分提交导致已锁定排名失效重算");
    return { ok: true as const };
  }

  function recalled(schemeId: string) {
    const rec = record(schemeId);
    if (!rec) return { ok: false as const, reason: "主办方不能退回评分" };
    ensureOwn(rec);
    if (!rec.submitted) return { ok: false as const, reason: "尚未提交，无需退回" };
    rec.submitted = false;
    rec.version += 1;
    rec.updatedAt = new Date().toISOString();
    rec.sync = "pending";
    touchScheme(schemeId);
    log("退回评分修改", `${schemeCode(schemeId)}（本地待同步）`);
    if (locked.value) invalidate("评分退回导致已锁定排名失效重算");
    return { ok: true as const };
  }

  /** 某评委对某方案的状态（以主办方台账为准，本地待同步稿作为评委本人的临时状态） */
  function judgeState(j: Viewer, schemeId: string): JudgeState {
    const id = scoreId(j, schemeId);
    const conflict = conflicts.value[id];
    if (conflict && !conflict.resolved) return "conflict";
    const r = ledger.value[id];
    if (r) {
      if (r.recused && !r.submitted) return "recused";
      if (r.submitted) return "submitted";
    }
    // 评委本人本地有未同步的提交/草稿
    if (j === currentJudge()) {
      const mine = local.value[j]?.[id];
      if (mine) {
        if (mine.recused && !mine.submitted) return "recused";
        if (mine.submitted) return "submitted";
      }
    }
    return "draft";
  }

  function statusFor(schemeId: string): SchemeStatus {
    if (locked.value) return "已锁定";
    const states = judges.map((j) => judgeState(j, schemeId));
    if (states.every((s) => s === "submitted" || s === "recused")) return "已提交";
    if (states.some((s) => s === "submitted" || s === "recused" || s === "conflict")) return "评分中";
    return "待评分";
  }

  interface Progress {
    submitted: number;
    recused: number;
    pending: number;
    conflict: number;
    total: number;
    complete: boolean;
  }

  function progress(schemeId: string): Progress {
    const states = judges.map((j) => judgeState(j, schemeId));
    const submitted = states.filter((s) => s === "submitted").length;
    const recused = states.filter((s) => s === "recused").length;
    const conflict = states.filter((s) => s === "conflict").length;
    const pending = states.filter((s) => s === "draft").length;
    return {
      submitted,
      recused,
      conflict,
      pending,
      total: judges.length,
      complete: states.every((s) => s === "submitted" || s === "recused") && conflict === 0,
    };
  }

  const hasUnresolvedConflicts = computed(() => Object.values(conflicts.value).some((c) => !c.resolved));

  const allComplete = computed(() => schemes.value.every((s) => progress(s.id).complete));

  const lockBlockReasons = computed<string[]>(() => {
    const reasons: string[] = [];
    const incomplete = schemes.value.filter((s) => !progress(s.id).complete);
    if (incomplete.length) reasons.push(`${incomplete.map((s) => s.code).join("、")} 仍有评委未提交或未回避`);
    if (hasUnresolvedConflicts.value) reasons.push("存在未解决的台账冲突分");
    return reasons;
  });

  const canLock = computed(() => !locked.value && allComplete.value && !hasUnresolvedConflicts.value);

  function computeDiff(later: ScoreRecord, first: ScoreRecord): ScoreDiff {
    const dimensions = criteria
      .map((c) => ({ id: c.id, name: c.name, later: later.values[c.id], first: first.values[c.id] }))
      .filter((d) => d.later !== d.first);
    return {
      dimensions,
      commentChanged: later.comment !== first.comment,
      recusedChanged: later.recused !== first.recused,
    };
  }

  /** 联网后把本地待同步合并进主办方台账；后到的冲突分保留并标差异，不盖掉先到版本 */
  function syncNow(): { ok: boolean; reason?: string; merged?: number; conflicts?: number } {
    if (!online.value) return { ok: false, reason: "当前断网，无法与主办方台账同步" };
    const j = currentJudge();
    if (!j) return { ok: false, reason: "主办方台账由系统合并，无需手动同步" };
    const mine = Object.values(local.value[j] ?? {});
    let merged = 0;
    let conflictCount = 0;
    for (const rec of mine) {
      if (rec.sync !== "pending") continue;
      // 越权：本地记录不属于当前身份则拒绝合并
      if (rec.judge !== j || rec.id !== scoreId(j, rec.schemeId)) {
        log("拒绝越权合并", `记录 ${rec.id} 不属于当前身份 ${j}`);
        continue;
      }
      const existing = ledger.value[rec.id];
      if (!existing) {
        // 先到：主办方台账无此版本，直接接收
        const accepted: ScoreRecord = { ...rec, sync: "synced", baseVersion: rec.version, conflictWith: undefined, diff: undefined, resolved: false };
        ledger.value[rec.id] = accepted;
        Object.assign(rec, { sync: "synced", baseVersion: rec.version, conflictWith: undefined, diff: undefined, resolved: false });
        merged += 1;
      } else if (existing.version === rec.baseVersion) {
        // 基于同一版本的推进，快进接收
        const accepted: ScoreRecord = { ...rec, sync: "synced", baseVersion: rec.version, conflictWith: undefined, diff: undefined, resolved: false };
        ledger.value[rec.id] = accepted;
        Object.assign(rec, { sync: "synced", baseVersion: rec.version, conflictWith: undefined, diff: undefined, resolved: false });
        merged += 1;
      } else {
        // 并发冲突：主办方台账已有更新的先到版本，后到版本留为冲突分
        const diff = computeDiff(rec, existing);
        const conflictRec: ScoreRecord = {
          ...rec,
          sync: "conflict",
          resolved: false,
          conflictWith: clone(existing),
          diff,
        };
        conflicts.value[rec.id] = conflictRec;
        Object.assign(rec, { sync: "conflict", resolved: false, conflictWith: clone(existing), diff });
        conflictCount += 1;
        log("台账冲突", `${schemeCode(rec.schemeId)} 后到评分与先到版本不一致，已保留先到版本，冲突分不计入有效评委数`);
      }
    }
    lastSyncAt.value = new Date().toISOString();
    if (merged || conflictCount) {
      log("同步台账", `${j} 合并 ${merged} 条评分${conflictCount ? `，${conflictCount} 条留为冲突分` : ""}`);
    }
    if (locked.value && (merged || conflictCount)) {
      invalidate("同步合并导致评分变动，已锁定排名失效重算");
    }
    return { ok: true, merged, conflicts: conflictCount };
  }

  /** 断网/联网切换 */
  function setOnline(value: boolean) {
    online.value = value;
    log(value ? "网络已连接" : "网络已断开", value ? "恢复与主办方台账同步" : "断网期间评分保存在本地");
  }

  /**
   * 演示辅助：模拟另一台设备（或另一份本地副本）的版本先到主办方台账，
   * 制造乐观并发冲突的条件。随后在断网下改分再联网同步即产生冲突分。
   */
  function simulateConcurrent(schemeId: string) {
    const j = requireJudge();
    const id = scoreId(j, schemeId);
    const existing = ledger.value[id];
    if (!existing) return { ok: false as const, reason: "请先联网同步一次评分，再模拟另一台设备并发" };
    const mine = local.value[j]?.[id];
    const base = mine ?? emptyScore(j, schemeId);
    const nextVersion = existing.version + 1;
    const bumpedSite = Math.min(100, (base.values.site ?? 60) + 12);
    const other: ScoreRecord = {
      ...base,
      values: { ...base.values, site: bumpedSite },
      comment: `${base.comment}（另一台设备先到版本）`.trim(),
      version: nextVersion,
      baseVersion: nextVersion,
      sync: "synced",
      updatedAt: new Date().toISOString(),
    };
    ledger.value[id] = other;
    if (local.value[j]?.[id]) {
      // 本地仍停留在较旧的基线版本，联网合并时即判定为后到冲突
      local.value[j][id].baseVersion = base.baseVersion;
    }
    log("模拟并发先到", `${schemeCode(schemeId)} 另一台设备的版本已先到主办方台账`);
    return { ok: true as const };
  }

  /** 冲突确认：keep-first 保留先到版本；accept-later 采纳后到版本 */
  function resolveConflict(schemeId: string, resolution: ConflictResolution) {
    const target = Object.values(conflicts.value).find((c) => c.schemeId === schemeId && !c.resolved);
    if (!target) return { ok: false as const, reason: "没有待处理的冲突" };
    const scoreIdStr = target.id;
    if (resolution === "keep-first") {
      target.resolved = true;
      target.resolution = "keep-first";
      // 保留先到版本：以主办方台账现有版本为准，并回写评委本地，避免本地长期挂起
      const kept = clone(ledger.value[scoreIdStr] ?? target.conflictWith);
      if (kept) {
        kept.sync = "synced";
        kept.resolved = true;
        if (local.value[target.judge]?.[scoreIdStr]) {
          local.value[target.judge][scoreIdStr] = { ...kept };
        }
      }
      log("冲突确认", `${schemeCode(schemeId)} 保留先到版本，冲突已解决`);
    } else {
      const accepted: ScoreRecord = {
        ...target,
        sync: "synced",
        resolved: true,
        resolution: "accept-later",
        baseVersion: target.version,
        conflictWith: undefined,
        diff: undefined,
      };
      ledger.value[scoreIdStr] = accepted;
      const j = target.judge;
      if (local.value[j]?.[scoreIdStr]) {
        local.value[j][scoreIdStr] = { ...accepted };
      }
      target.resolved = true;
      log("冲突确认", `${schemeCode(schemeId)} 采纳后到版本，冲突已解决`);
    }
    if (locked.value) invalidate("冲突确认导致排名变动，已锁定排名失效重算");
    return { ok: true as const };
  }

  /** 排名：以主办方台账有效版本为准；利益冲突回避与未解决冲突分均不计入有效评委数 */
  const rankingRows = computed<RankingRow[]>(() => {
    return schemes.value.map((scheme) => {
      const valid: ScoreRecord[] = [];
      for (const j of judges) {
        const id = scoreId(j, scheme.id);
        if (conflicts.value[id] && !conflicts.value[id].resolved) continue; // 未解决冲突分不计入
        const r = ledger.value[id];
        if (r && r.submitted && !r.recused && r.sync !== "conflict") valid.push(r);
      }
      const total = valid.length
        ? valid.reduce((sum, r) => sum + criteria.reduce((s, c) => s + r.values[c.id] * c.weight / 100, 0), 0) / valid.length
        : 0;
      return {
        schemeId: scheme.id,
        code: scheme.code,
        title: scheme.title,
        total: Number(total.toFixed(2)),
        judgeCount: valid.length,
        recusedCount: judges.filter((j) => ledger.value[scoreId(j, scheme.id)]?.recused).length,
        conflictCount: Object.values(conflicts.value).filter((c) => c.schemeId === scheme.id && !c.resolved).length,
      };
    }).sort((a, b) => b.total - a.total);
  });

  /** 当前用于展示的排名：锁定时用留档快照，否则实时重算 */
  const displayRanking = computed<RankingRow[]>(() => (locked.value && lockedSnapshot.value ? lockedSnapshot.value : rankingRows.value));

  function invalidate(reason: string) {
    if (!locked.value) return;
    if (lockedSnapshot.value) {
      archive.value.unshift({
        id: uid(),
        lockedAt: new Date().toISOString(),
        reason,
        rows: lockedSnapshot.value,
      });
    }
    locked.value = false;
    lockedSnapshot.value = null;
    schemes.value.forEach((s) => { s.status = statusFor(s.id); });
    log("排名失效重算", reason);
  }

  function lock() {
    if (locked.value) return { ok: false as const, reason: "结果已锁定" };
    if (!canLock.value) return { ok: false as const, reason: lockBlockReasons.value.join("；") || "暂不满足锁定条件" };
    lockedSnapshot.value = clone(rankingRows.value);
    locked.value = true;
    schemes.value.forEach((s) => { s.status = "已锁定"; });
    log("锁定并发布结果", `${schemes.value.length} 个匿名方案，名次已留档`);
    return { ok: true as const };
  }

  function setViewer(value: Viewer) {
    viewer.value = value;
    log("切换身份", value);
  }

  // 持久化：草稿、冲突、名次、锁定状态在刷新后仍然保留
  watch(
    () => ({
      online: online.value,
      ledger: ledger.value,
      conflicts: conflicts.value,
      local: local.value,
      events: events.value,
      locked: locked.value,
      lockedSnapshot: lockedSnapshot.value,
      archive: archive.value,
      viewer: viewer.value,
      lastSyncAt: lastSyncAt.value,
    }),
    (state) => {
      localStorage.setItem(KEY, JSON.stringify(state));
    },
    { deep: true },
  );

  return {
    // state
    viewer, online, schemes, criteria, judges, ledger, conflicts, local, events, locked, lockedSnapshot, archive, lastSyncAt,
    // derived
    isOrganizer, judge, visibleScores, hasUnresolvedConflicts, allComplete, lockBlockReasons, canLock, rankingRows, displayRanking,
    // actions
    setViewer, setOnline, record, saveDraft, submit, recalled, syncNow, simulateConcurrent, resolveConflict, lock, invalidate,
    progress, judgeState, statusFor, schemeCode,
  };
});
