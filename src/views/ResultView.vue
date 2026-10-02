<script setup lang="ts">
import { computed, ref } from "vue";
import { NAlert, NButton, NCard, NEmpty, NModal, NTable, NTag, useMessage } from "naive-ui";
import { useReviewStore } from "../stores/review";

const store = useReviewStore();
const message = useMessage();

const columns = [
  { title: "名次", key: "rank", width: 70 },
  { title: "匿名编号", key: "code" },
  { title: "方案", key: "title" },
  { title: "有效评委", key: "judgeCount" },
  { title: "回避", key: "recusedCount" },
  { title: "冲突", key: "conflictCount" },
  { title: "加权总分", key: "total" },
];

const unresolvedConflicts = computed(() =>
  Object.values(store.conflicts).filter((c) => !c.resolved),
);
const resolvedCount = computed(() => Object.values(store.conflicts).filter((c) => c.resolved).length);

function schemeName(schemeId: string) {
  const s = store.schemes.find((item) => item.id === schemeId);
  return s ? `${s.code} ${s.title}` : schemeId;
}

function lock() {
  const res = store.lock();
  if (!res.ok) { message.warning(res.reason ?? "暂不能锁定"); return; }
  message.success("评分结果已锁定发布，名次已留档");
}

function resolve(schemeId: string, resolution: "keep-first" | "accept-later") {
  const res = store.resolveConflict(schemeId, resolution);
  if (!res.ok) { message.error(res.reason ?? "操作失败"); return; }
  message.success(resolution === "keep-first" ? "已保留先到版本" : "已采纳后到版本");
}

const showArchive = ref(false);
const rankingData = computed(() => store.displayRanking.map((item, index) => ({ ...item, rank: index + 1 })));
</script>

<template>
  <NAlert v-if="store.locked" type="success" show-icon>
    结果已锁定发布。名次已留档可查；若评分改动或冲突被确认，本次锁定将失效并重算，需齐备且冲突解决后才能重新锁定。
  </NAlert>
  <NAlert v-else-if="store.archive.length" type="warning" show-icon>
    原锁定名次已失效并转入留档，当前为实时重算排名。全部方案齐备且冲突解决后可重新锁定。
  </NAlert>
  <NAlert v-else type="warning" show-icon>
    结果尚未锁定。为避免影响独立判断，主办方锁定前只能看到提交进度与冲突处理，看不到任何分值。
  </NAlert>

  <div class="result-grid">
    <NCard title="提交进度">
      <article v-for="scheme in store.schemes" :key="scheme.id" class="progress-row">
        <div>
          <b>{{ scheme.code }} {{ scheme.title }}</b>
          <small>
            {{ store.progress(scheme.id).submitted }} / {{ store.judges.length }} 已提交
            <template v-if="store.progress(scheme.id).recused"> · {{ store.progress(scheme.id).recused }} 回避</template>
            <template v-if="store.progress(scheme.id).conflict"> · <span class="conflict-text">{{ store.progress(scheme.id).conflict }} 冲突待处理</span></template>
          </small>
        </div>
        <NTag :type="store.progress(scheme.id).complete ? 'success' : 'warning'">
          {{ store.progress(scheme.id).complete ? "齐备" : "待提交" }}
        </NTag>
      </article>
    </NCard>

    <NCard title="评分纪律">
      <div class="discipline">
        <p>评委只能查看和修改自己的评分，越权提交一律拒绝。</p>
        <p>主办方在结果锁定前无法读取任何评委的分值，仅见提交进度。</p>
        <p>断网可照常填写，联网后与主办方台账合并；后到的冲突分标出差异、不盖先到版本，未解决不计入有效评委数。</p>
        <p>评分改动或冲突确认会使已锁定排名失效重算，名次留档可看。</p>
      </div>
      <NButton type="primary" block :disabled="!store.canLock" @click="lock">
        {{ store.locked ? "已锁定发布" : "锁定并发布结果" }}
      </NButton>
      <div v-if="!store.canLock" class="lock-reasons">
        <small v-for="reason in store.lockBlockReasons" :key="reason">· {{ reason }}</small>
      </div>
    </NCard>
  </div>

  <!-- 台账冲突处理 -->
  <NCard v-if="unresolvedConflicts.length" title="台账冲突分（后到版本，未计入有效评委数）" class="conflict-panel">
    <article v-for="c in unresolvedConflicts" :key="c.id" class="conflict-row">
      <div class="conflict-meta">
        <b>{{ schemeName(c.schemeId) }}</b>
        <NTag type="error" size="small">{{ c.judge }} · 后到冲突分</NTag>
      </div>
      <ul v-if="c.diff" class="diff-list">
        <li v-for="d in c.diff.dimensions" :key="d.id">
          <span>{{ d.name }}</span><em>后到 {{ d.later }}</em><i>先到 {{ d.first }}</i>
        </li>
        <li v-if="c.diff.commentChanged"><span>评审意见</span><em>后到</em><i>先到</i></li>
        <li v-if="c.diff.recusedChanged"><span>利益冲突回避</span><em>后到</em><i>先到</i></li>
      </ul>
      <div class="conflict-actions">
        <NButton size="small" @click="resolve(c.schemeId, 'keep-first')">保留先到版本</NButton>
        <NButton size="small" type="primary" ghost @click="resolve(c.schemeId, 'accept-later')">采纳后到版本</NButton>
      </div>
    </article>
  </NCard>

  <NCard :title="store.locked ? '最终排名（已锁定发布）' : '实时排名（未锁定）'" class="ranking">
    <template #header-extra>
      <NButton v-if="store.archive.length" size="small" @click="showArchive = true">名次留档（{{ store.archive.length }}）</NButton>
    </template>
    <NEmpty v-if="!store.locked && store.archive.length === 0" description="锁定后查看最终排名（锁定前不可见分值）" />
    <NTable v-else :columns="columns" :data="rankingData" :bordered="false" />
  </NCard>

  <NModal v-model:show="showArchive" title="名次留档" style="max-width:720px">
    <div v-for="snap in store.archive" :key="snap.id" class="archive-snap">
      <div class="archive-head">
        <b>{{ new Date(snap.lockedAt).toLocaleString() }}</b>
        <NTag size="small" type="info">{{ snap.reason }}</NTag>
      </div>
      <ol class="archive-rows">
        <li v-for="(row, idx) in [...snap.rows].sort((a, b) => b.total - a.total)" :key="row.schemeId">
          <span class="rank">{{ idx + 1 }}</span>
          <span class="code">{{ row.code }}</span>
          <span class="title">{{ row.title }}</span>
          <span class="total">{{ row.total }} 分</span>
          <small>有效评委 {{ row.judgeCount }}</small>
        </li>
      </ol>
    </div>
    <NEmpty v-if="!store.archive.length" description="暂无留档" />
  </NModal>
</template>
