import "./polyfill";
import { applyClientOps, computeRows, confirmConflict, getServerState, lockRankings } from "../src/ledger/server";
import type { Op, SubmitOp } from "../src/types";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`, extra ?? ""); }
}

let seq = 0;
function submitOp(judge: "评委-林策" | "评委-周筑", schemeId: string, baseRev: number, value: number, id?: string): SubmitOp {
  return { kind: "submit", id: id ?? `op-${++seq}`, judge, schemeId, values: { site: value, program: value, structure: value, sustain: value }, comment: `意见-${judge}-${value}`, coi: false, baseRev, at: new Date().toISOString() };
}
const rev = (schemeId: string) => getServerState().entries[schemeId].rev;

console.log("1. 在线提交并入台账");
let r = applyClientOps("评委-林策", [submitOp("评委-林策", "a", 0, 80, "op-lin-a1")]);
check("林策提交 S-01 applied", r[0].status === "applied", r);
check("S-01 rev=1", rev("a") === 1);

console.log("2. 重复提交只生成一条记录");
r = applyClientOps("评委-林策", [submitOp("评委-林策", "a", 0, 80, "op-lin-a1")]);
check("同一请求号 → duplicate", r[0].status === "duplicate");
check("事件只有一条提交记录", getServerState().events.filter((e) => e.action === "提交评分").length === 1);
r = applyClientOps("评委-林策", [submitOp("评委-林策", "a", rev("a"), 80, "op-lin-a2")]);
check("内容一致的新请求号 → duplicate", r[0].status === "duplicate", r);

console.log("3. 并发修改：后到的留为冲突分，不覆盖先到的");
r = applyClientOps("评委-周筑", [submitOp("评委-周筑", "a", 0, 60, "op-zhou-a1")]); // 周筑基于 v0，台账已是 v1
check("周筑基于过期版本提交 → conflict", r[0].status === "conflict", r);
let state = getServerState();
check("冲突分未解决", state.conflicts.length === 1 && state.conflicts[0].status === "未解决");
check("先到评分未被覆盖（林策 80 仍在）", state.entries.a.scores.find((s) => s.judge === "评委-林策")?.values.site === 80);
check("周筑的评分未进入台账", !state.entries.a.scores.some((s) => s.judge === "评委-周筑"));
check("冲突分标出差异（incoming=60）", state.conflicts[0].incoming.values.site === 60);
check("有效评委数不含未解决冲突分", computeRows(state.entries).find((row) => row.schemeId === "a")?.judgeCount === 1);

console.log("4. 越权操作被拒绝");
const before = getServerState().conflicts[0].status;
const deny = confirmConflict("主办方", getServerState().conflicts[0].id, "adopt");
check("主办方处理评委冲突 → 拒绝", !deny.ok && getServerState().conflicts[0].status === before);
r = applyClientOps("主办方", [submitOp("评委-林策", "b", rev("b"), 70)]);
check("主办方代交评分 → rejected", r[0].status === "rejected");
check("拒绝事件已记台账", getServerState().events.some((e) => e.action === "越权提交被拒绝"));

console.log("5. 冲突确认后计入，并使锁定失效");
const ok = confirmConflict("评委-周筑", getServerState().conflicts[0].id, "adopt");
check("本人确认采用 → ok", ok.ok);
state = getServerState();
check("冲突状态=已采用", state.conflicts[0].status === "已采用");
check("周筑评分入台账", state.entries.a.scores.some((s) => s.judge === "评委-周筑" && s.submitted));
check("有效评委数=2", computeRows(state.entries).find((row) => row.schemeId === "a")?.judgeCount === 2);

console.log("6. 锁定门槛：全部齐备且无未解决冲突");
// 补齐 b、c 两位评委
applyClientOps("评委-林策", [submitOp("评委-林策", "b", rev("b"), 90), submitOp("评委-林策", "c", rev("c"), 85)]);
applyClientOps("评委-周筑", [submitOp("评委-周筑", "b", rev("b"), 70), submitOp("评委-周筑", "c", rev("c"), 75)]);
let lock = lockRankings("评委-林策");
check("评委锁定 → 越权拒绝", !lock.ok);
lock = lockRankings("主办方");
check("主办方锁定成功", lock.ok, lock);
state = getServerState();
check("名次快照有效且留档", state.rankings.length === 1 && state.rankings[0].status === "有效");
check("b 排第一（90/70 均值最高）", state.rankings[0].rows[0].schemeId === "b", state.rankings[0].rows);

console.log("7. 评分改动使锁定失效重算，留档可查");
r = applyClientOps("评委-林策", [{ kind: "recall", id: "op-recall-a", judge: "评委-林策", schemeId: "a", baseRev: rev("a"), at: new Date().toISOString() }]);
check("退回 applied", r[0].status === "applied");
state = getServerState();
check("锁定已失效", state.currentLockId === null && state.rankings[0].status === "已失效");
check("失效原因=评分改动", state.rankings[0].invalidateReason === "评分改动");
lock = lockRankings("主办方");
check("未齐备不能重新锁定", !lock.ok, lock);
applyClientOps("评委-林策", [submitOp("评委-林策", "a", rev("a"), 88)]);
lock = lockRankings("主办方");
check("齐备后重新锁定成功", lock.ok);
check("留档两份（旧失效+新有效）", getServerState().rankings.length === 2);

console.log("8. 冲突确认使锁定失效");
r = applyClientOps("评委-周筑", [submitOp("评委-周筑", "b", 0, 66)]); // 过期版本 → 冲突
check("再次制造冲突", r[0].status === "conflict");
const cid = getServerState().conflicts.find((c) => c.status === "未解决")!.id;
confirmConflict("评委-周筑", cid, "withdraw");
state = getServerState();
check("撤回后锁定失效", state.currentLockId === null);
check("失效原因=冲突确认", state.rankings.find((s) => s.status === "已失效" && s.invalidateReason === "冲突确认") !== undefined);
check("撤回不改动台账先到分", state.entries.b.scores.find((s) => s.judge === "评委-周筑")?.values.site === 70);

console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
process.exit(failures ? 1 : 0);
