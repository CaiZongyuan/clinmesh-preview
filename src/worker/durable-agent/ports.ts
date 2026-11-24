// The runtime reaches its host only through these ports, so it can live in a plain Durable Object now and be
// hosted under an Agents SDK `Agent` later (whose `schedule()` replaces the alarm).
export interface Scheduler {
  // Wake the runtime at `at` (epoch ms), replacing any earlier request; `null` cancels.
  wakeAt(at: number | null): Promise<void>
}

export function alarmScheduler(storage: DurableObjectStorage): Scheduler {
  return {
    wakeAt: (at) => (at === null ? storage.deleteAlarm() : storage.setAlarm(at)),
  }
}
