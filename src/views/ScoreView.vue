<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { NAlert, NButton, NCard, NInput, NProgress, NRate, NSwitch, NTag, useMessage } from "naive-ui";
import { toTypedSchema } from "@vee-validate/zod";
import { useForm } from "vee-validate";
import { z } from "zod";
import { useReviewStore } from "../stores/review";

const store = useReviewStore();
const message = useMessage();
const selectedId = defineModel<string>("selectedId", { default: "a" });
const selected = computed(() => store.schemes.find((item) => item.id === selectedId.value) ?? store.schemes[0]);
const currentScore = computed(() => store.record(selected.value.id));

const form = reactive({
  values: Object.fromEntries(store.criteria.map((item) => [item.id, 60])) as Record<string, number>,
  comment: "",
  recused: false,
});

const schema = toTypedSchema(z.object({ comment: z.string().min(4, "请至少填写4个字的评审意见") }));
const { errors, validate } = useForm({ validationSchema: schema });
const submitting = ref(false);

watch(selectedId, () => {
  const rec = store.record(selected.value.id);
  form.values = { ...(rec?.values ?? Object.fromEntries(store.criteria.map((item) => [item.id, 60]))) };
  form.comment = rec?.comment ?? "";
  form.recused = rec?.recused ?? false;
}, { immediate: true });

const weighted = computed(() => store.criteria.reduce((sum, item) => sum + form.values[item.id] * item.weight / 100, 0));
const disabled = computed(() => store.isOrganizer || !!currentScore.value?.submitted);

// 星级（0-5）与百分制（0-100）双向转换
function starValue(criterionId: string): number {
  return (form.values[criterionId] ?? 0) / 20;
}
function setStar(criterionId: string, value: number) {
  form.values[criterionId] = Math.round(value * 20);
}

const syncTag = computed(() => {
  const rec = currentScore.value;
  if (!rec) return null;
  if (rec.sync === "conflict") return { label: "冲突待处理", type: "error" as const };
  if (rec.sync === "pending") return { label: store.online ? "待同步" : "本地待同步", type: "warning" as const };
  return { label: "已同步", type: "success" as const };
});

function draft() {
  const result = store.saveDraft(selected.value.id, form.values, form.comment, form.recused);
  if (!result.ok) { message.error(result.reason ?? "保存失败"); return; }
  message.success(store.online ? "评分草稿已保存" : "评分草稿已保存到本地，联网后合并");
}

async function submit() {
  if (submitting.value) return; // 防止重复点击产生多条提交
  const result = await validate({ values: form } as any);
  if (!result.valid) return;
  submitting.value = true;
  const res = store.submit(selected.value.id, form.values, form.comment, form.recused);
  submitting.value = false;
  if (!res.ok) { message.error(res.reason ?? "提交失败"); return; }
  message.success(store.online ? "匿名评分已提交并同步" : "匿名评分已提交到本地，联网后合并");
}

function recall() {
  const res = store.recalled(selected.value.id);
  if (!res.ok) { message.error(res.reason ?? "退回失败"); return; }
  message.info("已退回修改");
}

function resolve(resolution: "keep-first" | "accept-later") {
  const res = store.resolveConflict(selected.value.id, resolution);
  if (!res.ok) { message.error(res.reason ?? "操作失败"); return; }
  message.success(resolution === "keep-first" ? "已保留先到版本" : "已采纳后到版本");
}

function simulate() {
  const res = store.simulateConcurrent(selected.value.id);
  if (!res.ok) { message.warning(res.reason ?? "操作失败"); return; }
  message.info("已模拟另一台设备先到台账，请保持断网改分后联网同步");
}
</script>

<template>
  <NAlert v-if="store.isOrganizer" type="info" show-icon>
    主办方在结果锁定前不能查看任何评委的评分值，只能看到提交进度与冲突处理。
  </NAlert>

  <div class="workspace">
    <NCard title="匿名方案" class="scheme-panel">
      <button v-for="item in store.schemes" :key="item.id" class="scheme" :class="{ active: selectedId === item.id }" @click="selectedId = item.id">
        <span>{{ item.code }}</span><b>{{ item.title }}</b><small>{{ item.publicNo }} · {{ item.status }}</small>
      </button>
    </NCard>

    <NCard class="score-panel">
      <template #header>
        <div class="card-title">
          <div>
            <small>{{ selected.code }} · {{ selected.publicNo }}</small>
            <h2>{{ selected.title }}</h2>
          </div>
          <div class="tags">
            <NTag v-if="syncTag" :type="syncTag.type" size="small">{{ syncTag.label }}</NTag>
            <NTag :type="selected.status === '已锁定' ? 'success' : 'warning'">{{ selected.status }}</NTag>
          </div>
        </div>
      </template>

      <p class="synopsis">{{ selected.synopsis }}</p>

      <NAlert v-if="!store.online" type="warning" show-icon class="offline-alert">
        断网编辑中：维度评分与评审意见保存在本机，联网后与主办方台账合并，期间不会覆盖先到版本。
      </NAlert>

      <template v-if="!store.isOrganizer">
        <!-- 台账冲突分：后到版本 vs 先到版本，标出差异，不盖掉先到版本 -->
        <NAlert v-if="currentScore?.sync === 'conflict' && currentScore.diff" type="error" show-icon class="conflict-card">
          <div class="conflict-head">
            <b>台账冲突分：后到评分与先到版本不一致</b>
            <span>先到版本已保留为有效评分，本次后到评分暂不计入有效评委数。</span>
          </div>
          <ul class="diff-list">
            <li v-for="d in currentScore.diff.dimensions" :key="d.id">
              <span>{{ d.name }}</span>
              <em>后到 {{ d.later }} 分</em>
              <i>先到 {{ d.first }} 分</i>
            </li>
            <li v-if="currentScore.diff.commentChanged"><span>评审意见</span><em>后到版本</em><i>先到版本</i></li>
            <li v-if="currentScore.diff.recusedChanged"><span>利益冲突回避</span><em>后到版本</em><i>先到版本</i></li>
          </ul>
          <div class="conflict-actions">
            <NButton size="small" @click="resolve('keep-first')">保留先到版本</NButton>
            <NButton size="small" type="primary" ghost @click="resolve('accept-later')">采纳后到版本</NButton>
          </div>
        </NAlert>

        <div class="criteria">
          <article v-for="item in store.criteria" :key="item.id">
            <div><b>{{ item.name }}</b><span>权重 {{ item.weight }}%</span><p>{{ item.description }}</p></div>
            <NRate :value="starValue(item.id)" :count="5" allow-half :disabled="disabled" @update:value="(v: number) => setStar(item.id, v)" />
            <small>{{ form.values[item.id] }} / {{ item.max }}</small>
          </article>
        </div>

        <div class="weighted">
          <span>加权得分</span>
          <NProgress type="line" :percentage="weighted" :height="18" />
          <b>{{ weighted.toFixed(1) }}</b>
        </div>

        <label class="conflict-switch">
          <NSwitch v-model:value="form.recused" :disabled="disabled" />
          <span><b>声明利益冲突回避</b><small>声明后本评分不计入最终排名</small></span>
        </label>

        <label class="field">
          <span>评审意见（评委间不可见）</span>
          <NInput v-model:value="form.comment" type="textarea" :disabled="disabled" placeholder="填写对方案的具体意见" />
          <small>{{ errors.comment }}</small>
        </label>

        <div class="actions">
          <NButton :disabled="disabled" @click="draft">保存草稿</NButton>
          <NButton type="primary" :loading="submitting" :disabled="disabled" @click="submit">提交本方案评分</NButton>
          <NButton v-if="currentScore?.submitted" quaternary @click="recall">退回修改</NButton>
        </div>

        <div class="dev-tools">
          <small>本地优先演示</small>
          <NButton size="small" dashed @click="simulate">模拟另一台设备先到台账（制造并发冲突）</NButton>
          <NButton v-if="store.online" size="small" type="primary" ghost @click="store.syncNow()">立即同步台账</NButton>
        </div>
      </template>
    </NCard>
  </div>
</template>
