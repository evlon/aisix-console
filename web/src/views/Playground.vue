<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../api.js';

const models = ref([]);
const model = ref('');
const callerKey = ref(localStorage.getItem('aisix_console_caller_key') || '');
const messages = ref([{ role: 'user', content: '' }]);
const prompt = ref('');
const stream = ref(true);
const temperature = ref('');
const output = ref('');
const running = ref(false);
const error = ref('');

const LS_KEY = 'aisix_console_caller_key';

async function loadModels() {
  try {
    const r = await api.list('models');
    models.value = (r.entries ?? []).map((e) => e.display_name).filter(Boolean);
    if (!model.value && models.value.length) model.value = models.value[0];
  } catch (e) {
    error.value = `无法加载模型列表: ${e.message}`;
  }
}

function saveKey() {
  localStorage.setItem(LS_KEY, callerKey.value);
}

async function send() {
  const content = prompt.value.trim();
  if (!content || running.value) return;
  error.value = '';
  messages.value.push({ role: 'user', content });
  prompt.value = '';
  output.value = '';
  running.value = true;

  const body = { model: model.value, messages: messages.value, callerKey: callerKey.value, stream: stream.value };
  if (temperature.value !== '') body.temperature = Number(temperature.value);

  try {
    const res = await fetch('/api/playground/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const d = await res.json();
        detail = d.error || detail;
        if (d.detail) detail += `\n${d.detail}`;
      } catch {
        /* ignore */
      }
      error.value = detail;
      return;
    }

    if (body.stream) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            try {
              const chunk = JSON.parse(data);
              const delta = chunk.choices?.[0]?.delta?.content;
              if (delta) output.value += delta;
            } catch {
              /* partial/keepalive */
            }
          }
        }
      }
      messages.value.push({ role: 'assistant', content: output.value });
    } else {
      const d = await res.json();
      output.value = d.choices?.[0]?.message?.content ?? JSON.stringify(d, null, 2);
      messages.value.push({ role: 'assistant', content: output.value });
    }
  } catch (e) {
    error.value = `请求失败: ${e.message}`;
  } finally {
    running.value = false;
  }
}

function clearChat() {
  messages.value = [{ role: 'user', content: '' }];
  output.value = '';
  error.value = '';
}

onMounted(loadModels);
</script>

<template>
  <div>
    <div class="card">
      <h3 style="margin-top: 0">试玩 / 对话</h3>
      <div style="display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 8px; margin-bottom: 10px">
        <div>
          <label class="muted" style="display: block; margin-bottom: 4px">模型</label>
          <select v-model="model" style="width: 100%">
            <option v-for="m in models" :key="m" :value="m">{{ m }}</option>
          </select>
        </div>
        <div>
          <label class="muted" style="display: block; margin-bottom: 4px">调用方 API Key</label>
          <input v-model="callerKey" type="password" placeholder="sk-..." style="width: 100%" @change="saveKey" />
        </div>
        <div>
          <label class="muted" style="display: block; margin-bottom: 4px">temperature</label>
          <input v-model="temperature" type="number" step="0.1" placeholder="默认" style="width: 100%" />
        </div>
        <div style="display: flex; align-items: flex-end; gap: 8px">
          <label style="display: flex; align-items: center; gap: 6px">
            <input type="checkbox" v-model="stream" /> 流式
          </label>
          <button class="danger" @click="clearChat">清空</button>
        </div>
      </div>

      <div v-if="error" class="error-box">{{ error }}</div>
      <div v-if="!callerKey" class="warn-box">需要填入一个调用方 API Key（到「API Keys」页创建）才能发起真实请求。</div>

      <div style="display: flex; gap: 10px">
        <textarea
          v-model="prompt"
          rows="3"
          placeholder="输入消息…"
          style="flex: 1; resize: vertical"
          @keydown.enter.exact.prevent="send"
        />
        <button class="primary" :disabled="running || !callerKey" @click="send" style="align-self: stretch">
          {{ running ? '发送中…' : '发送' }}
        </button>
      </div>

      <div style="margin-top: 12px">
        <label class="muted">回复（{{ stream ? 'SSE 流式' : '一次性' }}）</label>
        <pre
          class="output"
          style="white-space: pre-wrap; word-break: break-word; background: #0d0f15; border: 1px solid var(--border); border-radius: 6px; padding: 12px; min-height: 120px; max-height: 480px; overflow: auto"
        >{{ output || '（等待回复…）' }}</pre>
      </div>
    </div>
  </div>
</template>
