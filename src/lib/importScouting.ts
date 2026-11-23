/**
 * Import scouting data from local JSON files
 * Converts our scouting format to Scouts app MatchEntry format
 */
import { saveMatch, saveGameConfig, loadGameConfig, listMatches } from './db'
import { biobuzzConfig } from '../data/biobuzzConfig'

interface ScoutingImportData {
  schema_version: string
  season: number
  game: string
  manual_version: string
  event_code: string
  event_name: string
  generated_at: string
  source: string
  matches: ScoutingMatch[]
  teams_summary: ScoutingTeamSummary[]
}

interface ScoutingMatch {
  match_number: string
  level: string
  match_id: string
  video_url: string
  alliances: {
    red: ScoutingRobot[]
    blue: ScoutingRobot[]
  }
}

interface ScoutingRobot {
  team_number: number
  team_name: string
  position: number
  auto: {
    leave: boolean
    park: boolean
    tips: number
    launched: number
    official_points: number
  }
  teleop: {
    launched: number
    tips: number
    garden: number
    launch_accuracy: number
    defense: boolean
  }
  endgame: {
    flower_elements: number
    flower_nectar: boolean
    park: boolean
  }
  scores: {
    alliance: number
    opponent: number
  }
  subjective: {
    driver_skill: number
    robot_speed: number
    tags: string[]
    notes: string
  }
}

interface ScoutingTeamSummary {
  team_number: number
  team_name: string
  matches_played: number
  avg_auto_tips: number
  avg_teleop_tips: number
  avg_launch_accuracy: number
  win_rate: number
}

/**
 * Convert our scouting data to MatchEntry format
 */
function convertToMatchEntry(
  robot: ScoutingRobot,
  match: ScoutingMatch,
  alliance: 'red' | 'blue',
  gameId: string
): MatchEntry {
  const allyTeam = alliance === 'red' 
    ? match.alliances.red.find(r => r.team_number !== robot.team_number)?.team_number
    : match.alliances.blue.find(r => r.team_number !== robot.team_number)?.team_number

  return {
    id: crypto.randomUUID(),
    gameId,
    matchNumber: match.match_number,
    teamNumber: String(robot.team_number),
    scoutName: 'AI-Scout',
    createdAt: Date.now(),
    values: {
      allyTeam1: allyTeam ?? 0,
      startSpot: null,
      autoLeave: robot.auto.leave,
      autoPark: robot.auto.park,
      autoLaunched: robot.auto.launched,
      autoTips: robot.auto.tips,
      officialAutoPoints: robot.auto.official_points,
      teleopLaunched: robot.teleop.launched,
      teleopTips: robot.teleop.tips,
      gardenElements: robot.teleop.garden,
      launchAccuracy: robot.teleop.launch_accuracy,
      defensePlayed: robot.teleop.defense,
      flowerElements: robot.endgame.flower_elements,
      flowerNectar: robot.endgame.flower_nectar,
      endPark: robot.endgame.park,
      allianceScore: robot.scores.alliance,
      opponentAllianceScore: robot.scores.opponent,
      driverSkill: robot.subjective.driver_skill,
      robotSpeed: robot.subjective.robot_speed,
      tags: robot.subjective.tags.join(', '),
      notes: robot.subjective.notes,
    },
  }
}

type MatchEntry = {
  id: string
  gameId: string
  matchNumber: string
  teamNumber: string
  scoutName: string
  createdAt: number
  values: Record<string, number | boolean | string | null>
}

/**
 * Import all scouting data from the JSON file
 */
export async function importScoutingData(): Promise<{ imported: number; skipped: number }> {
  try {
    const response = await fetch('/scout-data/scouting_import.json')
    if (!response.ok) {
      throw new Error(`Failed to fetch: ${response.status}`)
    }
    const data: ScoutingImportData = await response.json()

    // Ensure the biobuzz config exists
    const existingConfig = await loadGameConfig(biobuzzConfig.gameId)
    if (!existingConfig) {
      await saveGameConfig(biobuzzConfig)
    }

    // Check what matches already exist
    const existingMatches = await listMatches(biobuzzConfig.gameId)
    const existingKeys = new Set(
      existingMatches.map(m => `${m.matchNumber}-${m.teamNumber}`)
    )

    let imported = 0
    let skipped = 0

    // Import each match
    for (const match of data.matches) {
      // Process red alliance
      for (const robot of match.alliances.red) {
        const key = `${match.match_number}-${robot.team_number}`
        if (existingKeys.has(key)) {
          skipped++
          continue
        }

        const entry = convertToMatchEntry(robot, match, 'red', biobuzzConfig.gameId)
        await saveMatch(entry)
        imported++
      }

      // Process blue alliance
      for (const robot of match.alliances.blue) {
        const key = `${match.match_number}-${robot.team_number}`
        if (existingKeys.has(key)) {
          skipped++
          continue
        }

        const entry = convertToMatchEntry(robot, match, 'blue', biobuzzConfig.gameId)
        await saveMatch(entry)
        imported++
      }
    }

    return { imported, skipped }
  } catch (error) {
    console.error('Failed to import scouting data:', error)
    throw error
  }
}

/**
 * Check if scouting data has already been imported
 */
export async function isScoutingDataImported(): Promise<boolean> {
  try {
    const matches = await listMatches(biobuzzConfig.gameId)
    return matches.length > 0
  } catch {
    return false
  }
}
