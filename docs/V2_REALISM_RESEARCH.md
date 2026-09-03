# V2 realism research and implementation record

This document records the source and modeling decisions behind the real-region,
real-transport, multi-hazard version. It is an exploration tool, not an incident
command system or digital twin.

## Geographic hierarchy

The simulator now uses one coherent 2025 CBS snapshot:

```text
Netherlands → municipality (GM) → wijk (WK) → buurt (BU)
```

- 342 municipality polygons and official label points.
- 3,423 wijken and 14,729 buurten.
- Real buurt polygons are the local simulation cells. Their population is
  reconciled to the municipal total before resource allocation.
- BAG woonplaatsen supply official named-place boundaries. A woonplaats is a
  municipally designated address area; it must not be described as a built-up
  town footprint without another source.
- BRT TOP10NL supplies that complementary physical-place view: 6,478 retained
  woonkern, deelkern, gehucht and buurtschap polygons, partitioned into 342
  lazy municipality files. Assignment uses an interior point against the exact
  2025 municipality geometry, with full CBS buurt geometry as the boundary
  fallback; it does not infer a municipality from a nearest centroid.
- Every municipality has a lazy-loaded JSON bundle, so opening Eindhoven loads
  its 116 buurten instead of downloading the national buurt layer.
- The bundle contains 36 CBS fields covering demography, households, housing,
  mobility, accessibility and area. The broader 40-field operational catalogue
  is in `REGIONAL_STATISTICS.md`.
- CBS negative missing/suppression sentinels are normalized to `null`.

Sources: [CBS wijk- en buurtkaart](https://www.cbs.nl/nl-nl/dossier/nederland-regionaal/geografische-data/wijk-en-buurtkaart),
[CBS/PDOK 2025 collections](https://api.pdok.nl/cbs/wijken-en-buurten-2025/ogc/v1/collections?f=html),
[BAG OGC API](https://api.pdok.nl/kadaster/bag/ogc/v2/api?f=html),
[BRT TOP10NL collections](https://api.pdok.nl/kadaster/brt-top10nl/ogc/v1/collections?f=html).

The separate 2026 wijk/buurt release was deliberately not mixed into this
snapshot: it is currently geometry-only “version 0”, while complete regional
statistics are from 2025.

## Roads and municipality topology

The map and model use two different RWS products for their intended purposes:

- NWB-Light: 573 generalized A/N route geometries for a fast national display.
- Full NWB road segments: build-time topology only. Junction IDs (`jte_id_beg`
  and `jte_id_end`) identify real connections and preserve grade separation.

The build selected 54,156 major road sections (FRC 0–2 and A/N routes) and found
1,124 cross-municipality connections covering 334 municipalities. These contain
626 unique municipality pairs and 498 additional parallel routes, so redundancy
such as separate A2/A50/A58/A67 connections is not erased. The eight
municipalities without a qualifying major-road boundary connection remain
unconnected rather than receiving a fabricated nearest-neighbor edge.

The browser draws exact route geometry. A dynamic path reverses its complete
coordinate array when flow reverses; it never collapses to a straight centroid
line.

Logical routes retain every contributing NWB section ID and, where supplied,
the signed road number, administrative road number and road-part class. These
fields are provenance rather than measured throughput. An Eindhoven audit, for
example, identified sections 325158020 and 326158032 as A2/RW2 access ramps
(`OPR`); they are folded into the existing A2 municipal crossing instead of
becoming a third `002` edge with additive scenario capacity. A2 and the parallel
N2 remain separate because NWB supports both physical designations. The same
non-additivity rule collapses N307, Markermeerdijk and Markerwaarddijk source
fragments on the single Enkhuizen–Lelystad Houtribdijk into one `NWB-road-307`
edge; all eight source sections and their `HR`/`PAR`/`RB` classes remain
traceable without granting three separate ceilings.

Sources: [NWB OGC API schema](https://api.pdok.nl/rws/nationaal-wegenbestand-wegen/ogc/v1/collections/wegvakken/schema?f=html),
[RWS open-data catalogue](https://data.overheid.nl/dataset/14767-nwb---wegen),
[NWB-Light 2026-08](https://downloads.rijkswaterstaatdata.nl/nwb-wegen/geogegevens/shapefile/NWB-light/01-08-2026.zip).

## Public transport

- 615 physical ProRail trace lines and 424 in-country station points are loaded
  as official CC0 infrastructure context.
- The current national OVapi GTFS feed is preprocessed rather than shipped raw:
  7,982 bus, 559 tram/metro, 237 scheduled rail and 27 ferry geometries.
- 7.17 million input shape points become 378,545 simplified points. Duplicate
  physical paths are merged while route/operator metadata and scheduled-trip
  counts are retained.
- Bus detail starts at city zoom; rail and ferry geometry appear earlier.
- Municipality audits add the Kessel–Reuver and Bergen–Vierlingsbeek vehicle ferries from exact public BGT/NWB geometry; Broekhuizen–Arcen, Lottum–Lomm and Velden–Grubbenvorst from exact BRT TOP10NL mixed-traffic ferry features plus operator identity, loading limits and schedules; Capelle–Krimpen's N210/Algerabrug from NWB sections 198273080/198273045 plus the Province of Zuid-Holland corridor agreement; Leiden–Leiderdorp's Lage Rijndijk/Spanjaardsbrug from an exact NWB centreline chain plus the municipality's dated modal restriction; Lingewaard's internal Rijndijk closure from NWB sections 389272008/391270006 plus the municipality's dated N838 detour; and Goirle–Tilburg's N630/Turnhoutsebaan crossing from NWB sections 600770839/262187028 plus the municipality's route evidence. They enter only the Mobility and Supply maps. Tonnes and vehicle-weight limits are physical context, not observed throughput. The three ferry operator pages reported temporary outages when retrieved 3 September 2026, but lack issue/expiry times, a stable API and update cadence, so those observations remain explicitly context-only and cannot alter an unbound first-72-hour run. The current Algerabrug maintenance notice is attached only to its exact audited N210 edge and explicit 10 August–7 September 2026 interval. Ordinary motor traffic, controlled emergency passage, a temporary active-mode bridge, Waterbus mitigation and high-shipping state remain separate; without vehicle mix or throughput they are non-numeric context. The 17 August–11 September 2026 Spanjaardsbrug notice likewise keeps cars/buses separate from emergency, cycle and moped passage; its gray local crossing has Unknown capacity and is excluded from causal transfers. The N280 Kelperbrug restriction is attached only to NWB sections 600948347/366121023 and separates heavy/agricultural/non-scheduled bus traffic from scheduled public transport and emergency services; absent an end date or vehicle mix it stops at retrieval and cannot numerically reduce the generalized edge. The 24 August–2 October Rijndijk record is shown on its exact internal segment with Unknown capacity and no causal transfer; N838 throughput and empty NDW remain Unknown. Lisse's A44/Lisserweg notice is lifecycle context only because the graph lacks the exact underpass asset: the date-only 6 September reopening remains planned until confirmed and is never silently converted to open. The N216 Schoonhoven–Gelkenes NWB sections retain their VDA class and now form one typed ferry corridor rather than an invented 150-unit road. The operator's 05:00–00:00 schedule and ability to carry traffic through heavy freight establish identity and recurring context only; scenario-time sailing, queue, priority and throughput remain Unknown, `capacitySemantics=unknown`, and `affectsSimulation=false`. Belgian N12/A58 continuation and every other unbound live state remain Unknown until compatible valid-time evidence and a scenario-clock rule are available.

The feed is NDOV/operator-derived but aggregated by OVapi on a best-effort basis.
It is reference schedule geometry, not real-time vehicle state or an SLA.

Sources: [ProRail Spoorwegen](https://data.overheid.nl/dataset/83936-spoorwegen),
[OVapi feed README](https://gtfs.ovapi.nl/README),
[NDOV Loket](https://www2.ndovloket.nl/).

## Public telecom context

The Telecom map lazy-loads a deployment snapshot of the statutory RDI Antenneregister WFS. The
current normalized file contains 32,270 exact installation sites representing 67,508 registered
antennas: 15,226 sites include mobile communication and 7,848 include fixed links, with broadcast,
other-mobile and radio-amateur registrations retained separately. Exact source IDs and RD
coordinates are deduplicated, transformed from EPSG:28992 to WGS84, and assigned by containment
against the same CBS 2025 municipality snapshot; 217 points outside a municipality polygon remain
unassigned rather than being nearest-forced.

The register is authoritative location/use context, not a coverage model. It provides no safe basis
for operator ownership, backhaul, capacity, traffic, congestion, power/backup, damage, availability
or restoration. The WFS capabilities say fees and access constraints are `none`, but do not state a
reuse-licence version or fixed refresh cadence, so both remain visibly unspecified and the adapter
refreshes only at deployment.

Sources: [RDI Antenneregister rules](https://www.rdi.nl/onderwerpen/telecommunicatie/telecommunicatiewet/regels-antenneregister),
[public Antenneregister](https://antenneregister.nl/).

## Public external-safety context

The Hazard map requests the public Register Externe Veiligheidsrisico's quick-scan activity and
fire/explosion/toxic-cloud attention-area WMS layers directly from Rijkswaterstaat. The Gas map
uses the register's hazardous-substance pipeline-reference layer, and Mobility/Supply use its
Basisnet activity-location layer. The four overlays are visible only on their relevant map modes
and never feed a simulated failure or impact.

The WMS is a public, current register view, but its capabilities do not publish a fixed refresh
cadence, per-feature observation time or reuse-licence version. All three remain explicitly
unknown. A registered activity or attention area is not evidence of a current incident, release,
plume, probability, shipment, closure, damage, pressure, flow or availability. The separate PDOK
INSPIRE Seveso subset is monthly and CC0, and is a candidate for a later versioned analytical
snapshot when object-level joins are required.

Sources: [REV map services](https://www.registerexterneveiligheid.nl/kaartbeelden),
[PDOK monthly Seveso subset](https://api.pdok.nl/rws/productie-en-industrie-productie-installaties/ogc/v1?f=html).

## Official national cloudburst-depth context

Pluvial and matching compound Hazard views request Rijkswaterstaat's public Climate Impact Atlas
WMS for modeled inundation depth after a 70 mm rainfall event in two hours. The national raster's
publisher legend is retained: 0–10, 10–15, 15–20, 20–30 and over 30 centimetres. The catalogue was
updated 5 August 2026 and offers the WMS, WCS and GeoTIFF under CC0.

This is an `official-scenario` context layer, not an `observed-live` feed. It is not evidence that
70 mm has fallen, a forecast that it will, a selected emergency, a municipality's finer stress
test, or a scenario-clock/T+72 depth surface. It therefore has no causal connection to the current
synthetic flood forcing. Transparent or missing raster coverage remains Unknown rather than being
interpreted as dry or safe. A later causal adapter must pin the event definition and edition,
retain native resolution/units/NoData, perform polygon-aware aggregation, and validate against
municipal and water-board products.

Source: [Rijkswaterstaat Klimaateffectatlas 70 mm/2 h dataset](https://data.overheid.nl/dataset/3d9640b8-a6ae-449c-88dd-0ab186094fae).

## Official ground-elevation context

Flood Hazard views add the Rijkswaterstaat/PDOK AHN4 DTM as a live WMS raster from city zoom
onward. AHN4 provides 0.5 m ground elevation under CC0, acquired during 2020–2022; its catalogue
was updated 23 July 2025. The DTM filters points classified as buildings, trees, bridges, water and
other non-ground objects, then rasterizes the retained terrain with squared-IDW interpolation.

The layer is static `official-context`. It is not a current observation, water level, flood depth,
hydraulic connection, flow direction, dry-floor elevation, road-passability decision or event
state, and it has `affectsSimulation=false`. A missing pixel remains Unknown. A future causal
terrain adapter must retain native units/resolution/NoData and combine elevation only with a named
hydraulic or rainfall scenario, defensible barriers/drainage, and validation against local stress
tests.

Sources: [Rijkswaterstaat AHN DTM catalogue](https://data.overheid.nl/dataset/47567-actueel-hoogtebestand-nederland--ahn--dtm),
[PDOK AHN service documentation](https://www.pdok.nl/ogc-webservices/-/article/actueel-hoogtebestand-nederland-ahn3).

## Public water-level and discharge observations

Water and relevant river/coastal Hazard views lazy-load a deployment snapshot from Rijkswaterstaat
Waterinfo's public latest-measurement endpoints. The current fixture contains 310 water-level and 65
discharge observations. Every point retains its timestamp, unit, NAP/MSL datum where supplied,
publisher class, possible-fault flag and computed age at retrieval. Of the current records, 366 were
at most 90 minutes old, one was delayed and eight were stale; eight carried the publisher's
`possiblyFaulty` flag. Stale or flagged values receive warning rings instead of being deleted.

LMW measurements are generally produced every ten minutes and the public endpoint advertises a
five-minute response cache, but an individual station's latest value can be much older. Waterinfo is
explicitly not a mission-critical service. Content/data reuse is CC0 unless a component states an
exception. These points remain observed context: they do not establish a continuous hydraulic
surface, threshold away from the station, defence failure, inundation depth, scenario-time forecast
or operating instruction. Ninety-two observations outside CBS municipality polygons—principally
offshore/boundary locations—remain unassigned, and a municipality without a point is never assigned
zero water or a safe condition.

Sources: [Rijkswaterstaat Waterinfo](https://waterinfo.rws.nl/),
[water-data overview](https://www.rijkswaterstaat.nl/water/waterdata),
[LMW measurement cadence and parameters](https://waterinfo-extra.rws.nl/monitoring/waterkwantiteit/),
[reuse terms and service disclaimer](https://waterinfo-extra.rws.nl/monitoring/gebruik-data/).

## Public air-quality observation context

Wildfire/smoke Hazard views lazy-load a deployment-cached RIVM Luchtmeetnet point snapshot. The
adapter joins the current station metadata export to each station's latest PM2.5 measurement in a
six-hour request window, retaining PM10, NO2, ozone and SO2 when the same station reports them. The
current fixture contains 72 PM2.5 stations assigned by containment to 44 CBS municipalities; all
other municipalities remain outside the mapped-station coverage rather than receiving a zero.

Current Luchtmeetnet values are indicative, may be revised and are not the finalized accredited
annual dataset. Network delivery timing varies, and the service states no standard reuse licence
while warning that no rights may be derived. Therefore the points are observed context only: they
are not interpolated into a national surface and cannot be interpreted as population exposure,
smoke source attribution, a plume footprint, a forecast, or a value aligned to the simulator's
scenario clock. They have `affectsSimulation=false`.

Sources: [RIVM Luchtmeetnet data portal](https://data.rivm.nl/data/luchtmeetnet/),
[open API](https://api.luchtmeetnet.nl/open_api),
[service portal](https://www.luchtmeetnet.nl/).

## Public seismic-event observation context

Earthquake Hazard views lazy-load a deployment-cached KNMI RDSA FDSN Event snapshot. The current
fixture queries the Netherlands bounding box for the preceding 365 days and retains 63 earthquake
or induced/triggered-event origin points: 32 classified as earthquakes and 31 as induced or
triggered events. Forty-one points fall inside a generalized CBS 2025 municipality polygon and 22
border, offshore or cross-border points remain unassigned. The ingest excludes 6 controlled
explosions, 4 quarry blasts and 1 sonic boom rather than presenting them as earthquakes.

Every mapped point preserves the stable event ID, normalized UTC origin time plus the publisher's
time string, magnitude and magnitude type, depth, named location, contributor, review status and
evaluation mode. The source response byte count and SHA-256 checksum, retrieval time, query bounds
and observation window remain in the generated file. KNMI says the event catalogue updates when
events are published; the RDSA default is CC BY 4.0 where a dataset does not state other terms.

These records are `observed-context` with `affectsSimulation=false`. An origin point is not a
ShakeMap, ground-motion or felt-intensity surface, building/lifeline damage observation,
probability, forecast, or T+72 scenario input; preliminary source parameters can be revised. A
municipality with no assigned point has no catalogued origin in this particular window, not zero
seismic hazard or proof of safety. A later causal earthquake model must bind an explicitly selected
event or scenario to event-specific strong-motion data and validated local exposure/fragility.

Sources: [KNMI RDSA portal](https://rdsa.knmi.nl/),
[FDSN Event service](https://rdsa.knmi.nl/fdsnws/event/1/).

## Public combustible nature-area context

Wildfire Hazard views request IPO/Risicokaart's public WMS polygons for forest, heath and dune
areas where a nature fire can arise. Data.overheid lists the product as Public Domain and records a
metadata update of 19 February 2026. The inspected metadata does not state a guaranteed operational
feature-refresh cadence or positional/source scale, so neither is invented in the interface.

The polygons are `official-context` and have `affectsSimulation=false`. They can support later fuel-
eligibility screening, but they are not a current ignition, fuel type or moisture value, incident
perimeter, spread or smoke forecast, evacuation zone, access condition, extinguishing-water state
or response status. Absence from the public polygon layer remains Unknown rather than proving an
area non-combustible or safe.

Source: [IPO/Risicokaart Natuurbranden WMS/WFS](https://data.overheid.nl/dataset/13235-natuurbranden).

## Official agricultural parcel context

Heat/drought and wildfire Hazard views plus the Supply map request RVO's Basisregistratie
Gewaspercelen WMS through PDOK at city scale. The current queryable WFS records identify the 2025
fixture as definitive and expose crop category, crop name/code, year and status. Parcel users draw
the crop they use on each parcel annually; the product creates a dataset for the 15 May reference
date. Its metadata was revised 15 May 2026 and says Public Domain Mark 1.0, while the current WMS
capabilities advertise CC0. Both source statements remain visible rather than being normalized to
an invented single licence provenance.

The layer is `official-context` and has `affectsSimulation=false`. An annual declaration is not a
current observation of crop presence, growth, moisture, combustible fuel, harvest, yield, food or
fodder stock, farm occupancy, road access, damage or emergency supply. It also is not a forecast.
Transparent or absent geometry means no mapped declaration in this edition, never proof that land
has no agricultural use, food value or hazard exposure. A later causal adapter needs a declared
event and valid-time drought/fire/weather input, publisher-qualified crop-condition or yield data,
source units/uncertainty, and an explicit conversion to exposure—not a direct parcel-to-impact rule.

Sources: [PDOK BRP service documentation](https://www.pdok.nl/ogc-webservices/-/article/basisregistratie-gewaspercelen-brp-),
[WMS capabilities](https://service.pdok.nl/rvo/gewaspercelen/wms/v1_0?request=GetCapabilities&service=WMS).

## Official inland-waterway network context

Mobility and Supply views request Rijkswaterstaat's live FIS-VNDS ArcGIS rendering for fairway
lines (layer 55) and, at their publisher-defined city scale, registered bridge and lock points
(layers 3 and 19). The fairway catalogue was updated 15 April 2026 and is published under CC0.
The underlying layer exposes fairway identity, name, direction, route kilometres and CEMT class;
bridge and lock records expose register characteristics. The current live service returned 3,375
fairway features, 6,946 bridge records and 633 lock records when reviewed on 2 September 2026,
but those counts are observations of the service catalogue and are not frozen operational totals.

The overlay is `official-context` and has `affectsSimulation=false`. Geometry, a registered object
or a published CEMT class does not establish current navigability, minimum usable depth, a notice,
open/closed state, remote-control availability, queue, vessel throughput, damage or scenario-time
capacity. In particular, the separate FIS `vaarwegstatus` records observed during review use role
codes such as `HR`, `AR`, `AANT` and `VERB` (main route, alternative route, branch and connection);
that field must not be relabelled as an operational restriction. Transparent or missing coverage
remains Unknown. A later operational adapter must ingest Notices to Skippers with stable identity,
location/affected reach, issue/valid/expiry times, restriction semantics, update/cancellation state,
licence and observation/replay clock alignment; it must never extrapolate a current notice through
the arbitrary T+72 scenario horizon.

Sources: [RWS FIS-VNDS Fairway catalogue](https://data.overheid.nl/dataset/42643-fis-vnds---fairway---lijnen),
[FIS-VNDS ArcGIS MapServer](https://geo.rijkswaterstaat.nl/arcgis/rest/services/GDR/fis_vnds/MapServer).

## Official groundwater-monitoring registration context

The city-scale Water, Drainage and water/drought-related Hazard views request the CC0 TNO/BRO
groundwater-monitoring WMS through PDOK. The rendered layers are `gm_gmw`
(groundwater-monitoring wells) and `gm_gld` (groundwater-level-investigation registrations). The
service capabilities explicitly support EPSG:3857, so MapLibre can request native web-map tiles
without a client-side coordinate conversion.

This dataset contains the characteristic summary of BRO registrations and their relationships,
not the full registered object contents. A well or investigation marker is therefore
`official-context`: it is not a current groundwater level, a continuous interpolated surface, a
threshold exceedance, a flood/drought event, a forecast or a causal T+72 input. The WMS declares
CC0 but no per-feature observation timestamp or guaranteed measurement cadence. Transparent or
missing geometry stays Unknown rather than dry or safe.

The next causal integration step is deliberately separate: retrieve selected GLD time series from
the public BRO REST/Atom services, retain observation time, quality flags, monitoring-tube and
vertical-reference semantics, then bind an explicitly chosen series to a scenario start. The
official REST guidance describes machine-to-machine access and rate limits (three GLD requests per
second), so national bulk acquisition should use Atom instead of scraping the incidental REST
endpoint.

Sources: [PDOK groundwater-monitoring WMS](https://www.pdok.nl/ogc-webservices/-/article/bro-grondwatermonitoring-gm-in-samenhang-karakteristieken),
[BRO public REST services](https://www.bro-productomgeving.nl/bpo/release-2.9_2025_Q4/informatie-voor-softwareleveranciers/url-s-publieke-rest-services).

## National electricity-capacity planning samples

Netbeheer Nederland's current capacity map supplies public service-area lookup and detail JSON in
addition to its interactive vector map. A deployment refresh now selects one public DUO education
postcode per CBS municipality and resolves 339 of 342 municipalities to 250 distinct service
areas. It retains regional operator, present/required transport capacity, queue count and MW,
TenneT constraint class and summarized expansion-project timing. The three unmatched samples stay
Unknown. Every point identifies the lookup location only; it is not a transformer, station, cable,
customer connection or complete municipality boundary.

This is intentionally a planning overlay. Netbeheer Nederland describes capacity/project data as
at least quarterly and queue data as monthly, and calls the consolidated capacity-map product open
data. Its public frontend endpoints have no documented stability contract and the exact dataset
licence identifier is not stated. The interactive vector tiles use an origin-restricted client key,
so they are not reused here. A separate official NBNL design explicitly classifies detailed
topology, station geolocation, operational limit and load as closed, consent/use-case data because
of security and commercial-sensitivity concerns. None of the sampled values can therefore be
interpreted as current supply availability, an outage, switching state, emergency reserve,
restoration progress or a future T+72 condition.

Sources: [Netbeheer Nederland capacity map](https://www.netbeheernederland.nl/netcapaciteit-en-flexibiliteit/capaciteitskaart),
[capacity-map solution design](https://modellen.netbeheernederland.nl/solution-designs/capaciteitskaart.html),
[topology/load/capacity solution design](https://modellen.netbeheernederland.nl/solution-designs/nettopologie-belasting-capaciteit.html).

## Multi-hazard model

The ten presets are severe storm, pluvial flood, river flood, coastal flood,
heatwave/drought, winter storm, cyberattack, earthquake, wildfire/smoke and a
compound storm/flood/cyber cascade.

Each requested quarter-hour frame is deterministic. Hazard mechanisms remain
separate rather than mapping one generic severity value onto all systems:

- wind/rain/flood affect different service fragilities;
- heat changes temperature, cooling/water demand and facility stress;
- winter changes temperature, heating demand, snow/ice mobility and access;
- wildfire separates fire and smoke exposure;
- earthquakes are localized around the north-Netherlands epicentral pattern;
- cyber disruption creates no physical rainfall or floodwater and acts most
  strongly on digital/control dependencies;
- compound loss combines declared components without exceeding bounds.

Preparedness reduces direct loss and extends backup endurance. Response delay,
event duration and safe-repair timing control restoration. Power constrains
water, drainage, telecom, gas controls and facilities; mobility constrains
emergency supply. Every transfer remains capacity-bounded and conservative.

## Climate and comparison controls

The UI exposes season; KNMI’23 path (`Ld`, `Ln`, `Md`, `Mn`, `Hd`, `Hn`);
horizon; intensity; duration; preparedness; and response delay. Reference means
the 1991–2020 climate. A/B comparison holds the event and response fixed while
changing season, allowing a direct winter-versus-summer result at the same
timeline step.

The current model applies explicit path/season/horizon temperature,
extreme-precipitation and sea-level transforms. These are sensitivity inputs,
not probabilities. Average wind is not arbitrarily multiplied by climate.

Sources: [KNMI’23 data portal](https://klimaatscenarios-data.knmi.nl/kerncijfers),
[KNMI scenario guidance](https://www.knmi.nl/kennis-en-datacentrum/achtergrond/knmi-23-klimaatscenario-s-voor-gebruikers/),
[KNMI warning explanation](https://www.knmi.nl/kennis-en-datacentrum/uitleg/knmi-waarschuwingen).

## What remains modeled

Road/rail/region geometry can be real while impact calculations are still
assumptions. The following require later calibration or licensed/operator data:

- lane/speed/traffic capacity, live closures and emergency routing;
- official individual LIWO flood scenarios and arrival/depth rasters;
- water, electricity, gas and telecom asset graphs;
- backup fuel, crews, spare parts, RTO/RPO and facility continuity plans;
- actual vehicle capacity and historical seasonal GTFS archives;
- uncertainty intervals and expert validation per safety region.

Sensitive utility assets and person-level vulnerability data should not be
published. Keep those layers aggregated unless the data owner authorizes a
controlled operational deployment.
