<script setup lang="ts">
import { computed } from "vue";
import { NAlert, NButton, NCard, NCollapse, NCollapseItem, NEmpty, NTable, NTag, useMessage } from "naive-ui";
import { useReviewStore } from "../stores/review";

const store = useReviewStore();
const message = useMessage();

const columns = [
  { title: "名次", key: "rank", width: 70 },
  { title: "匿名编号", key: "code" },
  { title: "方案", key: "title" },
  { title: "有效评委", key: "judgeCount" },
  { title: "利益冲突", key: "coiCount" },
  { title: "加权总分", key: "total" }
];

/** 锁定失效后展示按最新台账重算的名次（结果曾发布过才对主办方可见） */
const showLive = computed(() => !store.currentLock && store.revealed);

function lock() {
  const result = store.lock();
  if (result.ok) message.success(result.detail);
  else message.warning(result.detail);
}

function timeOf(iso: string) {
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}
</script>

<template>
  <NAlert v-if="store.currentLock" type="success" show-icon>
    结果已于 {{ timeOf(store.currentLock.lockedAt) }} 锁定发布。任何评分改动或冲突确认都会使锁定失效并重算。
  </NAlert>
  <NAlert v-else-if="store.revealed" type="warning" show-icon>
    锁定已失效，名次已按最新台账重算；全部方案齐备且冲突分全部解决后才能重新锁定。
  </NAlert>
  <NAlert v-else type="info" show-icon>结果尚未锁定。为避免影响独立判断，主办方当前只能看到提交进度，看不到任何分值。</NAlert>

  <div class="result-grid">
    <NCard title="提交进度">
      <article v-for="item in store.progress" :key="item.scheme.id" class="progress-row">
        <div>
          <b>{{ item.scheme.code }} {{ item.scheme.title }}</b>
          <small>
            已提交 {{ item.submittedCount }} / {{ item.judgeTotal }} · 有效评委 {{ item.effective }}
            <template v-if="item.openConflicts"> · 冲突分 {{ item.openConflicts }} 待解决</template>
          </small>
        </div>
        <div class="progress-tags">
          <NTag v-if="item.openConflicts" type="error" size="small">冲突待解决</NTag>
          <NTag :type="item.complete ? 'success' : 'warning'" size="small">{{ item.complete ? "齐备" : "待提交" }}</NTag>
        </div>
      </article>
    </NCard>
    <NCard title="评分纪律">
      <div class="discipline">
        <p>评委只能查看和维护自己的评分；主办方在首次锁定前无法读取任何分值。</p>
        <p>并发的后到评分留为冲突分并标出差异，不覆盖先到内容；未解决的冲突分不计入有效评委数。</p>
        <p>锁定名次遇到评分改动或冲突确认即失效重算，历史名次留档可查。</p>
      </div>
      <NButton type="primary" block :disabled="!store.isOrganizer || !store.canLock" @click="lock">
        {{ store.currentLock ? "结果已锁定" : "锁定并发布结果" }}
      </NButton>
      <small v-if="!store.isOrganizer" class="lock-hint">仅主办方可锁定结果</small>
      <small v-else-if="!store.canLock" class="lock-hint">需全部方案齐备且冲突分全部解决</small>
    </NCard>
  </div>

  <NCard class="ranking">
    <template #header>
      <div class="card-title">
        <div><h2>当前排名</h2></div>
        <NTag v-if="store.currentLock" type="success">有效 · {{ timeOf(store.currentLock.lockedAt) }}</NTag>
        <NTag v-else-if="showLive" type="warning">未锁定 · 已按最新台账重算</NTag>
      </div>
    </template>
    <NTable v-if="store.currentLock" :columns="columns" :data="store.currentLock.rows" :bordered="false" />
    <NTable v-else-if="showLive" :columns="columns" :data="store.liveRows" :bordered="false" />
    <NEmpty v-else description="锁定后查看最终排名" />
  </NCard>

  <NCard title="名次留档" class="ranking">
    <NEmpty v-if="!store.rankings.length" description="暂无锁定留档" />
    <NCollapse v-else>
      <NCollapseItem v-for="snapshot in store.rankings" :key="snapshot.id" :name="snapshot.id">
        <template #header>
          <span class="archive-head">
            {{ timeOf(snapshot.lockedAt) }} · {{ snapshot.lockedBy }}
            <NTag :type="snapshot.status === '有效' ? 'success' : 'error'" size="small">{{ snapshot.status }}</NTag>
            <small v-if="snapshot.status === '已失效'">失效原因：{{ snapshot.invalidateReason }} · {{ snapshot.invalidatedAt ? timeOf(snapshot.invalidatedAt) : "" }}</small>
          </span>
        </template>
        <NTable :columns="columns" :data="snapshot.rows" :bordered="false" size="small" />
      </NCollapseItem>
    </NCollapse>
  </NCard>
</template>
