import { useMemo, type CSSProperties } from 'react'
import { Pause, Play, RotateCcw, SkipBack, SkipForward } from 'lucide-react'
import { formatSimulationTime, TIMELINE_STEPS, type ScenarioConfig } from '@disaster/sim-core'
import { eventsForScenario } from '../scenarios'
import { formatHour } from '../utils'

interface TimelineProps {
  step: number
  playing: boolean
  speed: number
  scenario: ScenarioConfig
  onStepChange: (step: number) => void
  onPlayingChange: (playing: boolean) => void
  onSpeedChange: (speed: number) => void
}

const checkpoints = [
  { step: 0, label: 'T+0' },
  { step: 24, label: 'T+6' },
  { step: 48, label: 'T+12' },
  { step: 96, label: 'T+24' },
  { step: 192, label: 'T+48' },
  { step: 288, label: 'T+72' },
] as const

export function Timeline({
  step,
  playing,
  speed,
  scenario,
  onStepChange,
  onPlayingChange,
  onSpeedChange,
}: TimelineProps) {
  const progress = (step / (TIMELINE_STEPS - 1)) * 100
  const scenarioEvents = eventsForScenario(scenario)
  const eventGroups = useMemo(() => {
    const byStep = new Map<number, typeof scenarioEvents>()
    for (const event of scenarioEvents) {
      const existing = byStep.get(event.step) ?? []
      existing.push(event)
      byStep.set(event.step, existing)
    }
    return [...byStep.entries()]
      .map(([eventStep, events]) => ({ step: eventStep, events }))
      .sort((left, right) => left.step - right.step)
  }, [scenarioEvents])
  const currentCheckpoint = [...checkpoints].reverse().find((checkpoint) => checkpoint.step <= step)!
  const currentEvents = eventGroups.find((group) => group.step === step)?.events ?? []
  const nextEvent = eventGroups.find((group) => group.step > step)
  const move = (amount: number) => onStepChange(Math.max(0, Math.min(TIMELINE_STEPS - 1, step + amount)))

  return (
    <section className="timeline panel" aria-label="72-hour simulation timeline">
      <div className="timeline-controls">
        <button type="button" className="transport-button subtle" onClick={() => onStepChange(0)} aria-label="Reset timeline">
          <RotateCcw size={17} />
        </button>
        <button type="button" className="transport-button subtle" onClick={() => move(-1)} aria-label="Previous 15-minute frame">
          <SkipBack size={18} />
        </button>
        <button
          type="button"
          className="transport-button play"
          onClick={() => onPlayingChange(!playing)}
          aria-label={playing ? 'Pause simulation' : 'Play simulation'}
        >
          {playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
        </button>
        <button type="button" className="transport-button subtle" onClick={() => move(1)} aria-label="Next 15-minute frame">
          <SkipForward size={18} />
        </button>
        <div className="current-time">
          <strong>{formatSimulationTime(step)}</strong>
          <span>{formatHour(step, scenario)}</span>
        </div>
      </div>

      <div className="timeline-track-wrap">
        <div className="event-track">
          {eventGroups.map((group) => (
            <button
              type="button"
              key={group.step}
              className={`event-marker ${group.events[0].tone}${group.step <= step ? ' elapsed' : ''}`}
              style={{ left: `${(group.step / (TIMELINE_STEPS - 1)) * 100}%` }}
              title={`${formatSimulationTime(group.step)} — ${group.events.map((event) => event.label).join(' · ')}`}
              aria-label={`Jump to ${formatSimulationTime(group.step)}: ${group.events.map((event) => event.label).join('; ')}`}
              onClick={() => onStepChange(group.step)}
            >
              <span />
              {group.events.length > 1 && <b aria-hidden="true">{group.events.length}</b>}
            </button>
          ))}
        </div>
        <input
          className="timeline-range"
          type="range"
          min={0}
          max={TIMELINE_STEPS - 1}
          step={1}
          value={step}
          aria-label="Simulation time from zero to 72 hours"
          aria-valuetext={`${formatSimulationTime(step)}, ${formatHour(step, scenario)}`}
          style={{ '--timeline-progress': `${progress}%` } as CSSProperties}
          onChange={(event) => onStepChange(Number(event.target.value))}
          onWheel={(event) => {
            move(event.deltaY > 0 || event.deltaX > 0 ? 1 : -1)
          }}
        />
        <div className="timeline-ticks" aria-label="Operational checkpoints">
          {checkpoints.map((checkpoint) => (
            <button
              type="button"
              key={checkpoint.step}
              className={checkpoint.step === step ? 'active' : checkpoint.step < step ? 'elapsed' : ''}
              style={{ left: `${(checkpoint.step / (TIMELINE_STEPS - 1)) * 100}%` }}
              aria-label={`Jump to ${checkpoint.label} operational checkpoint`}
              aria-current={checkpoint.step === step ? 'step' : undefined}
              onClick={() => onStepChange(checkpoint.step)}
            >
              {checkpoint.label}
            </button>
          ))}
        </div>
      </div>

      <div className="timeline-meta">
        <div className="timeline-phase" aria-live="off">
          <span className="pulse-dot" />
          <span>
            <strong>{currentCheckpoint.label}</strong>{' · '}
            {currentEvents.length
              ? currentEvents.map((event) => event.label).join(' + ')
              : nextEvent
                ? `next: ${formatSimulationTime(nextEvent.step)} ${nextEvent.events.map((event) => event.label).join(' + ')}`
                : step < scenario.startHour * 4
                  ? `${scenario.name} · pre-event baseline`
                  : 'Modeled restoration window'}
          </span>
        </div>
        <div className="speed-control" role="group" aria-label="Playback speed">
          {[1, 4, 12].map((option) => (
            <button
              type="button"
              key={option}
              className={speed === option ? 'active' : ''}
              aria-pressed={speed === option}
              onClick={() => onSpeedChange(option)}
            >
              {option}×
            </button>
          ))}
        </div>
        <span className="resolution-label">15 min states · 289 frames</span>
      </div>
    </section>
  )
}
