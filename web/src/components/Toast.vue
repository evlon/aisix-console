<script setup>
import { ref } from 'vue';

const toasts = ref([]);
let seq = 0;

function push(kind, message) {
  const id = ++seq;
  toasts.value.push({ id, kind, message });
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }, 5000);
}

defineExpose({
  ok: (m) => push('success', m),
  err: (m) => push('error', m),
  info: (m) => push('info', m),
});
</script>

<template>
  <div class="toast-wrap">
    <div v-for="t in toasts" :key="t.id" class="toast" :class="t.kind">
      {{ t.message }}
    </div>
  </div>
</template>
