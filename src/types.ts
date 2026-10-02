export type JudgeName = "评委-林策" | "评委-周筑";
export type Viewer = JudgeName | "主办方";

export interface Scheme {
  id: string;
  code: string;
  title: string;
  synopsis: string;
  publicNo: string;
}

export interface Criterion {
  id: string;
  name: string;
  description: string;
  weight: number;
  max: number;
}

/** 一位评委对一个方案的评分（台账条目内的一条记录） */
export interface ScoreEntry {
  judge: JudgeName;
  schemeId: string;
  values: Record<string, number>;
  comment: string;
  /** 利益冲突声明：保留审计但不计入排名 */
  coi: boolean;
  submitted: boolean;
  updatedAt: string;
}

/** 方案台账条目：合并的最小单元，rev 单调递增 */
export interface SchemeLedger {
  schemeId: string;
  rev: number;
  scores: ScoreEntry[];
}

/** 冲突分：后到的并发评分，保留差异，不覆盖先到内容 */
export interface ConflictScore {
  id: string;
  schemeId: string;
  judge: JudgeName;
  /** 后到编辑基于的台账版本 */
  baseRev: number;
  /** 冲突发生时的台账版本 */
  entryRev: number;
  /** 后到的评分 */
  incoming: ScoreEntry;
  /** 该评委在台账中的先到版本（用于标出差异，可能不存在） */
  priorOwn: ScoreEntry | null;
  /** 冲突发生时台账元数据（不含分值，避免泄露他人评分） */
  peers: { judge: JudgeName; submitted: boolean }[];
  status: "未解决" | "已撤回" | "已采用";
  createdAt: string;
  resolvedAt?: string;
}

export interface RankingRow {
  schemeId: string;
  code: string;
  title: string;
  total: number;
  /** 有效评委数：已提交、未声明利益冲突，且不含未解决冲突分 */
  judgeCount: number;
  coiCount: number;
  rank: number;
}

/** 锁定名次的留档快照，失效后仍可查看 */
export interface RankingSnapshot {
  id: string;
  lockedAt: string;
  lockedBy: Viewer;
  status: "有效" | "已失效";
  invalidatedAt?: string;
  invalidateReason?: string;
  rows: RankingRow[];
}

export interface ReviewEvent {
  id: string;
  time: string;
  actor: Viewer | "系统";
  action: string;
  detail: string;
}

export interface SubmitOp {
  kind: "submit";
  /** 客户端请求号：重复提交/重试只生成一条记录 */
  id: string;
  judge: JudgeName;
  schemeId: string;
  values: Record<string, number>;
  comment: string;
  coi: boolean;
  /** 编辑时看到的台账版本，用于并发检测 */
  baseRev: number;
  at: string;
}

export interface RecallOp {
  kind: "recall";
  id: string;
  judge: JudgeName;
  schemeId: string;
  baseRev: number;
  at: string;
}

export type Op = SubmitOp | RecallOp;

/** 本地草稿：只在当前设备，不并入台账 */
export interface Draft {
  judge: JudgeName;
  schemeId: string;
  values: Record<string, number>;
  comment: string;
  coi: boolean;
  updatedAt: string;
}

export type ApplyStatus = "applied" | "conflict" | "duplicate" | "rejected";

export interface ApplyResult {
  op: Op;
  status: ApplyStatus;
  detail: string;
}
