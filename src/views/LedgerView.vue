<script setup lang="ts">
import { computed, ref } from "vue";
import { NAlert, NButton, NCard, NEmpty, NSwitch, NTag, NTimeline, NTimelineItem, useMessage } from "naive-ui";
import { useReviewStore } from "../stores/review";
import { criteria, schemeOf } from "../ledger/data";
import type { ConflictScore, Op } from "../types";

const store = useReviewStore();
const message = useMessage();
const lastSummary = ref("");

/** 主办方在首次锁定前看不到分值，冲突差异只展示版本信息 */
const canSeeValues = computed(() => !store.isOrganizer || store.revealed);

const timeline = computed(() => [
  ...store.pendingOps.map((op) => ({
    id: op.id,
    time: op.at,
    actor: op.judge as string,
    action: "待同步",
    detail: `${op.kind === "submit" ? "提交评分" : "退回评分"} ${schemeOf(op.schemeId)?.code ?? op.schemeId} · 基于台账 v${op.baseRev}`,
    pending: true
  })),
  ...store.events.map((event) => ({ ...event, pending: false }))
]);

function timeOf(iso: string) {
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

function opLabel(op: Op) {
  return op.kind === "submit" ? "提交评分" : "退回评分";
}

function diffRows(conflict: ConflictScore) {
  return criteria.map((criterion) => ({
    id: criterion.id,
    name: criterion.name,
    from: conflict.priorOwn?.values[criterion.id] ?? null,
    to: conflict.incoming.values[criterion.id] ?? null
  }));
}

async function sync() {
  const result = await store.syncNow();
  lastSummary.value = result.detail;
  if (result.ok) message.success(result.detail);
  else message.warning(result.detail);
}

function resolve(conflictId: string, decision: "withdraw" | "adopt") {
  const result = store.resolveConflict(conflictId, decision);
  if (result.ok) message.success(result.detail);
  else message.error(result.detail);
}
</script>

<template>
  <div class="ledger-grid">
    <NCard title="连接与合并">
      <div class="conn">
        <NTag :type="store.online ? 'success' : 'error'" size="large">{{ store.online ? "在线" : "离线" }}</NTag>
        <div class="conn-meta">
          <small>浏览器网络：{{ store.networkOn ? "连接正常" : "已断开" }}</small>
          <small v-if="store.lastSyncAt">上次合并：{{ timeOf(store.lastSyncAt) }}</small>
        </div>
      </div>
      <label class="offline-switch">
        <NSwitch :value="store.manualOffline" @update:value="(value: boolean) => store.setManualOffline(value)" />
        <span><b>模拟断网</b><small>断网期间照常评分，提交进入本地队列</small></span>
      </label>
      <NButton type="primary" block :disabled="!store.online" :loading="store.syncing" @click="sync">
        立即与主办方台账合并<template v-if="store.pendingOps.length">（{{ store.pendingOps.length }} 条待同步）</template>
      </NButton>
      <NAlert v-if="lastSummary" type="info" class="banner" :bordered="false">{{ lastSummary }}</NAlert>
    </NCard>

    <NCard title="待同步队列">
      <NEmpty v-if="!store.pendingOps.length" description="本地没有待同步的修改" />
      <article v-for="op in store.pendingOps" :key="op.id" class="op-row">
        <div>
          <b>{{ opLabel(op) }} · {{ schemeOf(op.schemeId)?.code }}</b>
          <small>{{ op.judge }} · 基于台账 v{{ op.baseRev }} · {{ timeOf(op.at) }}</small>
        </div>
        <NTag type="warning" size="small">待同步</NTag>
      </article>
    </NCard>

    <NCard title="冲突分" class="conflict-panel">
      <NEmpty v-if="!store.visibleConflicts.length" description="没有冲突分" />
      <article v-for="conflict in store.visibleConflicts" :key="conflict.id" class="conflict-card">
        <header>
          <b>{{ schemeOf(conflict.schemeId)?.code }} · {{ conflict.judge }}</b>
          <NTag :type="conflict.status === '未解决' ? 'error' : 'default'" size="small">{{ conflict.status }}</NTag>
        </header>
        <p class="conflict-note">
          后到评分基于台账 v{{ conflict.baseRev }}，到账时台账已是 v{{ conflict.entryRev }}；先到内容未被覆盖，未解决前不计入有效评委数。
        </p>
        <p class="conflict-note">同期台账：{{ conflict.peers.length ? conflict.peers.map((peer) => `${peer.judge} ${peer.submitted ? "已提交" : "未提交"}`).join("；") : "尚无其他评分" }}</p>
        <template v-if="canSeeValues">
          <table v-if="conflict.priorOwn" class="diff-table">
            <thead><tr><th>维度</th><th>先到（台账）</th><th>后到（待确认）</th></tr></thead>
            <tbody>
              <tr v-for="row in diffRows(conflict)" :key="row.id" :class="{ changed: row.from !== row.to }">
                <td>{{ row.name }}</td><td>{{ row.from }}</td><td>{{ row.to }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="conflict-note">这是该评委对方案的首次评分，台账中没有先到版本可对比，差异即整份新评分。</p>
          <div v-if="conflict.priorOwn && conflict.priorOwn.comment !== conflict.incoming.comment" class="diff-comment">
            <p><b>先到意见：</b>{{ conflict.priorOwn.comment || "（空）" }}</p>
            <p><b>后到意见：</b>{{ conflict.incoming.comment || "（空）" }}</p>
          </div>
        </template>
        <p v-else class="conflict-note">分值在结果锁定前不可见，仅展示版本信息。</p>
        <div v-if="conflict.status === '未解决' && conflict.judge === store.judge" class="actions">
          <NButton size="small" @click="resolve(conflict.id, 'withdraw')">撤回后到评分</NButton>
          <NButton size="small" type="primary" @click="resolve(conflict.id, 'adopt')">确认采用我的评分</NButton>
          <small class="lock-hint">确认后锁定名次将失效重算</small>
        </div>
      </article>
    </NCard>

    <NCard title="台账事件" class="event-panel">
      <NEmpty v-if="!timeline.length" description="暂无台账记录" />
      <NTimeline v-else>
        <NTimelineItem v-for="item in timeline" :key="item.id" :type="item.pending ? 'warning' : 'default'" :title="item.action" :content="item.detail" :time="timeOf(item.time)" />
      </NTimeline>
    </NCard>
  </div>
</template>
