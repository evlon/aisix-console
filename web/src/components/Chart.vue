<script setup>
// Thin ECharts wrapper: inits once, updates on option change, auto-resizes,
// disposes on unmount. Tree-shaken imports keep the bundle small.
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import * as echarts from 'echarts/core';
import { LineChart, BarChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  DataZoomComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  LineChart,
  BarChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  DataZoomComponent,
  CanvasRenderer,
]);

const props = defineProps({
  option: { type: Object, required: true },
  height: { type: [Number, String], default: 260 },
});

const el = ref(null);
let chart = null;
let ro = null;

function render() {
  if (chart && props.option) chart.setOption(props.option, true);
}

onMounted(() => {
  chart = echarts.init(el.value);
  render();
  ro = new ResizeObserver(() => chart && chart.resize());
  ro.observe(el.value);
});

watch(() => props.option, render, { deep: true });

onBeforeUnmount(() => {
  if (ro) ro.disconnect();
  if (chart) chart.dispose();
  chart = null;
});
</script>

<template>
  <div ref="el" :style="{ width: '100%', height: typeof height === 'number' ? height + 'px' : height }"></div>
</template>
