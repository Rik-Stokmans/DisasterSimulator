import { useEffect, useRef, useState } from 'react'
import { BarChart3, ChevronDown, ClipboardList, Map, MapPin, Menu, RotateCcw, ShieldAlert, X } from 'lucide-react'
import type { MunicipalityDefinition } from '@disaster/sim-core'

interface TopBarProps {
  municipalities: MunicipalityDefinition[]
  selectedMunicipalityId: string
  viewMode: 'national' | 'city'
  intervention: 'baseline' | 'generator-priority' | 'mutual-aid'
  analyticsOpen: boolean
  briefOpen: boolean
  onMunicipalityChange: (id: string) => void
  onNationalView: () => void
  onInterventionChange: (value: 'baseline' | 'generator-priority' | 'mutual-aid') => void
  onAnalyticsOpen: () => void
  onBriefOpen: () => void
}

export function TopBar({
  municipalities,
  selectedMunicipalityId,
  viewMode,
  intervention,
  analyticsOpen,
  briefOpen,
  onMunicipalityChange,
  onNationalView,
  onInterventionChange,
  onAnalyticsOpen,
  onBriefOpen,
}: TopBarProps) {
  const selected = municipalities.find((city) => city.code === selectedMunicipalityId)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!mobileMenuOpen) return
    const close = (event: PointerEvent) => {
      if (
        !menuRef.current?.contains(event.target as Node) &&
        !menuButtonRef.current?.contains(event.target as Node)
      ) setMobileMenuOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [mobileMenuOpen])

  return (
    <header className="topbar panel">
      <div className="brand">
        <div className="brand-mark"><ShieldAlert size={21} /></div>
        <div>
          <h1>NL Resilience Lab</h1>
          <span>72-hour systems simulation</span>
        </div>
      </div>

      <nav className="mode-breadcrumb" aria-label="Current simulation scale">
        <button type="button" className={viewMode === 'national' ? 'active' : ''} onClick={onNationalView}>
          <Map size={15} /> Netherlands
        </button>
        <span>/</span>
        <button
          ref={menuButtonRef}
          type="button"
          className={viewMode === 'city' ? 'active' : ''}
          onClick={() => selected && onMunicipalityChange(selected.code)}
        >
          <MapPin size={15} /> {selected?.name ?? 'Municipality'}
        </button>
      </nav>

      <div className="topbar-actions">
        <button
          type="button"
          className="icon-text-button analytics-button"
          aria-label="Open analytics and evidence"
          aria-expanded={analyticsOpen}
          onClick={onAnalyticsOpen}
        >
          <BarChart3 size={16} />
          <span>Analytics</span>
        </button>
        <label className="compact-select city-select">
          <span>Open municipality</span>
          <select value={selectedMunicipalityId} onChange={(event) => onMunicipalityChange(event.target.value)}>
            {municipalities.map((municipality) => (
              <option key={municipality.code} value={municipality.code}>{municipality.name}</option>
            ))}
          </select>
          <ChevronDown size={14} aria-hidden="true" />
        </label>
        <div
          ref={menuRef}
          id="responsive-operations-menu"
          className={`responsive-operations-menu${mobileMenuOpen ? ' open' : ''}`}
        >
          <label className="compact-select intervention-select">
            <span>Intervention</span>
            <select
              value={intervention}
              onChange={(event) => {
                onInterventionChange(event.target.value as typeof intervention)
                setMobileMenuOpen(false)
              }}
            >
              <option value="baseline">Baseline response</option>
              <option value="generator-priority">Protect critical generators</option>
              <option value="mutual-aid">Early municipal mutual aid</option>
            </select>
            <ChevronDown size={14} aria-hidden="true" />
          </label>
          <button
            type="button"
            className="icon-text-button brief-button"
            aria-label="Open eight-service decision brief"
            aria-expanded={briefOpen}
            onClick={() => {
              onBriefOpen()
              setMobileMenuOpen(false)
            }}
          >
            <ClipboardList size={16} />
            <span>Decision brief</span>
          </button>
          <button
            type="button"
            className="icon-text-button national-reset-button"
            onClick={() => {
              onNationalView()
              setMobileMenuOpen(false)
            }}
            title="Reset national view"
          >
            <RotateCcw size={16} />
            <span>National</span>
          </button>
        </div>
        <button
          type="button"
          className="icon-text-button mobile-operations-menu-button"
          aria-label={mobileMenuOpen ? 'Close operations menu' : 'Open operations menu'}
          aria-expanded={mobileMenuOpen}
          aria-controls="responsive-operations-menu"
          onClick={() => setMobileMenuOpen((current) => !current)}
        >
          {mobileMenuOpen ? <X size={17} /> : <Menu size={17} />}
        </button>
      </div>
    </header>
  )
}
