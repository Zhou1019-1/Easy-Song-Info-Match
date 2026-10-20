<script setup lang="ts">
import ModalShell from './ModalShell.vue'

defineProps<{
  title: string
  message: string
  detail?: string
  confirmText?: string
  danger?: boolean
}>()

const emit = defineEmits<{
  (e: 'confirm'): void
  (e: 'cancel'): void
}>()
</script>

<template>
  <ModalShell :title="title" width="440px" @close="emit('cancel')">
    <div>{{ message }}</div>
    <div v-if="detail" style="margin-top: 8px; color: var(--text-dim); white-space: pre-wrap">{{ detail }}</div>
    <slot />
    <template #foot>
      <button class="btn" @click="emit('cancel')">取消</button>
      <button class="btn" :class="{ danger: danger, primary: !danger }" @click="emit('confirm')">
        {{ confirmText ?? '确认' }}
      </button>
    </template>
  </ModalShell>
</template>
