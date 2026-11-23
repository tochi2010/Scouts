const session = import.meta.env.VITE_SCOUT_SESSION?.trim()

export function scoutingStorageKey(base: string): string {
  return session ? `${base}-${session}` : base
}
