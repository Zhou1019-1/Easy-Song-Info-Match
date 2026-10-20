<script setup lang="ts">
/**
 * 简易虚拟滚动表格：只渲染可视区域的行，10 万行也不卡。
 * 表头由父组件通过 header 插槽提供，横向滚动自动同步。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 总行数 */
    total: number
    /** 行高（px） */
    rowHeight?: number
    /** 视口外额外渲染行数 */
    overscan?: number
    /** 取第 index 行（可能为 undefined，表示尚未加载） */
    getRow: (index: number) => any
  }>(),
  { rowHeight: 30, overscan: 8 }
)

const emit = defineEmits<{
  (e: 'range', start: number, end: number): void
}>()

defineSlots<{
  header?: () => any
  default?: (props: { row: any; index: number }) => any
}>()

const scroller = ref<HTMLElement | null>(null)
const headInner = ref<HTMLElement | null>(null)
const start = ref(0)
const end = ref(0)

const totalHeight = computed(() => Math.max(0, props.total) * props.rowHeight)
const offsetY = computed(() => start.value * props.rowHeight)
const indices = computed(() => {
  const out: number[] = []
  for (let i = start.value; i <= end.value; i++) out.push(i)
  return out
})

let observer: ResizeObserver | null = null

function update(): void {
  const el = scroller.value
  if (!el) return
  const st = el.scrollTop
  const vh = el.clientHeight || 400
  const first = Math.floor(st / props.rowHeight)
  const count = Math.ceil(vh / props.rowHeight)
  const s = Math.max(0, first - props.overscan)
  const last = Math.max(props.total - 1, 0)
  const e = Math.min(last, first + count + props.overscan)
  if (s !== start.value || e !== end.value) {
    start.value = s
    end.value = e
    emit('range', s, e)
  }
  if (headInner.value) headInner.value.style.transform = `translateX(${-el.scrollLeft}px)`
}

function onScroll(): void {
  update()
}

function scrollToIndex(index: number): void {
  const el = scroller.value
  if (!el) return
  el.scrollTop = Math.max(0, index * props.rowHeight - el.clientHeight / 2)
  update()
}

watch(
  () => props.total,
  () => update()
)

onMounted(() => {
  update()
  if (scroller.value && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => update())
    observer.observe(scroller.value)
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})

defineExpose({ scrollToIndex })
</script>

<template>
  <div class="vt-wrap" style="display: flex; flex-direction: column; min-height: 0; flex: 1">
    <div class="lib-head-wrap">
      <div ref="headInner" class="vt-head-inner">
        <slot name="header" />
      </div>
    </div>
    <div ref="scroller" class="vt" @scroll="onScroll">
      <div class="vt-sizer" :style="{ height: totalHeight + 'px' }">
        <div class="vt-window" :style="{ transform: 'translateY(' + offsetY + 'px)' }">
          <div
            v-for="i in indices"
            :key="i"
            class="vt-row"
            :style="{ height: rowHeight + 'px' }"
          >
            <slot :row="getRow(i)" :index="i" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vt-head-inner {
  min-width: 1180px;
  will-change: transform;
}
</style>
