<script setup>
import { ref } from 'vue';

defineProps({
  title: { type: String, default: '' },
});
const emit = defineEmits(['close']);
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px">
        <h3 style="margin: 0">{{ title }}</h3>
        <button @click="emit('close')" style="padding: 2px 10px">✕</button>
      </div>
      <slot />
    </div>
  </div>
</template>
