import type { LayerId } from '@disaster/sim-core'

export interface LayerDefinition {
  id: LayerId
  label: string
  compactLabel: string
  metric: string
  unit: string
  description: string
  color: string
  secondaryColor: string
  sourceType: 'Derived' | 'Scenario' | 'CBS context + scenario' | 'Official context + scenario'
  legend: Array<{ label: string; color: string }>
}

const serviceLegend = [
  { label: 'Operational', color: '#54d7b0' },
  { label: 'Strained', color: '#d6d45e' },
  { label: 'Degraded', color: '#ffad4d' },
  { label: 'Critical', color: '#ff6577' },
  { label: 'Failed', color: '#8e2d48' },
  { label: 'Recovering', color: '#76b8ff' },
  { label: 'Context / unknown capacity', color: '#a8b7bb' },
]

export const layerDefinitions: LayerDefinition[] = [
  {
    id: 'overview',
    label: 'System overview',
    compactLabel: 'Overview',
    metric: 'Most constrained service',
    unit: 'status',
    description: 'The weakest essential service and active intercity bottlenecks.',
    color: '#8de1cb',
    secondaryColor: '#183e46',
    sourceType: 'Derived',
    legend: serviceLegend,
  },
  {
    id: 'hazard',
    label: 'Hazard forcing',
    compactLabel: 'Hazard',
    metric: 'Scenario severity',
    unit: 'index',
    description: 'Scenario-specific weather, flooding, fire, ground motion or digital disruption.',
    color: '#61d9ff',
    secondaryColor: '#a555dd',
    sourceType: 'Scenario',
    legend: [
      { label: 'Low', color: '#2b6c88' },
      { label: 'Moderate', color: '#5fb7d7' },
      { label: 'Severe', color: '#b56dd8' },
      { label: 'Extreme', color: '#ff5b8c' },
      { label: 'Unsupported / unknown', color: '#7f8c93' },
    ],
  },
  {
    id: 'power',
    label: 'Electricity',
    compactLabel: 'Power',
    metric: 'Service availability',
    unit: '%',
    description: 'National provider territories plus bounded Liander and Stedin asset context over synthetic capacity, backup and restoration.',
    color: '#ffd866',
    secondaryColor: '#664f1b',
    sourceType: 'Official context + scenario',
    legend: serviceLegend,
  },
  {
    id: 'water',
    label: 'Drinking water',
    compactLabel: 'Water',
    metric: 'Service availability',
    unit: '%',
    description: 'Public drinking-water provider territories over synthetic pressure zones, pumping and reserves.',
    color: '#52c8ff',
    secondaryColor: '#164f69',
    sourceType: 'Official context + scenario',
    legend: serviceLegend,
  },
  {
    id: 'drainage',
    label: 'Drainage & surface water',
    compactLabel: 'Drainage',
    metric: 'Drainage availability',
    unit: '%',
    description: 'Public sewer-area and wastewater context over synthetic drainage capacity.',
    color: '#4dd6bf',
    secondaryColor: '#164e49',
    sourceType: 'Official context + scenario',
    legend: serviceLegend,
  },
  {
    id: 'gas',
    label: 'Gas & heating',
    compactLabel: 'Gas',
    metric: 'Service availability',
    unit: '%',
    description: 'National provider territories, Liander pipes and Stedin replacement-program context over generalized availability; no pressure-flow solver.',
    color: '#ff9d5c',
    secondaryColor: '#613719',
    sourceType: 'Official context + scenario',
    legend: serviceLegend,
  },
  {
    id: 'telecom',
    label: 'Telecom & messaging',
    compactLabel: 'Telecom',
    metric: 'Reachable capacity',
    unit: '%',
    description: 'Public fixed-media territories over synthetic reachability, congestion and backup-power degradation.',
    color: '#bd8cff',
    secondaryColor: '#402764',
    sourceType: 'Official context + scenario',
    legend: serviceLegend,
  },
  {
    id: 'mobility',
    label: 'Roads & mobility',
    compactLabel: 'Mobility',
    metric: 'Accessible capacity',
    unit: '%',
    description: 'Official network, schedule and restriction context over scenario access; gray corridors have unknown causal capacity.',
    color: '#7db4ff',
    secondaryColor: '#263f65',
    sourceType: 'Official context + scenario',
    legend: serviceLegend,
  },
  {
    id: 'facilities',
    label: 'Critical facilities',
    compactLabel: 'Facilities',
    metric: 'Operational capacity',
    unit: '%',
    description: 'Care, emergency and public-service capacity with backup dependencies.',
    color: '#ff7e93',
    secondaryColor: '#632737',
    sourceType: 'Scenario',
    legend: serviceLegend,
  },
  {
    id: 'population',
    label: 'Population & needs',
    compactLabel: 'People',
    metric: 'Modeled residents under service pressure',
    unit: 'people',
    description: 'Equivalent resident count derived from CBS population and simulated service pressure; not identified people.',
    color: '#f5b8ff',
    secondaryColor: '#5b3265',
    sourceType: 'CBS context + scenario',
    legend: [
      { label: 'Low impact', color: '#425461' },
      { label: 'Growing need', color: '#a681aa' },
      { label: 'High impact', color: '#ec7fab' },
      { label: 'Critical need', color: '#ff526f' },
    ],
  },
  {
    id: 'supply',
    label: 'Emergency supply',
    compactLabel: 'Supply',
    metric: 'Delivered / demand',
    unit: '%',
    description: 'Official corridor context over modeled hubs, logistics, demand, reserves and bottlenecks; gray corridors are non-causal.',
    color: '#e7d488',
    secondaryColor: '#594c22',
    sourceType: 'Official context + scenario',
    legend: serviceLegend,
  },
]

export const layerById = Object.fromEntries(
  layerDefinitions.map((layer) => [layer.id, layer]),
) as Record<LayerId, LayerDefinition>

export const scenarioEvents = [
  { step: 0, label: 'Storm arrives', tone: 'hazard' },
  { step: 8, label: 'First outages', tone: 'failure' },
  { step: 24, label: 'Telecom degradation', tone: 'failure' },
  { step: 48, label: 'Common picture', tone: 'decision' },
  { step: 80, label: 'First restoration', tone: 'repair' },
  { step: 128, label: 'Fuel competition', tone: 'decision' },
  { step: 192, label: 'Uneven recovery', tone: 'repair' },
  { step: 264, label: 'Residual pockets', tone: 'repair' },
] as const
