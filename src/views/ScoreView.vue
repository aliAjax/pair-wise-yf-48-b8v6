<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from "vue";
import { NAlert, NButton, NCard, NInput, NInputNumber, NProgress, NSwitch, NTag, useMessage } from "naive-ui";
import { z } from "zod";
import { useReviewStore } from "../stores/review";
import { weightedTotal } from "../ledger/data";

const store = useReviewStore();
const message = useMessage();
const selectedId = defineModel<string>("selectedId", { default: "a" });
const selected = computed(() => store.schemes.find((item) => item.id === selectedId.value) ?? store.schemes[0]);

const blankValues = () => Object.fromEntries(store.criteria.map((item) => [item.id, 60])) as Record<string, number>;
const form = reactive({ values: blankValues(), comment: "", coi: false });
const dirty = ref(false);
const submitting = ref(false);
const commentError = ref("");
const commentSchema = z.string().min(4, "请至少填写4个字的评审意见");

const ownEntry = computed(() => store.ownEntry(selected.value.id));
const openConflict = computed(() => store.openConflictOf(selected.value.id));
const disabled = computed(() => store.isOrganizer);
const weighted = computed(() => weightedTotal(form.values));

async function loadForm() {
  const source = store.draftOf(selected.value.id) ?? ownEntry.value;
  form.values = { ...blankValues(), ...(source?.values ?? {}) };
  form.comment = source?.comment ?? "";
  form.coi = source?.coi ?? false;
  commentError.value = "";
  await nextTick();
  dirty.value = false;
}
watch(selectedId, loadForm, { immediate: true });
watch(() => store.viewer, loadForm);
// 合并后台账里自己的评分变化时，若本地没有未保存改动则刷新表单
watch(
  () => ownEntry.value?.updatedAt,
  () => {
    if (!dirty.value) void loadForm();
  }
);

function statusTag(id: string) {
  const status = store.schemeStatus(id);
  return status === "已锁定" ? "success" : status === "已提交" ? "info" : status === "评分中" ? "warning" : "default";
}

function draft() {
  const result = store.saveDraft(selected.value.id, form.values, form.comment, form.coi);
  if (!result.ok) {
    message.error(result.detail);
    return;
  }
  dirty.value = false;
  message.success(result.detail);
}

async function submit() {
  if (submitting.value) return; // 重复点击只生成一条记录
  const check = commentSchema.safeParse(form.comment.trim());
  if (!check.success) {
    commentError.value = check.error.issues[0].message;
    return;
  }
  commentError.value = "";
  submitting.value = true;
  try {
    const result = await store.submit(selected.value.id, form.values, form.comment.trim(), form.coi);
    dirty.value = false;
    if (!result.ok) message.error(result.detail);
    else if (result.conflict) message.warning(result.detail);
    else message.success(result.detail);
  } finally {
    submitting.value = false;
  }
}

async function recall() {
  const result = await store.recall(selected.value.id);
  if (result.ok) message.success(result.detail);
  else message.error(result.detail);
}

function resolveConflict(decision: "withdraw" | "adopt") {
  const conflict = openConflict.value;
  if (!conflict) return;
  const result = store.resolveConflict(conflict.id, decision);
  if (result.ok) {
    message.success(result.detail);
    void loadForm();
  } else {
    message.error(result.detail);
  }
}
</script>

<template>
  <NAlert v-if="store.isOrganizer" type="info" show-icon>主办方在结果锁定前不能查看任何评委的评分值，只能查看提交进度。</NAlert>
  <NAlert v-if="!store.online" type="warning" show-icon class="banner">
    离线中：照常填写评分维度和评审意见，内容保存在本机；恢复联网后自动与主办方台账合并。<b v-if="store.pendingOps.length">（{{ store.pendingOps.length }} 条待同步）</b>
  </NAlert>
  <NAlert v-else-if="store.pendingOps.length" type="info" show-icon class="banner">有 {{ store.pendingOps.length }} 条修改待同步，正在与主办方台账合并…</NAlert>
  <NAlert v-if="store.currentLock" type="success" show-icon class="banner">结果已锁定发布。此后的评分改动或冲突确认会使锁定名次失效并按最新台账重算。</NAlert>
  <div class="workspace">
    <NCard title="匿名方案" class="scheme-panel">
      <button v-for="item in store.schemes" :key="item.id" class="scheme" :class="{ active: selectedId === item.id }" @click="selectedId = item.id">
        <span>{{ item.code }}</span><b>{{ item.title }}</b><small>{{ item.publicNo }} · {{ store.schemeStatus(item.id) }}</small>
        <i class="marks">
          <NTag v-if="store.draftOf(item.id)" size="tiny" :bordered="false">草稿</NTag>
          <NTag v-if="store.pendingOf(item.id)" size="tiny" type="info" :bordered="false">待同步</NTag>
          <NTag v-if="store.openConflictOf(item.id)" size="tiny" type="error" :bordered="false">冲突分</NTag>
        </i>
      </button>
    </NCard>
    <NCard class="score-panel">
      <template #header>
        <div class="card-title">
          <div><small>{{ selected.code }} · {{ selected.publicNo }}</small><h2>{{ selected.title }}</h2></div>
          <NTag :type="statusTag(selected.id)">{{ store.schemeStatus(selected.id) }}</NTag>
        </div>
      </template>
      <p class="synopsis">{{ selected.synopsis }}</p>
      <NAlert v-if="openConflict" type="error" show-icon class="banner">
        <p><b>你的评分与主办方台账并发修改，已留为冲突分（未解决前不计入有效评委数）。</b></p>
        <p>你的编辑基于台账 v{{ openConflict.baseRev }}，到账时台账已是 v{{ openConflict.entryRev }}，先到内容未被覆盖。可前往「同步台账」查看差异明细。</p>
        <div class="actions">
          <NButton size="small" @click="resolveConflict('withdraw')">撤回我的后到评分</NButton>
          <NButton size="small" type="primary" @click="resolveConflict('adopt')">确认采用我的评分</NButton>
        </div>
      </NAlert>
      <div class="criteria">
        <article v-for="item in store.criteria" :key="item.id">
          <div><b>{{ item.name }}</b><span>权重 {{ item.weight }}%</span><p>{{ item.description }}</p></div>
          <NInputNumber
            :value="form.values[item.id]"
            :min="0"
            :max="item.max"
            :step="5"
            :disabled="disabled"
            @update:value="(value: number | null) => { form.values[item.id] = value ?? 0; dirty = true; }"
          />
          <small>{{ form.values[item.id] }} / {{ item.max }}</small>
        </article>
      </div>
      <div class="weighted"><span>加权得分</span><NProgress type="line" :percentage="weighted" :height="18" /><b>{{ weighted.toFixed(1) }}</b></div>
      <label class="conflict-switch">
        <NSwitch v-model:value="form.coi" :disabled="disabled" @update:value="dirty = true" />
        <span><b>声明利益冲突</b><small>声明后本评分保留审计记录，但不计入最终排名</small></span>
      </label>
      <label class="field">
        <span>评审意见（评委间不可见）</span>
        <NInput v-model:value="form.comment" type="textarea" :disabled="disabled" placeholder="填写对方案的具体意见" @update:value="dirty = true" />
        <small>{{ commentError }}</small>
      </label>
      <div class="actions">
        <NButton :disabled="disabled" @click="draft">保存草稿</NButton>
        <NButton type="primary" :disabled="disabled" :loading="submitting" @click="submit">{{ store.online ? "提交本方案评分" : "提交（离线排队）" }}</NButton>
        <NButton v-if="ownEntry?.submitted" quaternary @click="recall">退回修改</NButton>
        <NTag v-if="ownEntry?.submitted" type="info" :bordered="false">已入台账 v{{ store.entryOf(selected.id)?.rev }}</NTag>
      </div>
    </NCard>
  </div>
</template>
