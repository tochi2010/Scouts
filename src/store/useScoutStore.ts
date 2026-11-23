import { create } from 'zustand'
import type { GameConfig } from '../types/gameConfig'
import { exampleGameConfig } from '../data/exampleGameConfig'
import { biobuzzConfig } from '../data/biobuzzConfig'
import { scoutingStorageKey } from '../lib/scoutingSession'
import { withPresetPoints } from '../data/presets'
import { useEventStore } from './useEventStore'
import { useNexusStore } from './useNexusStore'
import {
  saveGameConfig,
  loadGameConfig,
  saveMatch,
  listMatches,
  deleteMatch,
  clearAllScoutingData,
  type MatchEntry,
} from '../lib/db'
import { importScoutingData } from '../lib/importScouting'

const ACTIVE_GAME_KEY = scoutingStorageKey('activeGameId')
const defaultGame = import.meta.env.VITE_FTC_EVENT_CODE ? biobuzzConfig : exampleGameConfig

interface ScoutState {
  config: GameConfig
  matches: MatchEntry[]
  loaded: boolean
  importing: boolean
  init: () => Promise<void>
  setConfig: (config: GameConfig) => Promise<void>
  addMatch: (entry: MatchEntry) => Promise<void>
  removeMatch: (id: string) => Promise<void>
  clearData: () => Promise<void>
  importData: () => Promise<{ imported: number; skipped: number }>
}

export const useScoutStore = create<ScoutState>((set, get) => ({
  config: defaultGame,
  matches: [],
  loaded: false,
  importing: false,

  init: async () => {
    // Recordar el último gameId aplicado; si no, al recargar volvía siempre al config por defecto
    const activeId = localStorage.getItem(ACTIVE_GAME_KEY) ?? defaultGame.gameId
    const stored = (await loadGameConfig(activeId)) ?? (await loadGameConfig(defaultGame.gameId))
    const config = stored ? withPresetPoints(stored) : defaultGame
    if (!stored) await saveGameConfig(defaultGame)
    const matches = await listMatches(config.gameId)
    set({ config, matches, loaded: true })

    // Los datos de ejemplo se importan únicamente mediante “Importar JSON”.
    // Así una limpieza no vuelve a poblar la base local al recargar.
  },

  setConfig: async (config) => {
    // FRC y FTC son ligas distintas: sin esto, equipos/cronograma del evento FRC
    // sincronizado aparecían en FTC (sugerencias, nombres, pit, autocompletado)
    if (config.mode !== get().config.mode) {
      useEventStore.setState({ teams: [], rankings: [], matches: [], lastSyncedAt: null, error: null, scheduleError: null })
      useNexusStore.setState({ eventKey: '', matches: [], pits: {}, announcements: [], dataAsOfTime: null, raw: null, lastSyncedAt: null, error: null })
    }
    await saveGameConfig(config)
    localStorage.setItem(ACTIVE_GAME_KEY, config.gameId)
    const matches = await listMatches(config.gameId)
    set({ config, matches })
  },

  addMatch: async (entry) => {
    await saveMatch(entry)
    set({ matches: [...get().matches.filter((m) => m.id !== entry.id), entry] })
  },

  removeMatch: async (id) => {
    await deleteMatch(id)
    set({ matches: get().matches.filter((m) => m.id !== id) })
  },

  clearData: async () => {
    await clearAllScoutingData()
    set({ matches: [] })
  },

  importData: async () => {
    set({ importing: true })
    try {
      const result = await importScoutingData()
      const config = get().config
      const newMatches = await listMatches(config.gameId)
      set({ matches: newMatches, importing: false })
      return result
    } catch (error) {
      set({ importing: false })
      throw error
    }
  },
}))
