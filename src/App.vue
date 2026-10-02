<script setup lang="ts">
import { RouterLink, RouterView } from "vue-router";
import { useI18n } from "vue-i18n";
import { NButton, NMessageProvider, NSelect, NTag } from "naive-ui";
import { useReviewStore } from "./stores/review";
import type { Viewer } from "./types";

const store = useReviewStore();
const { t } = useI18n();
const choices = ["评委-林策", "评委-周筑", "主办方"].map((value) => ({ label: value, value }));

function toggleNetwork() {
  store.setOnline(!store.online);
}
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand"><b>ANON</b><span>建筑评审</span></div>
      <nav>
        <RouterLink to="/">{{ t("scoring") }}</RouterLink>
        <RouterLink to="/results">{{ t("results") }}</RouterLink>
      </nav>

      <div class="net-panel">
        <div class="net-row">
          <span class="net-dot" :class="{ online: store.online }" />
          <b>{{ store.online ? "在线 · 台账已连接" : "断网 · 本地记账" }}</b>
        </div>
        <p v-if="store.online">断网时照常填写，联网后与主办方台账合并。</p>
        <p v-else>当前断网，评分与意见保存在本地，联网后自动合并。</p>
        <NButton size="small" :block="true" :type="store.online ? 'default' : 'primary'" @click="toggleNetwork">
          {{ store.online ? "模拟断网" : "恢复联网" }}
        </NButton>
        <NButton v-if="store.online && !store.isOrganizer" size="small" block type="primary" ghost @click="store.syncNow()">
          同步台账
        </NButton>
        <small v-if="store.lastSyncAt" class="sync-at">最近同步 {{ new Date(store.lastSyncAt).toLocaleTimeString() }}</small>
      </div>

      <div class="identity">
        <small>当前身份</small>
        <NSelect :value="store.viewer" :options="choices" @update:value="(value: Viewer) => store.setViewer(value)" />
      </div>
    </aside>
    <main>
      <header>
        <div>
          <small>城市公共空间设计竞赛 · 第二轮</small>
          <h1>建筑设计竞赛匿名评审</h1>
          <p>本地优先台账：断网可填，联网合并；后到冲突分标出差异且不盖先到版本。</p>
        </div>
        <div class="badge-row">
          <NTag :type="store.online ? 'success' : 'warning'" size="small">{{ store.online ? "在线" : "断网" }}</NTag>
          <div class="badge">{{ store.isOrganizer ? "主办方视图" : "评委独立视图" }}</div>
        </div>
      </header>
      <NMessageProvider><RouterView /></NMessageProvider>
    </main>
  </div>
</template>
