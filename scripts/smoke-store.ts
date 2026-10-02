import "./polyfill";
import { createPinia, setActivePinia } from "pinia";
import { useReviewStore } from "../src/stores/review";
import { getServerState } from "../src/ledger/server";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`, extra ?? ""); }
}

setActivePinia(createPinia());
const store = useReviewStore();

console.log("1. 断网时照常填写并排队");
store.setManualOffline(true);
check("离线状态", !store.online);
const d = store.saveDraft("a", { site: 70, program: 70, structure: 70, sustain: 70 }, "草稿意见", false);
check("草稿保存在本地", d.ok && store.drafts.length === 1);
const p = store.submit("a", { site: 80, program: 80, structure: 80, sustain: 80 }, "离线提交的意见", false);
check("离线提交进入队列", (await p).queued === true && store.pendingOps.length === 1);
check("提交后草稿清除", store.drafts.length === 0);
check("台账未变（离线）", getServerState().entries.a.rev === 0);

console.log("2. 重复提交只生成一条待同步记录");
await store.submit("a", { site: 81, program: 81, structure: 81, sustain: 81 }, "离线提交的意见改", false);
check("队列仍为 1 条", store.pendingOps.length === 1);

console.log("3. 客户端状态持久化（刷新可恢复）");
const raw = sessionStorage.getItem("pair-wise-yf-48/client");
check("sessionStorage 有快照", !!raw);
const snap = JSON.parse(raw!);
check("快照含待同步队列与离线标记", snap.outbox.length === 1 && snap.manualOffline === true);

console.log("4. 恢复联网自动合并");
store.setManualOffline(false);
await new Promise((resolve) => setTimeout(resolve, 0));
check("队列清空", store.pendingOps.length === 0);
check("台账已并入（rev=1）", getServerState().entries.a.rev === 1);
check("台账中是最后一次修改 81", getServerState().entries.a.scores[0].values.site === 81);

console.log("5. 越权提交被拒绝");
store.setViewer("主办方");
const denied = await store.submit("b", { site: 1 }, "x", false);
check("主办方提交被拒", !denied.ok && denied.detail.includes("越权"));
check("未生成待同步记录", store.pendingOps.length === 0);
const deniedDraft = store.saveDraft("b", { site: 1 }, "x", false);
check("主办方不能存草稿", !deniedDraft.ok);

console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
process.exit(failures ? 1 : 0);
