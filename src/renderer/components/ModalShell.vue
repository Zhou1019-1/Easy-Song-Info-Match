<script setup lang="ts">
defineProps<{
  title: string
  width?: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()
</script>

<template>
  <div class="modal-mask" @mousedown.self="emit('close')">
    <div class="modal" :style="width ? { width } : undefined">
      <div class="modal-head">
        <span>{{ title }}</span>
        <button class="x" title="关闭" @click="emit('close')">×</button>
      </div>
      <div class="modal-body">
        <slot />
      </div>
      <div class="modal-foot">
        <slot name="foot" />
      </div>
    </div>
  </div>
</template>
