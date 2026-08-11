<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import Modal from '../components/Modal.vue';
import RawYamlEditor from '../components/RawYamlEditor.vue';
import { stringify as stringifyYaml } from 'yaml';

const entries = ref([]);
const providerKeys = ref([]);
const allModels = ref([]); // all model display_names (for target dropdowns)
const loading = ref(false);
const editing = ref(null);
const saving = ref(false);
const lastResult = ref(null);
const tab = ref('form'); // 'form' | 'raw'

const emptyForm = () => ({
  display_name: '',
  shape: 'direct',
  direct: { provider: 'openai', model_name: '', provider_key: '', auto_prompt_caching: false },
  routing: {
    strategy: 'failover',
    targets: [{ model: '', weight: '', tags: '' }],
    retries: '',
    max_fallbacks: '',
    retry_on_429: false,
    fallback_on_statuses: '',
    when_all_unavailable: 'fail',
    sticky: false,
  },
  ensemble: {
    panel: [{ model: '', temperature: '', seed: '', weight: '' }],
    judge: { model: '', synthesis_prompt: '' },
    min_responses: '',
  },
  semantic: {
    embedding_model: '',
    match_threshold: '',
    routes: [{ name: '', target: '', description: '', examples: '', threshold: '' }],
    default: '',
    on_embedding_failure: '',
  },
  common: {
    timeout: '',
    stream_timeout: '',
    retries: '',
    rps: '', rpm: '', rph: '', rpd: '', tpm: '', tpd: '', concurrency: '',
    allowed_cidrs: '',
    cost_input: '', cost_output: '',
    cooldown: false,
  },
});

const form = ref(emptyForm());
const previewYaml = computed(() => {
  try {
    return stringifyYaml(buildEntry(), { lineWidth: 0 });
  } catch (e) {
    return `# ${e.message}`;
  }
});

const strategyOptions = ['round_robin', 'weighted', 'failover', 'least_cost', 'least_latency', 'least_busy'];
const shapeLabels = { direct: '直连', routing: '路由/回退', ensemble: '集成', semantic: '语义' };

async function load() {
  loading.value = true;
  try {
    const [m, pk] = await Promise.all([api.list('models'), api.list('provider_keys')]);
    entries.value = m.entries ?? [];
    providerKeys.value = pk.entries ?? [];
    allModels.value = (m.entries ?? []).map((e) => e.display_name).filter(Boolean);
  } catch (e) {
    lastResult.value = { ok: false, errors: [{ message: e.message }] };
  } finally {
    loading.value = false;
  }
}

function detectShape(e) {
  if (e.routing) return 'routing';
  if (e.ensemble) return 'ensemble';
  if (e.semantic) return 'semantic';
  return 'direct';
}

function openCreate() {
  form.value = emptyForm();
  editing.value = {};
  lastResult.value = null;
  tab.value = 'form';
}

function openEdit(e) {
  const f = emptyForm();
  const shape = detectShape(e);
  f.display_name = e.display_name ?? '';
  f.shape = shape;
  f.direct = {
    provider: e.provider ?? 'openai',
    model_name: e.model_name ?? '',
    provider_key: e.provider_key ?? e.provider_key_id ?? '',
    auto_prompt_caching: !!e.auto_prompt_caching,
  };
  const r = e.routing || {};
  f.routing = {
    strategy: r.strategy ?? 'failover',
    targets: (r.targets ?? []).map((t) => ({
      model: t.model ?? '',
      weight: t.weight ?? '',
      tags: (t.tags ?? []).join(','),
    })),
    retries: r.retries ?? '',
    max_fallbacks: r.max_fallbacks ?? '',
    retry_on_429: !!r.retry_on_429,
    fallback_on_statuses: (r.fallback_on_statuses ?? []).join(','),
    when_all_unavailable: r.when_all_unavailable ?? 'fail',
    sticky: !!r.sticky,
  };
  const en = e.ensemble || {};
  f.ensemble = {
    panel: (en.panel ?? []).map((p) => ({
      model: p.model ?? '',
      temperature: p.temperature ?? '',
      seed: p.seed ?? '',
      weight: p.weight ?? '',
    })),
    judge: { model: en.judge?.model ?? '', synthesis_prompt: en.judge?.synthesis_prompt ?? '' },
    min_responses: en.min_responses ?? '',
  };
  const s = e.semantic || {};
  f.semantic = {
    embedding_model: s.embedding_model ?? '',
    match_threshold: s.match?.threshold ?? '',
    routes: (s.routes ?? []).map((r) => ({
      name: r.name ?? '',
      target: r.target ?? '',
      description: r.description ?? '',
      examples: (r.examples ?? []).join(' | '),
      threshold: r.threshold ?? '',
    })),
    default: s.default ?? '',
    on_embedding_failure: typeof s.on_embedding_failure === 'string' ? s.on_embedding_failure : s.on_embedding_failure?.target || '',
  };
  const rl = e.rate_limit || {};
  f.common = {
    timeout: e.timeout ?? '',
    stream_timeout: e.stream_timeout ?? '',
    retries: e.retries ?? '',
    rps: rl.rps ?? '', rpm: rl.rpm ?? '', rph: rl.rph ?? '', rpd: rl.rpd ?? '',
    tpm: rl.tpm ?? '', tpd: rl.tpd ?? '', concurrency: rl.concurrency ?? '',
    allowed_cidrs: (e.allowed_cidrs ?? []).join(','),
    cost_input: e.cost?.input_per_1k ?? '',
    cost_output: e.cost?.output_per_1k ?? '',
    cooldown: !!e.cooldown,
  };
  form.value = f;
  editing.value = e;
  lastResult.value = null;
  tab.value = 'form';
}

const num = (v) => (v === '' || v === null || v === undefined ? undefined : Number(v));
const strArr = (v) =>
  String(v || '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

function buildEntry() {
  const f = form.value;
  const c = f.common;
  const entry = { display_name: f.display_name };

  const rl = {};
  for (const k of ['rps', 'rpm', 'rph', 'rpd', 'tpm', 'tpd', 'concurrency']) {
    const v = num(c[k]);
    if (v !== undefined) rl[k] = v;
  }
  if (Object.keys(rl).length) entry.rate_limit = rl;
  const timeout = num(c.timeout);
  if (timeout !== undefined) entry.timeout = timeout;
  const st = num(c.stream_timeout);
  if (st !== undefined) entry.stream_timeout = st;
  const retries = num(c.retries);
  if (retries !== undefined) entry.retries = retries;
  const cidrs = strArr(c.allowed_cidrs);
  if (cidrs.length) entry.allowed_cidrs = cidrs;
  const ci = num(c.cost_input);
  const co = num(c.cost_output);
  if (ci !== undefined || co !== undefined) {
    entry.cost = {};
    if (ci !== undefined) entry.cost.input_per_1k = ci;
    if (co !== undefined) entry.cost.output_per_1k = co;
  }

  if (f.shape === 'direct') {
    entry.provider = f.direct.provider;
    entry.model_name = f.direct.model_name;
    entry.provider_key = f.direct.provider_key;
    if (f.direct.auto_prompt_caching) entry.auto_prompt_caching = {};
    if (c.cooldown) entry.cooldown = { enabled: true };
  } else if (f.shape === 'routing') {
    const r = f.routing;
    const targets = r.targets
      .filter((t) => t.model)
      .map((t) => {
        const o = { model: t.model };
        if (t.weight !== '') o.weight = Number(t.weight);
        if (t.tags) o.tags = strArr(t.tags);
        return o;
      });
    if (!targets.length) throw new Error('路由模型至少需要一个目标模型');
    entry.routing = { strategy: r.strategy, targets };
    if (r.retries !== '') entry.routing.retries = Number(r.retries);
    if (r.max_fallbacks !== '') entry.routing.max_fallbacks = Number(r.max_fallbacks);
    if (r.retry_on_429) entry.routing.retry_on_429 = true;
    const fb = strArr(r.fallback_on_statuses);
    if (fb.length) entry.routing.fallback_on_statuses = fb;
    entry.routing.when_all_unavailable = r.when_all_unavailable;
    if (r.sticky) entry.routing.sticky = {};
  } else if (f.shape === 'ensemble') {
    const en = f.ensemble;
    const panel = en.panel
      .filter((p) => p.model)
      .map((p) => {
        const o = { model: p.model };
        if (p.temperature !== '') o.temperature = Number(p.temperature);
        if (p.seed !== '') o.seed = Number(p.seed);
        if (p.weight !== '') o.weight = Number(p.weight);
        return o;
      });
    if (!panel.length) throw new Error('集成模型至少需要一个 panel 成员');
    entry.ensemble = { panel };
    if (en.judge.model) {
      const judge = { model: en.judge.model };
      if (en.judge.synthesis_prompt) judge.synthesis_prompt = en.judge.synthesis_prompt;
      entry.ensemble.judge = judge;
    }
    if (en.min_responses !== '') entry.ensemble.min_responses = Number(en.min_responses);
  } else if (f.shape === 'semantic') {
    const s = f.semantic;
    const routes = s.routes
      .filter((r) => r.name && r.target)
      .map((r) => {
        const o = { name: r.name, target: r.target };
        if (r.description) o.description = r.description;
        const ex = strArr(r.examples);
        if (ex.length) o.examples = ex;
        if (r.threshold !== '') o.threshold = Number(r.threshold);
        return o;
      });
    if (!routes.length) throw new Error('语义模型至少需要一个 route');
    entry.semantic = { embedding_model: s.embedding_model, routes };
    if (s.default) entry.semantic.default = s.default;
    if (s.match_threshold !== '') entry.semantic.match = { threshold: Number(s.match_threshold) };
    if (s.on_embedding_failure) entry.semantic.on_embedding_failure = s.on_embedding_failure;
  }

  return entry;
}

async function save() {
  if (!form.value.display_name) {
    lastResult.value = { ok: false, errors: [{ message: 'display_name 必填' }] };
    return;
  }
  let entry;
  try {
    entry = buildEntry();
  } catch (e) {
    lastResult.value = { ok: false, errors: [{ message: e.message }] };
    return;
  }
  saving.value = true;
  try {
    const isEdit = !!editing.value?.display_name;
    const result = isEdit
      ? await api.update('models', editing.value.display_name, entry)
      : await api.create('models', entry);
    lastResult.value = result;
    if (result.ok) {
      editing.value = null;
      await load();
    }
  } catch (e) {
    lastResult.value = { ok: false, errors: [{ message: e.message }] };
  } finally {
    saving.value = false;
  }
}

async function remove(e) {
  if (!confirm(`删除模型 "${e.display_name}"？`)) return;
  try {
    const r = await api.remove('models', e.display_name);
    lastResult.value = r;
    if (r.ok) await load();
  } catch (err) {
    lastResult.value = { ok: false, errors: [{ message: err.message }] };
  }
}

onMounted(load);
</script>

<template>
  <div>
    <div v-if="lastResult && !lastResult.ok" class="error-box">
      <div v-for="(e, i) in lastResult.errors" :key="i">- {{ e.message }}</div>
    </div>

    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: center">
        <h3 style="margin: 0">模型</h3>
        <button class="primary" @click="openCreate">+ 新增</button>
      </div>
      <table style="margin-top: 12px">
        <thead>
          <tr><th>名称</th><th>类型</th><th>目标</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-if="!loading && !entries.length">
            <td colspan="4" class="muted">暂无模型</td>
          </tr>
          <tr v-for="e in entries" :key="e.display_name">
            <td>{{ e.display_name }}</td>
            <td><span class="badge">{{ shapeLabels[detectShape(e)] }}</span></td>
            <td class="muted">
              <template v-if="e.routing">{{ e.routing.strategy }} → {{ e.routing.targets.map((t) => t.model).join(', ') }}</template>
              <template v-else-if="e.ensemble">{{ e.ensemble.panel.map((p) => p.model).join(', ') }} (集成)</template>
              <template v-else-if="e.semantic">{{ e.semantic.routes.map((r) => r.name).join(', ') }} (语义)</template>
              <template v-else>{{ e.provider }} / {{ e.model_name }}</template>
            </td>
            <td>
              <button style="margin-right: 6px" @click="openEdit(e)">编辑</button>
              <button class="danger" @click="remove(e)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <Modal v-if="editing !== null" :title="editing.display_name ? `编辑 ${editing.display_name}` : '新增模型'" @close="editing = null">
      <div style="margin-bottom: 12px">
        <button v-for="s in ['form', 'raw']" :key="s" :class="{ primary: tab === s }" style="margin-right: 6px" @click="tab = s">
          {{ s === 'form' ? '表单' : '原始 YAML' }}
        </button>
      </div>

      <template v-if="tab === 'form'">
        <div class="form-row">
          <label>名称 *</label>
          <input v-model="form.display_name" placeholder="调用方请求时使用的 model 名" />
        </div>
        <div class="form-row">
          <label>模型形态</label>
          <select v-model="form.shape">
            <option v-for="(label, val) in shapeLabels" :key="val" :value="val">{{ label }}</option>
          </select>
        </div>

        <!-- direct -->
        <template v-if="form.shape === 'direct'">
          <div class="form-row">
            <label>Provider</label>
            <input v-model="form.direct.provider" placeholder="openai / deepseek / ..." />
          </div>
          <div class="form-row">
            <label>上游模型名</label>
            <input v-model="form.direct.model_name" placeholder="gpt-4o-mini" />
          </div>
          <div class="form-row">
            <label>Provider Key</label>
            <select v-model="form.direct.provider_key">
              <option value="">选择…</option>
              <option v-for="p in providerKeys" :key="p.display_name" :value="p.display_name">{{ p.display_name }}</option>
            </select>
          </div>
          <div class="form-row">
            <label>自动提示缓存</label>
            <label style="justify-self: start"><input type="checkbox" v-model="form.direct.auto_prompt_caching" /> Anthropic 直连模型</label>
          </div>
          <div class="form-row">
            <label>冷却（cooldown）</label>
            <label style="justify-self: start"><input type="checkbox" v-model="form.common.cooldown" /> 上游异常后进入冷却</label>
          </div>
        </template>

        <!-- routing -->
        <template v-if="form.shape === 'routing'">
          <div class="form-row">
            <label>策略</label>
            <select v-model="form.routing.strategy">
              <option v-for="s in strategyOptions" :key="s" :value="s">{{ s }}</option>
            </select>
          </div>
          <div class="form-row full">
            <label style="text-align: left">目标（按顺序回退）</label>
            <div v-for="(t, i) in form.routing.targets" :key="i" style="display: flex; gap: 6px; margin-bottom: 6px; align-items: center">
              <select v-model="t.model" style="flex: 1">
                <option value="">选择模型…</option>
                <option v-for="m in allModels" :key="m" :value="m">{{ m }}</option>
              </select>
              <input v-model="t.weight" placeholder="weight" style="width: 80px" />
              <input v-model="t.tags" placeholder="tags 逗号分隔" style="width: 140px" />
              <button @click="form.routing.targets.splice(i, 1)">✕</button>
            </div>
            <button @click="form.routing.targets.push({ model: '', weight: '', tags: '' })">+ 添加目标</button>
          </div>
          <div class="form-row">
            <label>重试次数</label>
            <input v-model="form.routing.retries" type="number" placeholder="0" />
          </div>
          <div class="form-row">
            <label>最大回退次数</label>
            <input v-model="form.routing.max_fallbacks" type="number" placeholder="目标数-1" />
          </div>
          <div class="form-row">
            <label>回退状态码</label>
            <input v-model="form.routing.fallback_on_statuses" placeholder="429,500,502,503,504 逗号分隔" />
          </div>
          <div class="form-row">
            <label>全部不可用时</label>
            <select v-model="form.routing.when_all_unavailable">
              <option value="fail">失败</option>
              <option value="try_anyway">仍然尝试</option>
            </select>
          </div>
          <div class="form-row">
            <label>重试 429</label>
            <label style="justify-self: start"><input type="checkbox" v-model="form.routing.retry_on_429" /></label>
          </div>
          <div class="form-row">
            <label>Sticky 哈希</label>
            <label style="justify-self: start"><input type="checkbox" v-model="form.routing.sticky" />（weighted 策略按请求哈希固定目标）</label>
          </div>
        </template>

        <!-- ensemble -->
        <template v-if="form.shape === 'ensemble'">
          <div class="form-row full">
            <label style="text-align: left">Panel 成员</label>
            <div v-for="(p, i) in form.ensemble.panel" :key="i" style="display: flex; gap: 6px; margin-bottom: 6px; align-items: center">
              <select v-model="p.model" style="flex: 1">
                <option value="">选择模型…</option>
                <option v-for="m in allModels" :key="m" :value="m">{{ m }}</option>
              </select>
              <input v-model="p.temperature" placeholder="temp" style="width: 70px" />
              <input v-model="p.weight" placeholder="weight" style="width: 70px" />
              <button @click="form.ensemble.panel.splice(i, 1)">✕</button>
            </div>
            <button @click="form.ensemble.panel.push({ model: '', temperature: '', seed: '', weight: '' })">+ 添加成员</button>
          </div>
          <div class="form-row">
            <label>评审模型</label>
            <select v-model="form.ensemble.judge.model">
              <option value="">（可选）</option>
              <option v-for="m in allModels" :key="m" :value="m">{{ m }}</option>
            </select>
          </div>
          <div class="form-row">
            <label>最低成功数</label>
            <input v-model="form.ensemble.min_responses" type="number" placeholder="默认 min(2, panel数)" />
          </div>
        </template>

        <!-- semantic -->
        <template v-if="form.shape === 'semantic'">
          <div class="form-row">
            <label>嵌入模型</label>
            <select v-model="form.semantic.embedding_model">
              <option value="">选择…</option>
              <option v-for="m in allModels" :key="m" :value="m">{{ m }}</option>
            </select>
          </div>
          <div class="form-row">
            <label>匹配阈值</label>
            <input v-model="form.semantic.match_threshold" type="number" step="0.05" placeholder="0~1" />
          </div>
          <div class="form-row full">
            <label style="text-align: left">路由（按语义匹配）</label>
            <div v-for="(r, i) in form.semantic.routes" :key="i" style="border: 1px solid var(--border); border-radius: 6px; padding: 8px; margin-bottom: 8px">
              <div style="display: flex; gap: 6px; margin-bottom: 6px">
                <input v-model="r.name" placeholder="路由名" style="flex: 1" />
                <select v-model="r.target" style="flex: 1">
                  <option value="">目标模型…</option>
                  <option v-for="m in allModels" :key="m" :value="m">{{ m }}</option>
                </select>
                <button @click="form.semantic.routes.splice(i, 1)">✕</button>
              </div>
              <input v-model="r.description" placeholder="描述（可选）" style="width: 100%; margin-bottom: 6px" />
              <input v-model="r.examples" placeholder="示例话语，用 | 分隔（至少 1 条）" style="width: 100%; margin-bottom: 6px" />
              <input v-model="r.threshold" placeholder="阈值 0~1（可选）" style="width: 100%" />
            </div>
            <button @click="form.semantic.routes.push({ name: '', target: '', description: '', examples: '', threshold: '' })">+ 添加路由</button>
          </div>
          <div class="form-row">
            <label>默认目标</label>
            <select v-model="form.semantic.default">
              <option value="">（可选）</option>
              <option v-for="m in allModels" :key="m" :value="m">{{ m }}</option>
            </select>
          </div>
        </template>

        <hr style="border-color: var(--border); margin: 14px 0" />
        <div class="form-row">
          <label>超时 (ms)</label>
          <input v-model="form.common.timeout" type="number" placeholder="默认" />
        </div>
        <div class="form-row">
          <label>流式超时 (ms)</label>
          <input v-model="form.common.stream_timeout" type="number" placeholder="默认" />
        </div>
        <div class="form-row">
          <label>重试</label>
          <input v-model="form.common.retries" type="number" placeholder="0" />
        </div>
        <div class="form-row full">
          <label style="text-align: left">限流（留空不设）</label>
          <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px">
            <input v-model="form.common.rps" placeholder="rps" />
            <input v-model="form.common.rpm" placeholder="rpm" />
            <input v-model="form.common.rph" placeholder="rph" />
            <input v-model="form.common.rpd" placeholder="rpd" />
            <input v-model="form.common.tpm" placeholder="tpm" />
            <input v-model="form.common.tpd" placeholder="tpd" />
            <input v-model="form.common.concurrency" placeholder="并发" />
          </div>
        </div>
        <div class="form-row">
          <label>允许 CIDR</label>
          <input v-model="form.common.allowed_cidrs" placeholder="10.0.0.0/8, 逗号分隔" />
        </div>
        <div class="form-row">
          <label>成本 ($/1K)</label>
          <div style="display: flex; gap: 6px">
            <input v-model="form.common.cost_input" placeholder="输入" style="flex: 1" />
            <input v-model="form.common.cost_output" placeholder="输出" style="flex: 1" />
          </div>
        </div>
      </template>

      <template v-else>
        <RawYamlEditor :model-value="previewYaml" />
        <div class="muted" style="margin-top: 6px">当前表单内容的 YAML 预览；如需手写编辑请到「原始 YAML」页编辑整个文件。</div>
      </template>

      <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px">
        <button @click="editing = null">取消</button>
        <button class="primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存（校验并写文件）' }}</button>
      </div>
      <div v-if="lastResult && lastResult.ok" class="badge ok" style="margin-top: 10px">
        已保存{{ lastResult.reload?.warning ? '；' + lastResult.reload.warning : '' }}
      </div>
    </Modal>
  </div>
</template>
