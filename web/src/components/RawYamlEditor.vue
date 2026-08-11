<script setup>
import { ref, watch } from 'vue';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const props = defineProps({
  modelValue: { type: String, default: '' },
  rows: { type: Number, default: 10 },
});
const emit = defineEmits(['update:modelValue']);

const text = ref(props.modelValue);
watch(
  () => props.modelValue,
  (v) => {
    if (v !== text.value) text.value = v;
  },
);
watch(text, (v) => emit('update:modelValue', v));

const error = ref('');
function check() {
  error.value = '';
  try {
    parseYaml(text.value || '', { uniqueKeys: true });
  } catch (e) {
    error.value = e.message;
  }
}

defineExpose({ check });
</script>

<template>
  <div>
    <textarea
      v-model="text"
      :rows="rows"
      spellcheck="false"
      style="width: 100%; font-family: ui-monospace, Consolas, monospace; font-size: 12px; line-height: 1.5"
      @input="check"
    />
    <div v-if="error" class="error-box" style="margin-top: 6px">YAML 解析错误: {{ error }}</div>
  </div>
</template>
