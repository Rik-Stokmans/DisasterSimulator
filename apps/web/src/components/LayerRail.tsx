import type { CSSProperties } from 'react'
import {
  Boxes,
  Building2,
  CloudRain,
  Droplets,
  Flame,
  Gauge,
  Layers3,
  Radio,
  Route,
  Users,
  Waves,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import type { LayerId } from '@disaster/sim-core'
import { layerDefinitions } from '../config'

const iconByLayer: Record<LayerId, LucideIcon> = {
  overview: Layers3,
  hazard: CloudRain,
  power: Zap,
  water: Droplets,
  drainage: Waves,
  gas: Flame,
  telecom: Radio,
  mobility: Route,
  facilities: Building2,
  population: Users,
  supply: Boxes,
}

interface LayerRailProps {
  activeLayer: LayerId
  onLayerChange: (layer: LayerId) => void
}

export function LayerRail({ activeLayer, onLayerChange }: LayerRailProps) {
  return (
    <nav className="layer-rail panel" aria-label="Simulation map layers">
      <div className="layer-rail-heading">
        <Gauge size={15} />
        <span>Map modes</span>
      </div>
      <div className="layer-list">
        {layerDefinitions.map((layer) => {
          const Icon = iconByLayer[layer.id]
          const active = layer.id === activeLayer
          return (
            <button
              key={layer.id}
              type="button"
              className={`layer-button${active ? ' active' : ''}`}
              style={{ '--layer-color': layer.color } as CSSProperties}
              aria-pressed={active}
              aria-label={`${layer.label}: ${layer.metric}`}
              title={layer.description}
              onClick={() => onLayerChange(layer.id)}
            >
              <span className="layer-icon"><Icon size={18} strokeWidth={1.8} /></span>
              <span className="layer-copy">
                <strong>{layer.compactLabel}</strong>
                <small>{layer.metric}</small>
              </span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
