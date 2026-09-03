import { useId, useMemo, useState, type CSSProperties } from 'react'
import {
  BarChart3,
  CircleAlert,
  Database,
  GitCompareArrows,
  Search,
} from 'lucide-react'
import type { SimulationFrame, SimulationHistory } from '@disaster/sim-core'
import type { MunicipalityRegionBundle, RegionalStatistics } from '../../data'
import {
  REGIONAL_STATISTIC_GROUPS,
  REGIONAL_STATISTICS,
  SIMULATION_METRIC_GROUPS,
  compileSimulationHistory,
  compileSimulationTimeline,
  formatStatisticValue,
  splitFiniteRuns,
  summarizeRegionalDistribution,
  timelineExtent,
  timelineSummary,
  type DistributionSummary,
  type CompiledSimulationTimeline,
  type MetricDescriptor,
  type RegionalMetricDescriptor,
  type SimulationMetricDescriptor,
  type TimelinePoint,
} from './statisticsCatalog'
import './StatisticsDashboard.css'

const CHART_WIDTH = 560
const CHART_HEIGHT = 176
const CHART_MARGIN = { top: 12, right: 14, bottom: 28, left: 48 }
const COMPARISON_COLOR = '#f5b868'

function cleanId(id: string) {
  return id.replace(/[^a-zA-Z0-9_-]/g, '')
}

function normalizedSearch(value: string) {
  return value.trim().toLocaleLowerCase('en-NL')
}

export function formatResolution(intervalMinutes: number | null) {
  if (intervalMinutes === null || !Number.isFinite(intervalMinutes)) return 'supplied states'
  const roundedMinutes = Math.round(intervalMinutes * 100) / 100
  if (roundedMinutes === 60) return 'hourly states'
  if (roundedMinutes < 60) return `${roundedMinutes}-minute states`
  if (roundedMinutes % 60 === 0) return `${roundedMinutes / 60}-hour states`
  return `${roundedMinutes}-minute states`
}

function metricMatchesSearch(
  metric: Pick<MetricDescriptor, 'id' | 'label' | 'description' | 'unit'>,
  groupLabel: string,
  query: string,
) {
  if (!query) return true
  return `${metric.id} ${metric.label} ${metric.description} ${metric.unit} ${groupLabel}`
    .toLocaleLowerCase('en-NL')
    .includes(query)
}

function scalePosition(value: number, minimum: number, maximum: number, start: number, size: number) {
  if (maximum === minimum) return start + size / 2
  return start + ((value - minimum) / (maximum - minimum)) * size
}

interface DistributionChartProps {
  metric: RegionalMetricDescriptor
  summary: DistributionSummary
  selectedLabel: string
  comparisonLabel?: string
  color: string
}

function DistributionChart({
  metric,
  summary,
  selectedLabel,
  comparisonLabel,
  color,
}: DistributionChartProps) {
  const reactId = useId()
  const titleId = `distribution-title-${cleanId(reactId)}`
  const descriptionId = `distribution-description-${cleanId(reactId)}`
  const minimum = summary.minimum ?? 0
  const maximum = summary.maximum ?? 1
  const left = 13
  const top = 12
  const width = 334
  const histogramHeight = 49
  const axisY = top + histogramHeight
  const maximumBin = Math.max(1, ...summary.bins.map((bin) => bin.count))
  const x = (value: number) => scalePosition(value, minimum, maximum, left, width)
  const selectedValue = formatStatisticValue(summary.selectedValue, metric)
  const comparisonValue = formatStatisticValue(summary.comparisonValue, metric)
  const selectedPercentile =
    summary.selectedPercentile === null ? '' : `, percentile ${Math.round(summary.selectedPercentile)}`

  if (!summary.observedCount) {
    return (
      <div className="stat-viz-no-chart" role="status">
        <CircleAlert size={16} />
        No observed values are available for this field in the municipality.
      </div>
    )
  }

  return (
    <svg
      className="stat-viz-distribution"
      viewBox="0 0 360 88"
      role="img"
      aria-labelledby={`${titleId} ${descriptionId}`}
    >
      <title id={titleId}>{`${metric.label} distribution`}</title>
      <desc id={descriptionId}>
        {selectedLabel}: {selectedValue}{selectedPercentile}. Distribution from {summary.observedCount}{' '}
        observed buurten; {summary.missingCount} missing. Range{' '}
        {formatStatisticValue(summary.minimum, metric)} to{' '}
        {formatStatisticValue(summary.maximum, metric)}.
        {comparisonLabel ? ` ${comparisonLabel}: ${comparisonValue}.` : ''}
      </desc>

      {summary.p10 !== null && summary.p90 !== null && (
        <rect
          className="stat-viz-distribution-band"
          x={x(summary.p10)}
          y={top}
          width={Math.max(1, x(summary.p90) - x(summary.p10))}
          height={histogramHeight}
          rx="2"
        >
          <title>{`Middle 80%: ${formatStatisticValue(summary.p10, metric)}–${formatStatisticValue(summary.p90, metric)}`}</title>
        </rect>
      )}

      {summary.bins.map((bin, index) => {
        const barWidth = width / Math.max(1, summary.bins.length)
        const barHeight = (bin.count / maximumBin) * 40
        return (
          <rect
            key={`${bin.minimum}-${index}`}
            className="stat-viz-histogram-bin"
            x={left + index * barWidth + 1}
            y={axisY - barHeight}
            width={Math.max(1, barWidth - 2)}
            height={barHeight}
            rx="1.5"
          >
            <title>{`${bin.count} buurt${bin.count === 1 ? '' : 'en'} from ${formatStatisticValue(bin.minimum, metric)} to ${formatStatisticValue(bin.maximum, metric)}`}</title>
          </rect>
        )
      })}

      <line className="stat-viz-axis" x1={left} x2={left + width} y1={axisY} y2={axisY} />
      {summary.median !== null && (
        <g
          className="stat-viz-median-marker"
          aria-hidden="true"
        >
          <line x1={x(summary.median)} x2={x(summary.median)} y1={top + 3} y2={axisY + 3} />
          <title>{`Municipality median: ${formatStatisticValue(summary.median, metric)}`}</title>
        </g>
      )}
      {summary.comparisonValue !== null && comparisonLabel && (
        <g
          className="stat-viz-comparison-marker"
          aria-hidden="true"
        >
          <line
            x1={x(summary.comparisonValue)}
            x2={x(summary.comparisonValue)}
            y1={top - 2}
            y2={axisY + 5}
          />
          <path d={`M ${x(summary.comparisonValue) - 4} ${top - 2} h 8 l -4 5 z`} />
          <title>{`${comparisonLabel}: ${comparisonValue}`}</title>
        </g>
      )}
      {summary.selectedValue !== null && (
        <g
          className="stat-viz-selected-marker"
          style={{ '--metric-color': color } as CSSProperties}
          aria-hidden="true"
        >
          <line
            x1={x(summary.selectedValue)}
            x2={x(summary.selectedValue)}
            y1={top - 4}
            y2={axisY + 7}
          />
          <circle cx={x(summary.selectedValue)} cy={top - 4} r="3.5" />
          <title>{`${selectedLabel}: ${selectedValue}${selectedPercentile}`}</title>
        </g>
      )}
      <text className="stat-viz-axis-label" x={left} y="82">
        {formatStatisticValue(summary.minimum, metric)}
      </text>
      <text className="stat-viz-axis-label" x={left + width} y="82" textAnchor="end">
        {formatStatisticValue(summary.maximum, metric)}
      </text>
    </svg>
  )
}

interface RegionalMetricCardProps extends DistributionChartProps {}

function RegionalMetricCard(props: RegionalMetricCardProps) {
  const { metric, summary, selectedLabel, comparisonLabel, color } = props
  return (
    <article className="stat-viz-card">
      <div className="stat-viz-card-heading">
        <div>
          <h4>{metric.label}</h4>
          <span>{metric.unit}</span>
        </div>
        <strong>{formatStatisticValue(summary.selectedValue, metric)}</strong>
      </div>
      <p>{metric.description}</p>
      <DistributionChart {...props} />
      <div className="stat-viz-card-context">
        <span>
          {summary.selectedPercentile === null
            ? 'Selected value unavailable'
            : `P${Math.round(summary.selectedPercentile)} of ${summary.observedCount} observed buurten`}
        </span>
        <span>
          Median {formatStatisticValue(summary.median, metric)}
        </span>
      </div>
      {comparisonLabel && (
        <div className="stat-viz-comparison-label">
          <i /> {comparisonLabel}: {formatStatisticValue(summary.comparisonValue, metric)}
        </div>
      )}
      {summary.missingCount > 0 && (
        <small className="stat-viz-missing">
          {summary.missingCount} CBS value{summary.missingCount === 1 ? '' : 's'} missing or suppressed
        </small>
      )}
    </article>
  )
}

export interface RegionalStatisticsDashboardProps {
  bundle: MunicipalityRegionBundle | null
  selectedNeighborhoodId: string | null
  comparisonNeighborhoodId?: string | null
  title?: string
  className?: string
}

/** Searchable graphs for every official CBS field in a municipality bundle. */
export function RegionalStatisticsDashboard({
  bundle,
  selectedNeighborhoodId,
  comparisonNeighborhoodId,
  title = 'Official buurt statistics',
  className = '',
}: RegionalStatisticsDashboardProps) {
  const dashboardId = cleanId(useId())
  const titleId = `regional-statistics-title-${dashboardId}`
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const normalizedQuery = normalizedSearch(query)
  const features = bundle?.neighborhoods.features ?? []
  const selectedFeature = features.find(
    (feature) => String(feature.id) === selectedNeighborhoodId,
  )
  const comparisonFeature = features.find(
    (feature) => String(feature.id) === comparisonNeighborhoodId,
  )
  const peerStatistics = useMemo(
    () => features.map((feature) => feature.properties.statistics),
    [features],
  )
  const resultCount = REGIONAL_STATISTIC_GROUPS.reduce(
    (count, group) =>
      count +
      (category === 'all' || category === group.id
        ? group.metrics.filter((metric) =>
            metricMatchesSearch(metric, group.label, normalizedQuery),
          ).length
        : 0),
    0,
  )
  const sourceUrl =
    typeof bundle?.source.statistics === 'string' ? bundle.source.statistics : undefined
  const retrievedAt =
    typeof bundle?.source.retrievedAt === 'string'
      ? new Intl.DateTimeFormat('en-NL', { dateStyle: 'medium' }).format(
          new Date(bundle.source.retrievedAt),
        )
      : null

  return (
    <section className={`stat-viz-dashboard ${className}`.trim()} aria-labelledby={titleId}>
      <header className="stat-viz-header">
        <div className="stat-viz-heading-icon"><Database size={18} /></div>
        <div>
          <span className="stat-viz-eyebrow">Observed context · not simulation output</span>
          <h2 id={titleId}>{title}</h2>
          <p>
            {bundle
              ? `${bundle.municipalityName} · ${features.length} CBS buurten · edition ${bundle.edition}`
              : 'Load a municipality to inspect its official buurt observations.'}
          </p>
        </div>
      </header>

      <div className="stat-viz-provenance" role="note">
        <Database size={14} />
        <span>
          Each graph compares the selected buurt with the actual distribution of observed buurten in
          this municipality. Missing and CBS-suppressed observations remain missing.
          {sourceUrl ? (
            <> Source: <a href={sourceUrl} target="_blank" rel="noreferrer">CBS table 86165NED</a>.</>
          ) : ' Source: CBS regional statistics.'}
          {retrievedAt ? ` Retrieved ${retrievedAt}.` : ''}
        </span>
      </div>

      <div className="stat-viz-toolbar">
        <label className="stat-viz-search">
          <Search size={14} />
          <span className="stat-viz-sr-only">Search official statistics</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search all 36 statistics"
            aria-label="Search all 36 official statistics"
          />
        </label>
        <label className="stat-viz-category">
          <span>Category</span>
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            aria-label="Filter official statistics by category"
          >
            <option value="all">All categories · {REGIONAL_STATISTICS.length}</option>
            {REGIONAL_STATISTIC_GROUPS.map((group) => (
              <option key={group.id} value={group.id}>{group.label} · {group.metrics.length}</option>
            ))}
          </select>
        </label>
        <output className="stat-viz-result-count" aria-live="polite">
          {resultCount} of {REGIONAL_STATISTICS.length} graphs
        </output>
      </div>

      {!bundle || !selectedFeature ? (
        <div className="stat-viz-empty" role="status">
          <BarChart3 size={22} />
          <strong>{bundle ? 'Select a buurt to graph its observations' : 'Regional data is loading'}</strong>
          <span>The dashboard never substitutes municipality values for a missing buurt selection.</span>
        </div>
      ) : resultCount === 0 ? (
        <div className="stat-viz-empty" role="status">
          <Search size={22} />
          <strong>No statistics match “{query}”</strong>
          <span>Try a label, unit, category or field name.</span>
        </div>
      ) : (
        <div className="stat-viz-groups">
          {REGIONAL_STATISTIC_GROUPS.map((group) => {
            if (category !== 'all' && category !== group.id) return null
            const metrics = group.metrics.filter((metric) =>
              metricMatchesSearch(metric, group.label, normalizedQuery),
            )
            if (!metrics.length) return null
            return (
              <section
                className="stat-viz-group"
                key={group.id}
                aria-labelledby={`regional-group-${dashboardId}-${group.id}`}
                style={{ '--group-color': group.color } as CSSProperties}
              >
                <div className="stat-viz-group-heading">
                  <div>
                    <h3 id={`regional-group-${dashboardId}-${group.id}`}>{group.label}</h3>
                    <p>{group.description}</p>
                  </div>
                  <span>{metrics.length} graph{metrics.length === 1 ? '' : 's'}</span>
                </div>
                <div className="stat-viz-card-grid">
                  {metrics.map((metric) => (
                    <RegionalMetricCard
                      key={metric.key}
                      metric={metric}
                      summary={summarizeRegionalDistribution(
                        metric,
                        selectedFeature.properties.statistics,
                        peerStatistics,
                        comparisonFeature?.properties.statistics,
                      )}
                      selectedLabel={selectedFeature.properties.name}
                      comparisonLabel={comparisonFeature?.properties.name}
                      color={group.color}
                    />
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      )}
    </section>
  )
}

export interface ChartSeries {
  id: string
  label: string
  color: string
  points: readonly TimelinePoint[]
  dashed?: boolean
}

function chartPath(
  run: readonly TimelinePoint[],
  x: (hour: number) => number,
  y: (value: number) => number,
) {
  return run
    .map((point, index) => `${index ? 'L' : 'M'} ${x(point.hour).toFixed(2)} ${y(point.value as number).toFixed(2)}`)
    .join(' ')
}

function tooltipPoints(points: readonly TimelinePoint[]) {
  const finite = points.filter(
    (point): point is TimelinePoint & { value: number } =>
      point.value !== null && Number.isFinite(point.value),
  )
  if (finite.length <= 13) return finite
  const markers = new Map<number, (typeof finite)[number]>()
  for (let hour = 0; hour <= 72; hour += 6) {
    const closest = finite.reduce((candidate, point) =>
      Math.abs(point.hour - hour) < Math.abs(candidate.hour - hour) ? point : candidate,
    )
    markers.set(closest.step, closest)
  }
  markers.set(finite[0].step, finite[0])
  markers.set(finite.at(-1)!.step, finite.at(-1)!)
  return [...markers.values()].sort((left, right) => left.hour - right.hour)
}

export interface AccessibleLineChartProps {
  metric: SimulationMetricDescriptor
  series: readonly ChartSeries[]
  activeHour?: number
}

export function AccessibleLineChart({ metric, series, activeHour }: AccessibleLineChartProps) {
  const reactId = useId()
  const titleId = `timeline-title-${cleanId(reactId)}`
  const descriptionId = `timeline-description-${cleanId(reactId)}`
  const [minimum, maximum] = timelineExtent(series.map((item) => item.points), metric)
  const plotWidth = CHART_WIDTH - CHART_MARGIN.left - CHART_MARGIN.right
  const plotHeight = CHART_HEIGHT - CHART_MARGIN.top - CHART_MARGIN.bottom
  const x = (hour: number) => CHART_MARGIN.left + (Math.max(0, Math.min(72, hour)) / 72) * plotWidth
  const y = (value: number) =>
    CHART_MARGIN.top + plotHeight - ((value - minimum) / Math.max(Number.EPSILON, maximum - minimum)) * plotHeight
  const primarySummary = timelineSummary(series[0]?.points ?? [])
  const observedSeries = series.filter((item) => timelineSummary(item.points).observedCount > 0)

  if (!observedSeries.length) {
    return (
      <div className="stat-viz-no-chart stat-viz-no-chart-timeline" role="status">
        <CircleAlert size={16} /> No frames contain this metric for the selected municipality.
      </div>
    )
  }

  return (
    <svg
      className="stat-viz-line-chart"
      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      role="img"
      aria-labelledby={`${titleId} ${descriptionId}`}
    >
      <title id={titleId}>{`${metric.label} over the first 72 hours`}</title>
      <desc id={descriptionId}>
        {series.map((item) => {
          const summary = timelineSummary(item.points)
          return `${item.label}: ${summary.observedCount} observed frames, ${summary.missingCount} missing, minimum ${formatStatisticValue(summary.minimum, metric)}, maximum ${formatStatisticValue(summary.maximum, metric)}, latest ${formatStatisticValue(summary.latest, metric)}.`
        }).join(' ')}
      </desc>

      {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
        const value = minimum + (maximum - minimum) * (1 - fraction)
        const tickY = CHART_MARGIN.top + plotHeight * fraction
        return (
          <g key={fraction} className="stat-viz-y-tick">
            <line x1={CHART_MARGIN.left} x2={CHART_WIDTH - CHART_MARGIN.right} y1={tickY} y2={tickY} />
            <text x={CHART_MARGIN.left - 7} y={tickY + 3} textAnchor="end">
              {formatStatisticValue(value, { ...metric, unit: '' })}
            </text>
          </g>
        )
      })}
      {[0, 12, 24, 36, 48, 60, 72].map((hour) => (
        <g key={hour} className="stat-viz-x-tick">
          <line x1={x(hour)} x2={x(hour)} y1={CHART_MARGIN.top} y2={CHART_MARGIN.top + plotHeight} />
          <text x={x(hour)} y={CHART_HEIGHT - 8} textAnchor={hour === 0 ? 'start' : hour === 72 ? 'end' : 'middle'}>
            {hour}h
          </text>
        </g>
      ))}

      {typeof activeHour === 'number' && activeHour >= 0 && activeHour <= 72 && (
        <g className="stat-viz-active-time">
          <line x1={x(activeHour)} x2={x(activeHour)} y1={CHART_MARGIN.top} y2={CHART_MARGIN.top + plotHeight} />
          <text x={x(activeHour)} y={CHART_MARGIN.top + 9} textAnchor="middle">now</text>
        </g>
      )}

      {observedSeries.map((item) => (
        <g
          key={item.id}
          className={`stat-viz-series${item.dashed ? ' comparison' : ''}`}
          style={{ '--series-color': item.color } as CSSProperties}
        >
          {splitFiniteRuns(item.points).map((run, index) => (
            <path key={`${item.id}-run-${index}`} d={chartPath(run, x, y)} />
          ))}
          {tooltipPoints(item.points).map((point) => (
            <circle
              key={`${item.id}-${point.step}`}
              cx={x(point.hour)}
              cy={y(point.value)}
              r="2.6"
              aria-hidden="true"
            >
              <title>{`${item.label} · ${point.hour.toFixed(point.hour % 1 ? 2 : 0)} h · ${formatStatisticValue(point.value, metric)}`}</title>
            </circle>
          ))}
        </g>
      ))}

      <text className="stat-viz-unit-label" x={CHART_MARGIN.left} y="9">{metric.unit}</text>
      <text className="stat-viz-axis-title" x={CHART_WIDTH - CHART_MARGIN.right} y={CHART_HEIGHT - 8} textAnchor="end">
        hours after scenario start
      </text>
      {primarySummary.missingCount > 0 && (
        <text className="stat-viz-gap-label" x={CHART_WIDTH - CHART_MARGIN.right} y="9" textAnchor="end">
          gaps preserved
        </text>
      )}
    </svg>
  )
}

function unionTimelineRows(series: readonly ChartSeries[]) {
  const rows = new Map<number, { step: number; hour: number; values: Map<string, number | null> }>()
  for (const item of series) {
    for (const point of item.points) {
      const key = Number(point.hour.toFixed(6))
      const row = rows.get(key) ?? { step: point.step, hour: point.hour, values: new Map() }
      row.values.set(item.id, point.value)
      rows.set(key, row)
    }
  }
  return [...rows.values()].sort((left, right) => left.hour - right.hour)
}

interface TimelineMetricCardProps {
  metric: SimulationMetricDescriptor
  primary: readonly TimelinePoint[]
  primaryLabel: string
  color: string
  comparison?: readonly TimelinePoint[]
  comparisonLabel?: string
  activeHour?: number
}

function TimelineMetricCard({
  metric,
  primary,
  primaryLabel,
  color,
  comparison,
  comparisonLabel,
  activeHour,
}: TimelineMetricCardProps) {
  const series: ChartSeries[] = [
    { id: 'primary', label: primaryLabel, color, points: primary },
  ]
  if (comparison && comparisonLabel) {
    series.push({
      id: 'comparison',
      label: comparisonLabel,
      color: COMPARISON_COLOR,
      points: comparison,
      dashed: true,
    })
  }
  const primarySummary = timelineSummary(primary)
  const comparisonSummary = comparison ? timelineSummary(comparison) : null
  const rows = unionTimelineRows(series)

  return (
    <article className="stat-viz-card stat-viz-timeline-card">
      <div className="stat-viz-card-heading">
        <div>
          <h4>{metric.label}</h4>
          <span>{metric.unit}</span>
        </div>
        <strong>{formatStatisticValue(primarySummary.latest, metric)}</strong>
      </div>
      <p>{metric.description}</p>
      <AccessibleLineChart metric={metric} series={series} activeHour={activeHour} />
      <div className="stat-viz-card-context">
        <span>Peak {formatStatisticValue(primarySummary.maximum, metric)} at {primarySummary.maximumHour?.toFixed(1) ?? '—'}h</span>
        <span>{primarySummary.observedCount} frame{primarySummary.observedCount === 1 ? '' : 's'}</span>
      </div>
      <div className="stat-viz-series-legend" aria-label="Chart series">
        <span style={{ '--legend-color': color } as CSSProperties}><i />{primaryLabel}</span>
        {comparisonLabel && comparisonSummary && (
          <span className="comparison" style={{ '--legend-color': COMPARISON_COLOR } as CSSProperties}>
            <i />{comparisonLabel} · latest {formatStatisticValue(comparisonSummary.latest, metric)}
          </span>
        )}
      </div>
      {(primarySummary.missingCount > 0 || (comparisonSummary?.missingCount ?? 0) > 0) && (
        <small className="stat-viz-missing">
          Missing frames are shown as gaps; no interpolation is applied.
        </small>
      )}
      <details className="stat-viz-data-table">
        <summary>Accessible data table · {rows.length} timestamps</summary>
        <div>
          <table>
            <caption>{metric.label}, 0–72 hour scenario history</caption>
            <thead>
              <tr>
                <th scope="col">Hour</th>
                {series.map((item) => <th scope="col" key={item.id}>{item.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.hour}>
                  <th scope="row">{row.hour.toFixed(row.hour % 1 ? 2 : 0)} h</th>
                  {series.map((item) => (
                    <td key={item.id}>{formatStatisticValue(row.values.get(item.id), metric)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </article>
  )
}

export interface SimulationTimelineComparison {
  label: string
  frames?: readonly SimulationFrame[]
  history?: SimulationHistory
  compiled?: CompiledSimulationTimeline
}

export interface SimulationTimelineDashboardProps {
  frames?: readonly SimulationFrame[]
  history?: SimulationHistory
  compiled?: CompiledSimulationTimeline
  municipalityId?: string
  primaryLabel?: string
  comparison?: SimulationTimelineComparison
  activeHour?: number
  title?: string
  provenance?: string
  className?: string
}

/**
 * Searchable 0–72 hour charts for all numeric national, municipality, hazard
 * and essential-service outputs. For large histories, pass a streaming-compiled
 * dataset instead of retaining route-heavy frames. The component never derives
 * or perturbs scenario values.
 */
export function SimulationTimelineDashboard({
  frames = [],
  history,
  compiled,
  municipalityId,
  primaryLabel = 'Active scenario',
  comparison,
  activeHour,
  title = '72-hour simulation statistics',
  provenance = 'Deterministic scenario-engine output. Operational capacity, dependencies and restoration remain model assumptions, not observations or forecasts.',
  className = '',
}: SimulationTimelineDashboardProps) {
  const dashboardId = cleanId(useId())
  const titleId = `simulation-statistics-title-${dashboardId}`
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState(municipalityId ? 'impact' : 'national')
  const normalizedQuery = normalizedSearch(query)
  const primaryDataset = useMemo(
    () => compiled ?? (history
      ? compileSimulationHistory(history, municipalityId)
      : compileSimulationTimeline(frames, municipalityId)),
    [compiled, history, frames, municipalityId],
  )
  const primaryTimeline = primaryDataset.timeline
  const comparisonDataset = useMemo(
    () => comparison
      ? comparison.compiled ?? (comparison.history
        ? compileSimulationHistory(comparison.history, municipalityId)
        : compileSimulationTimeline(comparison.frames ?? [], municipalityId))
      : null,
    [comparison, municipalityId],
  )
  const comparisonTimeline = comparisonDataset?.timeline ?? null
  const availableGroups = SIMULATION_METRIC_GROUPS.filter(
    (group) => group.scope === 'national' || Boolean(municipalityId),
  )
  const effectiveCategory =
    category === 'all' || availableGroups.some((group) => group.id === category)
      ? category
      : (availableGroups[0]?.id ?? 'all')
  const availableMetricCount = availableGroups.reduce(
    (sum, group) => sum + group.metrics.length,
    0,
  )
  const resultCount = availableGroups.reduce(
    (count, group) =>
      count +
      (effectiveCategory === 'all' || effectiveCategory === group.id
        ? group.metrics.filter((metric) => metricMatchesSearch(metric, group.label, normalizedQuery)).length
        : 0),
    0,
  )
  const minimumHour = primaryDataset.minimumHour
  const maximumHour = primaryDataset.maximumHour
  const resolutionLabel = formatResolution(primaryDataset.intervalMinutes)

  return (
    <section className={`stat-viz-dashboard ${className}`.trim()} aria-labelledby={titleId}>
      <header className="stat-viz-header">
        <div className="stat-viz-heading-icon"><BarChart3 size={18} /></div>
        <div>
          <span className="stat-viz-eyebrow">Scenario output · {resolutionLabel}</span>
          <h2 id={titleId}>{title}</h2>
          <p>
            {primaryDataset.frameCount
              ? `${primaryDataset.frameCount} supplied frames · ${minimumHour?.toFixed(2)}–${maximumHour?.toFixed(2)} h${municipalityId ? ` · ${municipalityId}` : ' · national'}`
              : 'No simulation history has been supplied.'}
          </p>
        </div>
        {comparison && (
          <div className="stat-viz-compare-badge">
            <GitCompareArrows size={14} />
            <span>{primaryLabel} vs {comparison.label}</span>
          </div>
        )}
      </header>

      <div className="stat-viz-provenance assumed" role="note">
        <CircleAlert size={14} />
        <span>{provenance} Graphs use only supplied states; gaps are retained and disclosed.</span>
      </div>

      <div className="stat-viz-toolbar">
        <label className="stat-viz-search">
          <Search size={14} />
          <span className="stat-viz-sr-only">Search simulation statistics</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${availableMetricCount} simulation metrics`}
            aria-label={`Search ${availableMetricCount} simulation metrics`}
          />
        </label>
        <label className="stat-viz-category">
          <span>Category</span>
          <select
            value={effectiveCategory}
            onChange={(event) => setCategory(event.target.value)}
            aria-label="Filter simulation statistics by category"
          >
            <option value="all">All categories · {availableGroups.reduce((sum, group) => sum + group.metrics.length, 0)}</option>
            {availableGroups.map((group) => (
              <option key={group.id} value={group.id}>{group.label} · {group.metrics.length}</option>
            ))}
          </select>
        </label>
        <output className="stat-viz-result-count" aria-live="polite">
          {resultCount} graph{resultCount === 1 ? '' : 's'}
        </output>
      </div>

      {!primaryDataset.frameCount ? (
        <div className="stat-viz-empty" role="status">
          <BarChart3 size={22} />
          <strong>Simulation history is not loaded</strong>
          <span>Supply real SimulationFrame objects covering hour 0 through 72.</span>
        </div>
      ) : resultCount === 0 ? (
        <div className="stat-viz-empty" role="status">
          <Search size={22} />
          <strong>No metrics match “{query}”</strong>
          <span>Try availability, flood, demand, population or a service name.</span>
        </div>
      ) : (
        <div className="stat-viz-groups">
          {availableGroups.map((group) => {
            if (effectiveCategory !== 'all' && effectiveCategory !== group.id) return null
            const metrics = group.metrics.filter((metric) =>
              metricMatchesSearch(metric, group.label, normalizedQuery),
            )
            if (!metrics.length) return null
            return (
              <section
                className="stat-viz-group"
                key={group.id}
                aria-labelledby={`simulation-group-${dashboardId}-${group.id}`}
                style={{ '--group-color': group.color } as CSSProperties}
              >
                <div className="stat-viz-group-heading">
                  <div>
                    <h3 id={`simulation-group-${dashboardId}-${group.id}`}>{group.label}</h3>
                    <p>{group.description}</p>
                  </div>
                  <span>{metrics.length} graph{metrics.length === 1 ? '' : 's'}</span>
                </div>
                <div className="stat-viz-card-grid stat-viz-timeline-grid">
                  {metrics.map((metric) => (
                    <TimelineMetricCard
                      key={metric.id}
                      metric={metric}
                      primary={primaryTimeline[metric.id] ?? []}
                      primaryLabel={primaryLabel}
                      comparison={comparisonTimeline?.[metric.id]}
                      comparisonLabel={comparison?.label}
                      color={group.color}
                      activeHour={activeHour}
                    />
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      )}
    </section>
  )
}

export type { RegionalStatistics }
