// ─── Service: Status Cleanup ──────────────────────────────────────────────────
// The server's scheduled BullMQ job (Slice 7) owns all status cleanup.
// The client-side sweep is permanently disabled — these stubs keep call sites
// compiling while the Firestore fallback branches are removed in Slice 8.

export function startStatusCleanupService(): void {
  console.log('[StatusCleanup] Server-side cleanup active; client sweep disabled.');
}

export function stopStatusCleanupService(): void {}

export function isCleanupServiceRunning(): boolean { return false; }

export async function triggerManualCleanup(): Promise<number> {
  console.log('[StatusCleanup] Server handles cleanup; manual trigger is a no-op.');
  return 0;
}
