<script setup lang="ts">
import { dismissToast, toasts } from '../lib/toast'
</script>

<template>
  <div class="toast-host">
    <div v-for="t in toasts" :key="t.id" class="toast" :class="t.type" @click="dismissToast(t.id)">
      <span>{{ t.text }}</span>
      <button class="x" title="关闭" @click.stop="dismissToast(t.id)">×</button>
    </div>
  </div>
</template>
