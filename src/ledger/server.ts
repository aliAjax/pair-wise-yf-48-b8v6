import type {
  ApplyResult,
  ConflictScore,
  Op,
  RankingRow,
  RankingSnapshot,
  RecallOp,
  ReviewEvent,
  SchemeLedger,
  ScoreEntry,
  SubmitOp,
  Viewer
} from "../types";
import { criteria, judges, schemeOf, schemes, weightedTotal } from "./data";

/**
 * 主办方中心台账的本地模拟：
 * 状态持久化在独立 localStorage 键下，所有写操作读-改-写一次完成，
 * 并通过 BroadcastChannel 通知其他标签页（模拟联网后的多端合并）。
 */

const SERVER_KEY = "pair-wise-yf-48/server";
const MAX_EVENTS = 200;

export const ledgerChannel = new BroadcastChannel("pair-wise-yf-48/ledger");

export interface ServerState {
  entries: Record<string, SchemeLedger>;
  conflicts: ConflictScore[];
  rankings: RankingSnapshot[];
  currentLockId: string | null;
  events: ReviewEvent[];
  /** 已处理的客户端请求号，保证重复提交只生成一条记录 */
  processedOps: string[];
}

function blankState(): ServerState {
  const state: ServerState = {
    entries: Object.fromEntries(schemes.map((scheme) => [scheme.id, { schemeId: scheme.id, rev: 0, scores: [] }])),
    conflicts: [],
    rankings: [],
    currentLockId: null,
    events: [],
    processedOps: []
  };
  pushEvent(state, "系统", "台账初始化", "主办方台账已建立，等待评委评分同步");
  return state;
}

export function getServerState(): ServerState {
  const raw = localStorage.getItem(SERVER_KEY);
  if (!raw) {
    const state = blankState();
    localStorage.setItem(SERVER_KEY, JSON.stringify(state));
    return state;
  }
  try {
    return JSON.parse(raw) as ServerState;
  } catch {
    const state = blankState();
    localStorage.setItem(SERVER_KEY, JSON.stringify(state));
    return state;
  }
}

function saveServer(state: ServerState) {
  localStorage.setItem(SERVER_KEY, JSON.stringify(state));
  ledgerChannel.postMessage({ type: "ledger-changed", at: new Date().toISOString() });
}

function pushEvent(state: ServerState, actor: ReviewEvent["actor"], action: string, detail: string) {
  state.events.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), actor, action, detail });
  if (state.events.length > MAX_EVENTS) state.events.length = MAX_EVENTS;
}

/** 锁定中的名次遇到评分改动或冲突确认即失效重算，快照保留在留档中 */
function invalidateLock(state: ServerState, reason: string) {
  if (!state.currentLockId) return;
  const snapshot = state.rankings.find((row) => row.id === state.currentLockId);
  if (snapshot && snapshot.status === "有效") {
    snapshot.status = "已失效";
    snapshot.invalidatedAt = new Date().toISOString();
    snapshot.invalidateReason = reason;
  }
  state.currentLockId = null;
  pushEvent(state, "系统", "锁定失效", `已锁定名次因「${reason}」失效，排名按最新台账重算，需重新锁定`);
}

/** 按当前台账实时计算排名（含并列名次），有效评委数不含利益冲突与未解决冲突分 */
export function computeRows(entries: Record<string, SchemeLedger>): RankingRow[] {
  const rows = schemes.map((scheme) => {
    const entry = entries[scheme.id] ?? { schemeId: scheme.id, rev: 0, scores: [] };
    const valid = entry.scores.filter((score) => score.submitted && !score.coi);
    const total = valid.length ? valid.reduce((sum, score) => sum + weightedTotal(score.values), 0) / valid.length : 0;
    return {
      schemeId: scheme.id,
      code: scheme.code,
      title: scheme.title,
      total: Number(total.toFixed(2)),
      judgeCount: valid.length,
      coiCount: entry.scores.filter((score) => score.submitted && score.coi).length,
      rank: 0
    };
  });
  rows.sort((a, b) => b.total - a.total);
  rows.forEach((row) => {
    row.rank = 1 + rows.filter((other) => other.total > row.total).length;
  });
  return rows;
}

function sameContent(score: ScoreEntry, op: SubmitOp): boolean {
  return (
    score.submitted &&
    score.comment === op.comment &&
    score.coi === op.coi &&
    criteria.every((criterion) => score.values[criterion.id] === op.values[criterion.id])
  );
}

function applySubmit(state: ServerState, actor: Viewer, op: SubmitOp): ApplyResult {
  const code = schemeOf(op.schemeId)?.code ?? op.schemeId;
  if (state.processedOps.includes(op.id)) {
    return { op, status: "duplicate", detail: `${code}：重复提交已忽略` };
  }
  if (actor !== op.judge) {
    pushEvent(state, "系统", "越权提交被拒绝", `${actor} 试图以 ${op.judge} 名义提交 ${code} 的评分`);
    return { op, status: "rejected", detail: `越权提交被拒绝：只能提交本人（${op.judge}）的评分` };
  }
  const entry = state.entries[op.schemeId];
  if (!entry) {
    return { op, status: "rejected", detail: `${code}：方案不存在` };
  }
  state.processedOps.push(op.id);
  if (op.baseRev !== entry.rev) {
    // 并发修改：后到的留为冲突分并标出差异，不覆盖台账中先到的内容
    const priorOwn = entry.scores.find((score) => score.judge === op.judge) ?? null;
    const conflict: ConflictScore = {
      id: crypto.randomUUID(),
      schemeId: op.schemeId,
      judge: op.judge,
      baseRev: op.baseRev,
      entryRev: entry.rev,
      incoming: { judge: op.judge, schemeId: op.schemeId, values: { ...op.values }, comment: op.comment, coi: op.coi, submitted: true, updatedAt: op.at },
      priorOwn: priorOwn ? { ...priorOwn, values: { ...priorOwn.values } } : null,
      peers: entry.scores.map((score) => ({ judge: score.judge, submitted: score.submitted })),
      status: "未解决",
      createdAt: new Date().toISOString()
    };
    state.conflicts.unshift(conflict);
    pushEvent(state, op.judge, "冲突分留存", `${code}：本地编辑基于台账 v${op.baseRev}，到账时已是 v${entry.rev}，后到评分留为冲突分待确认`);
    return { op, status: "conflict", detail: `${code}：与台账并发修改，已留为冲突分` };
  }
  const existing = entry.scores.find((score) => score.judge === op.judge);
  if (existing && sameContent(existing, op)) {
    return { op, status: "duplicate", detail: `${code}：内容一致，重复提交只保留一条记录` };
  }
  const next: ScoreEntry = { judge: op.judge, schemeId: op.schemeId, values: { ...op.values }, comment: op.comment, coi: op.coi, submitted: true, updatedAt: op.at };
  entry.scores = [...entry.scores.filter((score) => score.judge !== op.judge), next];
  entry.rev += 1;
  invalidateLock(state, "评分改动");
  pushEvent(state, op.judge, "提交评分", `${code} 评分已并入主办方台账（v${entry.rev}）`);
  return { op, status: "applied", detail: `${code}：已并入台账` };
}

function applyRecall(state: ServerState, actor: Viewer, op: RecallOp): ApplyResult {
  const code = schemeOf(op.schemeId)?.code ?? op.schemeId;
  if (state.processedOps.includes(op.id)) {
    return { op, status: "duplicate", detail: `${code}：重复退回已忽略` };
  }
  if (actor !== op.judge) {
    pushEvent(state, "系统", "越权操作被拒绝", `${actor} 试图退回 ${op.judge} 在 ${code} 的评分`);
    return { op, status: "rejected", detail: "越权操作被拒绝：只能退回本人的评分" };
  }
  const entry = state.entries[op.schemeId];
  if (!entry) {
    return { op, status: "rejected", detail: `${code}：方案不存在` };
  }
  state.processedOps.push(op.id);
  const existing = entry.scores.find((score) => score.judge === op.judge && score.submitted);
  if (!existing) {
    return { op, status: "duplicate", detail: `${code}：没有可退回的已提交评分` };
  }
  existing.submitted = false;
  existing.updatedAt = op.at;
  entry.rev += 1;
  invalidateLock(state, "评分改动");
  pushEvent(state, op.judge, "退回评分", `${code} 评分已退回修改（v${entry.rev}）`);
  return { op, status: "applied", detail: `${code}：已退回修改` };
}

/** 联网合并：把本地待同步操作按顺序并入主办方台账 */
export function applyClientOps(actor: Viewer, ops: Op[]): ApplyResult[] {
  if (!ops.length) return [];
  const state = getServerState();
  const results = ops.map((op) => (op.kind === "submit" ? applySubmit(state, actor, op) : applyRecall(state, actor, op)));
  saveServer(state);
  return results;
}

/** 冲突确认：只能由冲突分所属的评委本人操作；确认后锁定名次失效重算 */
export function confirmConflict(actor: Viewer, conflictId: string, decision: "withdraw" | "adopt"): { ok: boolean; detail: string } {
  const state = getServerState();
  const conflict = state.conflicts.find((item) => item.id === conflictId);
  if (!conflict || conflict.status !== "未解决") {
    return { ok: false, detail: "冲突分不存在或已解决" };
  }
  const code = schemeOf(conflict.schemeId)?.code ?? conflict.schemeId;
  if (actor !== conflict.judge) {
    pushEvent(state, "系统", "越权操作被拒绝", `${actor} 试图处理 ${conflict.judge} 在 ${code} 的冲突分`);
    saveServer(state);
    return { ok: false, detail: "越权操作被拒绝：只能由本人确认冲突分" };
  }
  const entry = state.entries[conflict.schemeId];
  if (decision === "adopt") {
    // 评委看清差异后明确采用自己的后到评分：作为一次新的正式提交计入台账
    entry.scores = [
      ...entry.scores.filter((score) => score.judge !== conflict.judge),
      { ...conflict.incoming, values: { ...conflict.incoming.values }, submitted: true, updatedAt: new Date().toISOString() }
    ];
    entry.rev += 1;
    conflict.status = "已采用";
    pushEvent(state, conflict.judge, "冲突确认", `${code}：采用后到评分并重新并入台账（v${entry.rev}）`);
  } else {
    conflict.status = "已撤回";
    pushEvent(state, conflict.judge, "冲突确认", `${code}：撤回后到评分，保留台账先到版本`);
  }
  conflict.resolvedAt = new Date().toISOString();
  invalidateLock(state, "冲突确认");
  saveServer(state);
  return { ok: true, detail: decision === "adopt" ? `${code}：已采用你的评分并重新计入排名` : `${code}：已撤回后到评分` };
}

/** 锁定发布：全部方案齐备且冲突全部解决后才能锁定 */
export function lockRankings(actor: Viewer): { ok: boolean; detail: string } {
  const state = getServerState();
  if (actor !== "主办方") {
    pushEvent(state, "系统", "越权锁定被拒绝", `${actor} 试图锁定发布结果`);
    saveServer(state);
    return { ok: false, detail: "越权操作被拒绝：只有主办方可以锁定结果" };
  }
  const incomplete = schemes.filter((scheme) => {
    const entry = state.entries[scheme.id];
    return !judges.every((judge) => entry?.scores.some((score) => score.judge === judge && score.submitted));
  });
  if (incomplete.length) {
    return { ok: false, detail: `仍有方案未齐备：${incomplete.map((scheme) => scheme.code).join("、")}` };
  }
  const open = state.conflicts.filter((conflict) => conflict.status === "未解决");
  if (open.length) {
    return { ok: false, detail: `仍有 ${open.length} 条冲突分未解决，不能锁定` };
  }
  const snapshot: RankingSnapshot = {
    id: crypto.randomUUID(),
    lockedAt: new Date().toISOString(),
    lockedBy: actor,
    status: "有效",
    rows: computeRows(state.entries)
  };
  state.rankings.unshift(snapshot);
  state.currentLockId = snapshot.id;
  pushEvent(state, actor, "锁定并发布结果", `${schemes.length} 个匿名方案名次生效并留档`);
  saveServer(state);
  return { ok: true, detail: "评分结果已锁定发布并留档" };
}
