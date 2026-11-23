import type { MatchEntry, PitReport } from './db'

type BackendObservation = {
  team_number?: number | null
  action_type: string
  value?: string | number | boolean | null
  phase?: string | null
  confidence?: number
  evidence_reference?: string | null
  model_id?: string | null
}

type BackendMatch = {
  id: number
  status?: string
  match_number?: string | null
  red_1?: number | null
  red_2?: number | null
  blue_1?: number | null
  blue_2?: number | null
  observations?: BackendObservation[]
}

const API = import.meta.env.VITE_SCOUT_API ?? '/ai-api'

type CaptureSummary = { id: string; status: string; pendingFields?: string[]; provisionalReady?: boolean }
type CaptureRobot = Record<string, unknown> & {
  teamNumber: unknown
  evidence?: Record<string, number[]>
  count_coverage?: Record<string, { reviewed: number; required: number; observed: number | null }>
}
type CaptureReport = {
  source: string
  reviewed_analysis?: CaptureReport['analysis']
  provisional_analysis?: CaptureReport['analysis']
  nvidia_review?: { status?: string; model?: string }
  official_review?: {
    source: string
    robots: {
      teamNumber: number; autoLeave: boolean | null; autoPark: boolean | null; endPark: boolean | null
      autoTips?: number | null; teleopTips?: number | null
    }[]
    alliances: Record<'red' | 'blue', { finalScore: number | null; officialAutoPoints: number | null }>
  }
  analysis: {
    model?: string
    matchNumber: string | number | null
    redTeams: number[] | null
    blueTeams: number[] | null
    redScore: number | null
    blueScore: number | null
    robots: CaptureRobot[]
  } | null
}

const robotFields = [
  'autoLeave', 'autoPark', 'autoLaunched', 'autoTips', 'teleopLaunched', 'teleopTips',
  'gardenElements', 'launchAccuracy', 'defensePlayed', 'flowerElements', 'flowerNectar',
  'endPark', 'driverSkill', 'robotSpeed',
] as const

async function fetchAi<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`)
  if (!response.ok) throw new Error(`Backend AI ${response.status}`)
  return await response.json() as T
}

async function importCaptureReports() {
  const summaries = await fetchAi<CaptureSummary[]>('/api/streams/reports?all_reports=true')
  const entries = new Map<string, MatchEntry>()
  const pits = new Map<number, PitReport>()
  for (const summary of summaries) {
    if (!summary.provisionalReady && !['NEEDS_REVIEW', 'INCOMPLETE'].includes(summary.status)) continue
    const reportPath = `/api/streams/reports/${encodeURIComponent(summary.id)}`
    const report = await fetchAi<CaptureReport>(reportPath + '?compact=true')
    const { source, official_review: official, nvidia_review: nvidia } = report
    const analysis = report.reviewed_analysis ?? report.provisional_analysis ?? report.analysis
    if (!analysis || !source || analysis.matchNumber == null) continue
    const provider = analysis.model?.startsWith('nvidia/') ? 'NVIDIA NIM'
      : nvidia?.status === 'COMPLETED' ? 'Gemini + NVIDIA NIM' : 'Gemini'
    const matchNumber = String(analysis.matchNumber).trim()
    if (!matchNumber) continue
    const teamNumber = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    const red = Array.isArray(analysis.redTeams) ? analysis.redTeams.filter(teamNumber) : []
    const blue = Array.isArray(analysis.blueTeams) ? analysis.blueTeams.filter(teamNumber) : []
    for (const team of new Set([...red, ...blue])) {
      if (red.includes(team) && blue.includes(team)) continue
      const id = `capture-ai-${encodeURIComponent(source)}-${encodeURIComponent(matchNumber)}-${team}`
      if (entries.has(id)) continue
      const isRed = red.includes(team)
      const robot = analysis.robots.find((row) => String(row.teamNumber) === String(team))
      const values: MatchEntry['values'] = {}
      const ally = (isRed ? red : blue).find((n) => n !== team)
      if (ally !== undefined) values.allyTeam1 = ally
      const [ownScore, opposingScore] = isRed ? [analysis.redScore, analysis.blueScore] : [analysis.blueScore, analysis.redScore]
      if (typeof ownScore === 'number' && Number.isSafeInteger(ownScore)) values.allianceScore = ownScore
      if (typeof opposingScore === 'number' && Number.isSafeInteger(opposingScore)) values.opponentAllianceScore = opposingScore
      const evidence: string[] = []
      for (const field of robotFields) {
        const value = robot?.[field]
        const seconds = robot?.evidence?.[field]
        if (!Array.isArray(seconds) || !seconds.length) continue
        if (typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value))) continue
        values[field] = value
        evidence.push(`${field}: ${seconds.join(', ')} s`)
      }
      const startSpot = robot?.startSpot
      if (robot?.evidence?.startSpot?.length && typeof startSpot === 'string') {
        const xy = startSpot.split(',').map(Number)
        if (xy.length === 2 && xy.every((coordinate) => Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 100)) {
          values.startSpot = xy.join(',')
        }
      }
      if (robot?.evidence?.tags?.length && Array.isArray(robot.tags)) {
        const allowed = ['Rápido', 'Preciso', 'Buen piloto', 'Juega defensa', 'Falta (foul)', 'Se descompuso', 'Inconsistente']
        const tags = allowed.filter((tag) => (robot.tags as unknown[]).includes(tag))
        if (tags.length) values.tags = tags.join(',')
      }
      const pit = pits.get(team) ?? {
        id: `ftc-biobuzz-2026_${team}`, gameId: 'ftc-biobuzz-2026', teamNumber: String(team),
        updatedAt: Date.now(), values: {},
      }
      let hasPitEvidence = false
      for (const key of ['drivetrainType', 'pitCanLaunch', 'pitCanFlower', 'pitNotes'] as const) {
        const value = robot?.[key]
        if (!robot?.evidence?.[key]?.length || pit.values[key] !== undefined) continue
        if (key === 'drivetrainType' ? typeof value === 'string' && ['Mecanum', 'Swerve', 'Tanque', 'Otro'].includes(value)
          : key === 'pitNotes' ? typeof value === 'string' && !!value.trim() : value === true) {
          if (typeof value !== 'string' && typeof value !== 'boolean') continue
          pit.values[key] = key === 'pitNotes' ? String(value) + ` · Revisión IA, partido ${matchNumber}.` : value
          hasPitEvidence = true
        }
      }
      if (hasPitEvidence) pits.set(team, pit)
      const officialRobot = official?.robots.find((row) => row.teamNumber === team)
      const ownAlliance = official?.alliances[isRed ? 'red' : 'blue']
      const oppositeAlliance = official?.alliances[isRed ? 'blue' : 'red']
      if (officialRobot) {
        for (const key of ['autoLeave', 'autoPark', 'endPark'] as const) {
          if (typeof officialRobot[key] === 'boolean') values[key] = officialRobot[key]
        }
        for (const key of ['autoTips', 'teleopTips'] as const) {
          if (officialRobot[key] === 0) values[key] = 0
        }
      }
      if (typeof ownAlliance?.officialAutoPoints === 'number') values.officialAutoPoints = ownAlliance.officialAutoPoints
      if (typeof ownAlliance?.finalScore === 'number') values.allianceScore = ownAlliance.finalScore
      if (typeof oppositeAlliance?.finalScore === 'number') values.opponentAllianceScore = oppositeAlliance.finalScore
      const countLabels: Record<string, string> = {
        autoLaunched: 'CELL en Auto', autoTips: 'HIVE TIPs en Auto', teleopLaunched: 'CELL en TeleOp',
        teleopTips: 'HIVE TIPs en TeleOp', gardenElements: 'GARDEN', flowerElements: 'FLOWERS',
      }
      const incomplete = Object.entries(robot?.count_coverage ?? {}).flatMap(([field, coverage]) => {
        if (!countLabels[field] || values[field] !== undefined || coverage.reviewed === coverage.required) return []
        const observed = coverage.observed === null ? '' : `, conteo parcial ${coverage.observed}`
        return [`${countLabels[field]}: ${coverage.reviewed}/${coverage.required} tramos con evidencia${observed}`]
      })
      const pending = (summary.pendingFields ?? []).filter(field => field.startsWith(`${team} · `))
        .map(field => field.slice(String(team).length + 3))
      values.notes = [
        `${provider} · alianza ${isRed ? 'roja' : 'azul'} · pendiente de revisión`,
        robot?.evidence?.notes?.length && typeof robot.notes === 'string' ? robot.notes : null,
        typeof values.autoLaunched === 'number' ? `Lanzamientos registrados en Auto: ${values.autoLaunched}.` : null,
        typeof values.teleopLaunched === 'number' ? `Lanzamientos registrados en TeleOp: ${values.teleopLaunched}.` : null,
        typeof values.endPark === 'boolean' ? (values.endPark ? 'Registró PARK al final.' : 'Terminó sin PARK acreditado.') : null,
        evidence.length ? evidence.join(' · ') : 'Sin acciones individuales respaldadas por el modelo.',
        incomplete.length ? 'Cobertura incompleta · ' + incomplete.join(' · ') : null,
        pending.length ? 'Datos pendientes de este robot · ' + pending.join(' · ') : null,
        `Informe original: ${new URL(API + reportPath, window.location.origin).href}`,
        official ? `FTCScout: LEAVE y PARK por robot. Los puntos de Auto y finales son de alianza. Un total oficial de cero HIVE TIPs aplica a ambos robots. ${official.source}` : null,
      ].filter(Boolean).join('\n')
      entries.set(id, {
        id, gameId: 'ftc-biobuzz-2026', matchNumber, teamNumber: String(team),
        alliance: isRed ? 'red' : 'blue',
        scoutName: `${provider} · revisión pendiente`, createdAt: Date.now(), values,
      })
    }
  }
  return { matches: [...entries.values()], pits: [...pits.values()] }
}

function valueOf(value: BackendObservation['value']): number | boolean | string | null {
  if (typeof value !== 'string') return value ?? null
  try { return JSON.parse(value) as number | boolean | string } catch { return value }
}

function numberOf(value: BackendObservation['value']): number {
  const parsed = valueOf(value)
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : 0
}

export async function importAiMatches() {
  const capturedEntries = await importCaptureReports()
  const response = await fetch(`${API}/api/matches`)
  if (!response.ok) throw new Error(`Backend AI ${response.status}`)
  const matches = await response.json() as BackendMatch[]
  const entries: MatchEntry[] = []
  for (const match of matches) {
    if (String(match.match_number ?? '').startsWith('auto-')) continue
    const teams = [match.red_1, match.red_2, match.blue_1, match.blue_2].filter((n): n is number => typeof n === 'number')
    if (!teams.length) continue
    const detailResponse = await fetch(`${API}/api/matches/${match.id}`)
    if (!detailResponse.ok) throw new Error(`Detalle de partido ${match.id}: ${detailResponse.status}`)
    const detail = await detailResponse.json() as BackendMatch
    for (const team of teams) {
      const own = (detail.observations ?? []).filter((o) => o.team_number === team && (o.model_id ?? '').startsWith('gemini-') && o.action_type !== 'VIDEO_FRAME_ANALYSIS')
      if (!own.length) continue
      const values: MatchEntry['values'] = {}
      const notes: string[] = []
      const alliance = [match.red_1, match.red_2].includes(team) ? [match.red_1, match.red_2] : [match.blue_1, match.blue_2]
      const ally = alliance.find((n) => typeof n === 'number' && n !== team)
      if (ally !== undefined && ally !== null) values.allyTeam1 = ally
      for (const observation of own) {
        const action = observation.action_type.toUpperCase()
        const phase = (observation.phase ?? '').toUpperCase()
        const n = numberOf(observation.value)
        const raw = valueOf(observation.value)
        if (action === 'LEAVE' && typeof raw === 'boolean') values.autoLeave = raw
        else if (action === 'PARK' && typeof raw === 'boolean') values[phase === 'AUTO' || phase === 'AUTONOMOUS' ? 'autoPark' : 'endPark'] = raw
        else if (action === 'END_PARK' && typeof raw === 'boolean') values.endPark = raw
        else if (action === 'HIVE_TIP' && typeof raw === 'number') values[phase === 'AUTO' || phase === 'AUTONOMOUS' ? 'autoTips' : 'teleopTips'] = n
        else if (action === 'LAUNCH_ATTEMPT' && typeof raw === 'number') values[phase === 'AUTO' || phase === 'AUTONOMOUS' ? 'autoLaunched' : 'teleopLaunched'] = n
        else if (action === 'GARDEN' && typeof raw === 'number') values.gardenElements = n
        else if (action === 'LAUNCH_ACCURACY') values.launchAccuracy = Math.max(0, Math.min(5, n))
        else if (action === 'DEFENSE' && typeof raw === 'boolean') values.defensePlayed = raw
        else if (action === 'FLOWERS' && typeof raw === 'number') values.flowerElements = n
        else if (action === 'NECTAR' && typeof raw === 'boolean') values.flowerNectar = raw
        const confidence = observation.confidence == null ? '' : ` (${Math.round(observation.confidence * 100)}%)`
        notes.push(`${action}${confidence}`)
      }
      values.notes = `AI · revisar evidencia. ${notes.length ? notes.join(', ') : 'Sin acciones verificadas para este equipo.'}`
      entries.push({
        id: `ai-${match.id}-${team}`,
        gameId: 'ftc-biobuzz-2026',
        matchNumber: String(match.match_number ?? match.id),
        teamNumber: String(team),
        scoutName: 'AI · revisión pendiente',
        createdAt: Date.now(),
        values,
      })
    }
  }
  return { matches: [...capturedEntries.matches, ...entries], pits: capturedEntries.pits }
}
