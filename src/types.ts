export type Viewer = "评委-林策" | "评委-周筑" | "主办方";
export type SchemeStatus = "待评分" | "评分中" | "已提交" | "已锁定";

/** 台账同步状态：synced 已与主办方台账一致；pending 本地待同步；conflict 后到的冲突分 */
export type SyncState = "synced" | "pending" | "conflict";
/** 冲突确认方式：keep-first 保留先到版本；accept-later 采纳后到版本 */
export type ConflictResolution = "keep-first" | "accept-later";

export interface Scheme {
  id: string;
  code: string;
  title: string;
  synopsis: string;
  publicNo: string;
  status: SchemeStatus;
}

export interface Criterion {
  id: string;
  name: string;
  description: string;
  weight: number;
  max: number;
}

/** 维度级差异（后到版本 vs 先到版本） */
export interface DimensionDiff {
  id: string;
  name: string;
  later: number;
  first: number;
}

export interface ScoreDiff {
  dimensions: DimensionDiff[];
  commentChanged: boolean;
  recusedChanged: boolean;
}

export interface ScoreRecord {
  /** 确定性 id：`${judge}::${schemeId}`，保证重复提交只生成一条记录 */
  id: string;
  judge: Viewer;
  schemeId: string;
  values: Record<string, number>;
  comment: string;
  /** 利益冲突回避声明（区别于台账冲突分） */
  recused: boolean;
  submitted: boolean;
  updatedAt: string;
  /** 本地编辑版本号，每次自增 */
  version: number;
  /** 本地副本基于的主办方台账版本，用于乐观并发冲突检测 */
  baseVersion: number;
  sync: SyncState;
  /** 冲突时保留的先到版本快照 */
  conflictWith?: ScoreRecord;
  diff?: ScoreDiff;
  resolved?: boolean;
  resolution?: ConflictResolution;
}

export interface RankingRow {
  schemeId: string;
  code: string;
  title: string;
  total: number;
  judgeCount: number;
  recusedCount: number;
  conflictCount: number;
}

export interface RankingSnapshot {
  id: string;
  lockedAt: string;
  reason: string;
  rows: RankingRow[];
}

export interface ReviewEvent {
  id: string;
  time: string;
  actor: Viewer;
  action: string;
  detail: string;
}

/** 评委对某方案的提交状态 */
export type JudgeState = "submitted" | "recused" | "draft" | "conflict";
