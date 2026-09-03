# Public-data integration plan

Status: implementation roadmap, checked 2026-09-03. The product goal is to use the strongest
public, authoritative Dutch data available and to keep observed facts, official scenarios and
model assumptions visibly separate. More data is useful only when its edition, licence, spatial
meaning and time meaning survive the full ingest-to-screen path.

## Evidence classes

Every value or feature must carry one of these classes:

1. `observed-live`: a timestamped measurement or current operational status;
2. `official-forecast`: issued guidance with explicit model/reference, valid and expiry times and
   deterministic, ensemble or probability semantics;
3. `official-scenario`: a named authority-produced stress case, probability surface or projection
   that is not an issued forecast for the exercise time;
4. `official-context`: a static or periodically updated register, boundary or asset catalogue;
5. `derived`: a reproducible transformation of declared public inputs;
6. `synthetic`: an explicit assumption used because suitable public data is unavailable,
   security-sensitive or not licensed for this product;
7. `unknown`: no defensible value. Unknown must never be silently converted to zero.

An observation may initialize a scenario, but it is not automatically a 72-hour forecast. An
official asset location is not evidence that the asset is operational, adequately staffed or able
to supply a stated capacity. A national scenario raster is not street-level truth.

## Source inventory

`Now` means an adapter can be implemented without privileged operator data. `Partner` means that
the public source is useful context, but a calibrated operational model still needs an agreement
with the responsible authority or operator.

| # | Public authority/source | What it can contribute | Simulator maps | Access/freshness | Use |
|---:|---|---|---|---|---|
| 1 | [CBS Kerncijfers wijken en buurten](https://opendata.cbs.nl/#/CBS/nl/dataset/86165NED) | Population, age, household, housing, benefits, business, vehicle and accessibility context | Population, facilities, demand | OData; annual edition | Integrated |
| 2 | [CBS Gebiedsindelingen via PDOK](https://api.pdok.nl/cbs/gebiedsindelingen/ogc/v1/api?f=html) | Municipality, province, safety-region and other official regional identifiers/geometries | All | OGC API; editioned; CC BY 4.0 | Integrated |
| 3 | [BAG via PDOK](https://api.pdok.nl/kadaster/bag/ogc/v2?f=html) | Buildings, addresses, use purposes and named woonplaatsen | Population, facilities, local impact | OGC Features/Tiles; daily; Public Domain Mark 1.0 | Integrated woonplaats polygons plus in-use/renovation building vector tiles at street zoom on Hazard, Population and Facilities; attributes remain non-causal context, not occupancy, fragility or refuge suitability |
| 4 | [BGT via PDOK](https://api.pdok.nl/lv/bgt/ogc/v1?f=html) | Detailed buildings, roads, water, bridges, terrain and selected object classes | Hazard, mobility, facilities | OGC Features/Tiles; daily; CC0 | Integrated as a street-scale background from zoom 17; analytical object intersections remain pending |
| 5 | [BRT TOP10NL via PDOK](https://www.pdok.nl/ogc-apis/-/article/basisregistratie-topografie-brt-topnl) | National land use, hydrography, named settlements and transport context | Hazard, population, mobility | OGC Features/Tiles/download; feature source dates and registration times vary | Settlements integrated; three GM1507–GM0983 mixed-traffic Maas ferry features now provide exact Mobility/Supply lifeline geometry and IDs. A nearby bicycle-only ferry is kept out of the vehicle graph. TOP10NL `in gebruik` is register status, never proof of current operation |
| 6 | [AHN via PDOK](https://www.pdok.nl/ogc-webservices/-/article/actueel-hoogtebestand-nederland-ahn3) | 0.5 m DTM/DSM elevation for low points, dry floors, flow paths and terrain exposure | Flood, mobility, facilities | WMS/WCS/ATOM; AHN4 acquired 2020–2022; CC0 | DTM WMS integrated at city scale as non-causal terrain context; derived indicators pending |
| 7 | [BRO groundwater-monitoring WMS](https://www.pdok.nl/ogc-webservices/-/article/bro-grondwatermonitoring-gm-in-samenhang-karakteristieken) and [public REST services](https://www.bro-productomgeving.nl/bpo/release-2.9_2025_Q4/informatie-voor-softwareleveranciers/url-s-publieke-rest-services) | Groundwater monitoring wells, level-investigation registrations and selected observation series | Drainage, drought, flood | CC0 WMS register characteristics integrated at city scale; REST/XML/Atom observations are record-dependent | WMS integrated as non-causal context; selected GLD series pending |
| 8 | [KNMI Data Platform](https://developer.dataplatform.knmi.nl/open-data-api) | Ten-minute station observations, radar, issued 48-hour warnings, satellite, forecasts and climate files | Weather, flood, heat, winter, fire | File API, EDR, WMS and notifications; anonymous API/WMS quotas are shared; the platform news feed can report partial observation delays | Latest 5-minute radar, 55 European/offshore station records from `10-minute-in-situ-meteorological-observations` v1.0, and province-level `waarschuwingen_nederland_48h` v1.0 are cached as non-causal context. Station variables preserve true zero versus NoData and are never spatially interpolated; structured warning periods retain level, phenomenon and valid time, while a fallback may establish only KNMI's explicit timestamped national “no warnings” state |
| 9 | [KNMI Seamless precipitation ensemble forecast](https://data.overheid.nl/dataset/7fe16baf-b4b4-4ce8-b146-c01a1b77634c) | Five-minute exceedance probabilities on a 1 km grid for six rain-rate thresholds through +6 hours | Storm, pluvial flood | Public WMS; pilot product updated every five minutes; CC BY 4.0; dataset `seamless_precipitation_ensemble_forecast_probabilities` v1.0 | Integrated as deployment-cached probability-of-exceeding-3-mm/h rasters at T+1/T+3/T+6. Reference/valid times, threshold, style, EPSG:3857 request bounds, image hashes and NoData semantics are retained. The map shows radar at T+0 and no Seamless raster after T+6; the product remains non-causal and is never extrapolated to T+72 |
| 10 | [KNMI'23 data portal](https://www.klimaatscenarios-data.knmi.nl/) | Versioned transformed time series and 12 km RACMO ensembles for H/L and wet/dry futures | All weather-driven scenarios | NetCDF/download; versioned scenario data | Now |
| 11 | [KNMI FDSN and ShakeMaps](https://rdsa.knmi.nl/) | Earthquake events, stations, waveforms and strong-motion products | Earthquake | FDSN REST/GeoJSON/NetCDF; event catalogue updates when events are published; RDSA default CC BY 4.0 where dataset terms do not override it | FDSN origin catalogue integrated as a 365-day observed-context snapshot; ShakeMap/ground-motion calibration remains |
| 12 | [Rijkswaterstaat Waterinfo](https://www.rijkswaterstaat.nl/water/waterdata) | Water level, discharge, temperature, waves and wind observations; selected forecasts | River, coast, drought, water | Public map/API; LMW generally 10-minute measurements; rolling forecast-map endpoint is not documented as a stable external API; point coverage differs by quantity and declines by horizon; CC0 unless stated | Latest observations and +1/+6/+12/+24/+48/+72 rolling forecast checkpoints are integrated as distinct, non-causal point context. Forecast response/request/valid times and hashes are retained; a single cycle issue time is unavailable and empty horizons remain NoData |
| 13 | [LIWO](https://iplo.nl/thema/water/applicaties-modellen/berichtgeving-crisismanagement/liwo/) | Named flood scenarios, candidate breach locations, maximum depth, arrival time, duration, velocity, evacuation and infrastructure exposure | River/coastal/regional flood | Public API/WMS deployment currently identifies release 2025.1.6 and dataset `2025_0_1`; scenario/band metadata and exports are event-selected; interpretation requires water-management expertise | Candidate primary/regional/regional-water/outside-dike breach locations integrated at city zoom as non-causal scenario-selection context; causal named-scenario selector pending |
| 14 | [Klimaateffectatlas](https://www.klimaateffectatlas.nl/en/faq) and [RWS 70 mm/2 h depth dataset](https://data.overheid.nl/dataset/3d9640b8-a6ae-449c-88dd-0ab186094fae) | National public rasters for pluvial depth, heat, drought, flood, wind and vulnerability | Hazard and population | GeoTIFF/GeoPackage/WMS; atlas CC BY 4.0, RWS depth layer CC0 | RWS 70 mm/2 h WMS integrated as non-causal official-scenario context; broader calibration pending |
| 15 | [Waterschappen Waterbeheergebieden IMWA](https://api.pdok.nl/hwh/waterschappen-waterbeheergebieden-imwa/ogc/v1/api?f=html) | Drainage/supply areas, level-decision areas and water bodies | Drainage, water, flood | OGC API/WMS; CC BY-SA 4.0; provider-supplied | Integrated drainage/supply and level-area WMS as non-causal context |
| 16 | [Waterschappen water works IMWA](https://api.pdok.nl/hwh/waterschappen-kunstwerken-imwa/ogc/v2/collections/stuw/items?f=html) | Public pumps, weirs, sluices, bridges, culverts and other water-control works | Drainage, mobility | OGC API; source timestamps/manager per feature | Integrated pumps/weirs/sluices as context; point records carry full-resolution CBS 2025 municipality containment or an explicit unassigned state |
| 17 | [Waterschappen Waterketen DAMO](https://api.pdok.nl/hwh/waterschappen-waterketen-damo/ogc/v1/collections/rioolgemaal/schema?f=html) | Wastewater pumps, treatment plants, units, pipes and public design/capacity attributes where supplied | Drainage, water | OGC API/WMS; CC BY-SA 4.0; coverage/completeness varies by water board | Integrated pumps/RWZIs and city-scale pipe WMS as context; municipality assignment is geography only, never catchment connectivity or operation |
| 18 | [Waterschappen Waterketen GWSW](https://api.pdok.nl/rioned/waterschappen-waterketen-gwsw/ogc/v1?f=html) | Complementary public sewer areas, pumps, RWZIs and wastewater links | Drainage, water | OGC API/WMS; CC0; update frequency unspecified | Integrated complementary city-scale pipe WMS; object deduplication still needed |
| 19 | [NWB via PDOK](https://api.pdok.nl/rws/nationaal-wegenbestand-wegen/ogc/v1?f=html) | Named, managed Dutch road geometry and junction topology | Mobility, supply | OGC API; monthly; CC0 | Integrated only for Mobility and explicitly assumed road logistics/Supply; exact section IDs plus signed/admin road identity and road-part class are retained, municipality-border continuations are partitioned by primary physical wegnummer, duplicate parallel provenance fails generation, and road edges are prohibited from substituting for utility/facility topology. The audited Eindhoven A2/RW2 OPR pair is provenance on A2, not a separate `002` edge; Goeree-Overflakkee's eastern crossings display signed A29 while retaining A4/RW4 provenance; N307, Markermeerdijk and Markerwaarddijk fragments on the Enkhuizen–Lelystad Houtribdijk are one audited physical corridor and one capacity ceiling. Goirle's former zero-edge graph now has the exact NWB 600770839/262187028 N630/Turnhoutsebaan boundary crossing to Tilburg; Belgian N12/A58 continuation and live state remain Unknown |
| 20 | [NDW Open Data](https://opendata.ndw.nu/) and [Actueel beeld documentation](https://docs.ndw.nu/producten/situatieberichten-v3/actueel-beeld/) | Speed, intensity, travel time, queues, accidents/incidents, closures, measures, bridge openings and works | Mobility, supply, accessibility; independently toggleable traffic overlay | DATEX II occurrence/current-picture feed; publisher calls the upstream feed real-time but notes supplier records are unvalidated | Integrated through a same-origin server adapter with a 60-second cache and labelled deployment-snapshot fallback. `Accident`, `AbnormalTraffic` and other records are visually distinct; publication and live/stale/fallback state are shown. It remains observed, non-causal context; freshness alarms and validated NWB link matching remain |
| 21 | [ProRail open spoor geometry via PDOK](https://api.pdok.nl/) | Rail traces, stations and infrastructure context | Mobility, supply | OGC API/download; editioned | Integrated geometry |
| 22 | [OVapi national GTFS](https://gtfs.ovapi.nl/README), [Ton Paulus Veerbedrijf](https://www.tonpaulusveerbedrijf.nl/veerdiensten/broekhuizen-arcen) and [Veerdienst Schoonhoven](https://www.veerdienst-schoonhoven.nl/dienstregeling.html) | Scheduled bus, tram, metro, rail and ferry routes; operator-published local ferry identity, recurring hours and physical loading limits | Mobility, supply | GTFS feed-validity window; local operator pages are human-readable and expose no machine issue/expiry time, stable API, update cadence or stated reuse licence | National schedule geometry integrated. Three Horst aan de Maas–Venlo vehicle ferries retain operator limits and a timestamped 3 September 2026 temporary-outage observation as context-only; physical tonnes are never converted to model throughput and the observation never becomes an unbounded T+72 closure. The NWB-VDA N216 Schoonhoven–Gelkenes crossing is now typed as a ferry with its operator timetable retained as context, but Unknown capacity/state and `affectsSimulation=false` |
| 23 | [TenneT API portal](https://developer.tennet.eu/) | National imbalance, balancing activation, metered injection and border capacity | Electricity | API key; market-time intervals | Now for national state, not local outages |
| 24 | [Netbeheer Nederland capacity map](https://www.netbeheernederland.nl/netcapaciteit-en-flexibiliteit/capaciteitskaart) | Open feeder-area congestion, queue and project context | Electricity | Public frontend JSON; published design says open data, capacity/projects at least quarterly and queues monthly; exact dataset licence identifier and endpoint stability are not stated | Integrated as one non-causal public-postcode sample per municipality (339/342 currently resolve); complete area download remains pending |
| 25 | [Netbeheer Nederland service-area/outage sources](https://www.netbeheernederland.nl/veelgestelde-vragen) | Electricity/gas operator areas and current/public historic outage context | Electricity, gas | National links plus operator-specific open data | Now where reuse terms allow |
| 26 | [GTS Dataport / ENTSOG](https://www.gasunietransportservices.nl/netwerk-operations/transparency/dataport) | Transmission entry/exit technical capacity, nominations, allocation, flow and gas quality | Gas/heating | ENTSOG REST/CSV; GTS says flows/nominations update hourly after processing delay; ENTSOG terms require attribution and extraction date, with no standard open-data licence claimed | Integrated latest numeric hourly GTS physical-flow directions as a deployment-cached, non-causal national context card. Numeric zero remains distinct from blank/N/A; provisional virtual, aggregated and physical directions are not summed; map points await a documented geographic coordinate contract |
| 27 | [RDI Antenneregister](https://www.rdi.nl/onderwerpen/telecommunicatie/telecommunicatiewet/regels-antenneregister) | Public antenna installation location and registered use/technology summary | Telecom | Public WFS `ms:Antennes`; refresh cadence and reuse-licence version unstated, capabilities say no fees/access constraints | Integrated as 32,270 deduplicated deployment-snapshot sites; non-causal, never radio coverage or live availability |
| 28 | [RDI municipal coverage measurements](https://www.rdi.nl/onderwerpen/telecommunicatie/telecomaanbieders/dekkingseis-en-snelheidsverplichting) | Source-dated municipal outdoor coverage/speed compliance by mobile operator | Telecom | Published measurement rounds; partial municipality coverage | Now, baseline evidence only |
| 29 | [KVK governmental services via PDOK](https://api.pdok.nl/kvk/overheidsdiensten-geharmoniseerd/ogc/v1/collections/public_order_and_safety?f=html) | Public-order/safety and other governmental-service establishment addresses | Facilities | OGC API; source date exposed; Public Domain Mark 1.0 | Integrated as coarse context |
| 30 | [DUO RIO open education data](https://onderwijsdata.duo.nl/dataset/c416acd1-e083-4ec6-9203-3b20f98fe143) | BAG-linked education locations, active location uses and current statutory branch recognitions across PO/VO/WEC/MBO/VAVO/HO/NFO | Facilities, population, supply | Four joined CSVs via CKAN; daily after approximately 06:15 Europe/Amsterdam; Creative Commons Attribution, version unspecified | Integrated as 12,883 validity-filtered European-Netherlands locations; non-causal, never shelter/occupancy/capacity state |
| 31 | [RIVM 2026 acute-care questionnaire](https://datacatalogus.rivm.nl/dataset.xhtml?persistentId=doi:10.21945/8E767B2D-9CED-4A85-A95D-3AC1A608C663) | SEH and acute-obstetric location/24-hour role, reported rooms and 2025 visits | Facilities, mobility | Version 1.1, published 2026-07-03; 79 locations; CC0 | Integrated as a BAG-geocoded dated fixture; never live incident capacity |
| 32 | [CIBG LRZa](https://www.cibg.nl/lrza) | Public care-provider organization, establishment and care-type context | Facilities | Public register; API/access conditions require review | Partner/terms check |
| 33 | [Register Externe Veiligheidsrisico's](https://www.registerexterneveiligheid.nl/kaartbeelden) and [PDOK's monthly Seveso subset](https://api.pdok.nl/rws/productie-en-industrie-productie-installaties/ogc/v1?f=html) | Regulated activities; fire, explosion and toxic-cloud attention areas; hazardous-substance pipelines; Basisnet locations | Hazard, gas, mobility, supply | Live public REV WMS; its fixed cadence, feature time and reuse-licence version are unstated. PDOK subset is monthly CC0 | Integrated as four scale-aware WMS overlays; non-causal register context, never an incident, plume, shipment, outage or effect |
| 34 | [RIVM Luchtmeetnet open files](https://data.rivm.nl/data/luchtmeetnet/) and [open API](https://api.luchtmeetnet.nl/open_api) | PM2.5, PM10, ozone, NOx and other measured air-quality time series plus station metadata | Smoke, industrial release, population | Hourly station measurements; current values are indicative and revisable; network delivery timing varies; no standard reuse licence stated | Integrated as a six-hour deployment snapshot of latest PM2.5 station observations on wildfire/smoke Hazard; non-causal and never interpolated into false national coverage |
| 35 | [RVO Basisregistratie Gewaspercelen](https://www.pdok.nl/ogc-webservices/-/article/basisregistratie-gewaspercelen-brp-) | Annual crop declarations and agricultural parcel geometry for fire/drought/economic context | Wildfire, drought, supply | WMS/WFS/Atom; 2025 definitive annual 15 May snapshot, metadata revised 2026-05-15; dataset metadata Public Domain Mark 1.0 and WMS capabilities CC0 | Integrated at city scale as non-causal context; crop condition/yield/stock calibration remains |
| 36 | [RWS FIS-VNDS Fairway and Vaarweginformatie](https://data.overheid.nl/dataset/42643-fis-vnds---fairway---lijnen) | Fairway identity/geometry, bridges, locks; separately, timestamped Notices to Skippers | Mobility, supply | CC0 ArcGIS/WMS/WFS register, catalogue updated 2026-04-15; operational notices use separate products | Static fairway/bridge/lock context integrated; machine-readable NtS restriction adapter remains |
| 37 | [Liander Open Data electricity geometry](https://www.liander.nl/over-ons/open-data) | High-, medium- and low-voltage cables and stations in Liander territory | Electricity | ArcGIS Feature Service queried live; CC BY 4.0; fixed refresh cadence unstated | Integrated as bounded official context |
| 38 | [Liander Open Data gas geometry](https://www.liander.nl/over-ons/open-data) | Distribution-pipe geometry and installation date where supplied in Liander territory | Gas/heating | ArcGIS Feature Service queried live; CC BY 4.0; explicitly limited dataset | Integrated at street scale as bounded official context |
| 39 | [Stichting Mijn Aansluiting provider areas](https://wiki.service.mijnaansluiting.nl/wiki/spaces/Wiki/pages/693731329) | Responsible-provider territories for electricity, gas, drinking water, sewer, heat and fixed media | Electricity, gas, water, drainage, telecom | Live WMS/WFS; Public Domain catalogue; provider-specific record timestamps and overlapping/partial disciplines | Integrated as map overlays and selected-point provider lookup; never topology or telemetry |
| 40 | [Rijkswaterstaat ROR risk areas and HWH/PDOK Keringen IMWA](https://api.pdok.nl/rws/overstromingen-risicogebied/ogc/v1?f=html) | Significant flood-risk screening areas and current provider-supplied water-defence geometry | River/coastal hazard | Risk areas are from the 2018 report / ROR second cycle 2016–2021, CC0, update not planned; Keringen IMWA is CC BY-SA 4.0 | Integrated map context; stale-cycle warning is visible; never a breach/depth scenario or assumed defence performance |
| 41 | [IPO/Risicokaart combustible nature areas](https://data.overheid.nl/dataset/13235-natuurbranden) | Forest, heath and dune polygons where a nature fire can arise | Wildfire hazard | Public WMS/WFS; Public Domain; metadata updated 19 February 2026; fixed feature cadence/scale not stated | Integrated as non-causal eligibility context; never ignition, fuel state, perimeter, spread or response |
| 42 | [Stedin Open Data electricity geometry and gas replacement](https://www.stedin.net/zakelijk/open-data/liggingsdata-kabels-en-leidingen) | High-, medium- and low-voltage lines plus the gas-replacement programme in Stedin territory | Electricity, gas/heating | Public ArcGIS Feature Service; service metadata says July 2026 and annual publication; free-reuse statement but no standard licence identifier | Integrated through bounded visible-extent queries; non-causal, and gas replacement is not complete gas geometry |
| 43 | [Enexis Open Data](https://www.enexis.nl/over-ons/waar-staan-wij-voor/open-data) | Current aggregate consumption/generation/congestion-profile products; historically documented electricity/gas asset geometry | Electricity, gas/heating | Rechecked 3 September 2026: Enexis says all directly available datasets are on the current page, which no longer lists asset geometry; it directs other requests to Partners in Energie. The government catalogue's 2023 CC0 asset ZIP links now return 404/unresolved host, and the former WMS/WFS host is unavailable | Partner/data-request route for a current licensed edition; stale catalogue metadata and dead legacy services are quarantined, never presented as current lines or absence |
| 44 | [Energieonderbrekingen.nl API v2](https://energieonderbrekingen.nl/api/v2/) | Joint Enexis/Liander/Stedin electricity and gas disruptions: provider, network, planned/actual/expected period, status, cause, estimated households and public location geometry | Electricity, gas/heating | OAS 3.0 JSON feed; GET disruptions requires OAuth client credentials with `read:disruptions`; website says cost-free access after operator agreement; data can be incomplete | Highest-priority partner adapter; no credential means Unknown, never no outage |
| 45 | [Liander transport forecasts and realised load](https://www.liander.nl/over-ons/open-data) | Quarter-hour day-ahead and realised electricity transport by published area/deelnet | Electricity | Public CSV; page says nightly refresh and rolling seven days, but the 3 September 2026 review found files last modified 2 June 2026 and values inconsistent with the stated MW header | Quality quarantine pending publisher-confirmed freshness, units and reuse contract; never silently rescale |
| 46 | [Rijkswaterstaat N3 Papendrechtsebrug project notice](https://www.rijkswaterstaat.nl/wegen/projectenoverzicht/n3-renovatie-beweegbare-deel-papendrechtsebrug) | Named closure of the N3 road crossing between Dordrecht and Papendrecht | Mobility, road logistics/supply | Human-readable official plan; closed both directions 17 July 2026–21 April 2027; update cadence and machine-data licence unstated | Integrated as a sourced route restriction only for an explicitly overlapping exercise reference date; outside the interval or without a date it makes no open/closed claim, and temporary alternatives retain Unknown capacity |
| 47 | [Rijkswaterstaat A27 Merwedebrug current status](https://www.rijkswaterstaat.nl/wegen/wegenoverzicht/a27/merwedebrug) | Vehicle-class restriction between Gorinchem and Altena plus published heavy-traffic detours | Mobility, road logistics/supply | Human-readable official current-status page; trucks/touring coaches restricted since 18 July 2026 while cars, scheduled buses and emergency services remain allowed; event-driven cadence, no published end date or machine-data licence | Integrated through exact A27/NWB route provenance as validity-bounded official context. It never removes the whole edge or invents a capacity percentage; the evidence interval stops on retrieval day, later state is Unknown, and a numeric freight effect awaits vehicle-mix/throughput calibration |
| 48 | [Provincie Zuid-Holland 2025 Liander and Stedin electricity-station layers](https://opendata.zuid-holland.nl/geonetwork/srv/dut/catalog.search#/metadata/b9a933f4-ab25-46e2-a7e4-afb73f1039b9) | Published electricity-station point locations within Zuid-Holland | Electricity | Live official WMS; 2025 data edition, created/published 2026-06-24, metadata updated 2026-08-13; Public Domain Mark 1.0; province-scoped and split into Liander/Stedin layers | Integrated as a Power-map raster from zoom 7. It is non-causal atlas context only: no connected topology, voltage, load, switching, capacity, outage, damage, backup or restoration inference; outside-province and empty tiles remain out-of-scope/NoData, never no station |
| 49 | [RIVM overhead high-voltage lines with calculation distances](https://data.overheid.nl/dataset/83491-bovengrondse-hoogspanningslijnen-met-rekenafstanden) | National overhead high-voltage line geometry and published voltage/class styling | Electricity | Public WMS/WFS; 12,348 WFS line records; capabilities explicitly describe the November 2023 situation, dataset issued 2024-08-20, catalogue metadata refreshed 2026-08-19; Public Domain Mark 1.0 | Integrated nationally on Power from zoom 5 as dated, non-causal register context. It covers overhead lines only and supplies no connected bus topology, ownership, switching, load, outage, damage, capacity, protection or restoration state; a recent catalogue timestamp never upgrades the underlying 2023 actuality |
| 50 | [KNMI HARMONIE-AROME Cy43 EPS Netherlands](https://english.knmidata.nl/open-data/harmonie) | Operational ensemble grids for near-surface meteorological parameters at hourly output frequency | Weather forcing, flood, heat, winter, wildfire/smoke and weather-driven lifeline fragility | Open Data file API; dataset `harmonie_arome_cy43_p2a` v1.0; forecast leads +00/+1 through +60; only the last 72 hours of files are retained; CC BY 4.0 | Priority short-range gridded backbone, not a full 72-hour source. Five-member batches are staggered hourly and a coherent 30-member construction has about 54 common forecast hours. Ingest selectively and preserve cycle, batch/member/statistic, parameter, level, unit, grid/CRS, lead, file hash and NoData. T+60–T+72 requires another compatible source or remains Unknown |
| 51 | [KNMI six-day outlook](https://data.overheid.nl/en/dataset/938d3cde-7ed4-4876-99e1-c9cdf5b9a1ed) | Meteorologist-issued national outlook in HTML/TXT/XML for the coming six days | Hazard evidence and briefing context | Open Data file API; dataset `outlook_weather_forecast` v1.0; daily; CC BY 4.0 | Candidate non-causal narrative context for the late horizon. It is national text rather than a gridded municipal field and cannot fill HARMONIE's T+60–T+72 map gap, initialize local forcing or be numerically blended without an explicit interpretation contract |
| 52 | [Gemeente Leiderdorp Spanjaardsbrug notice](https://www.leiderdorp.nl/inwoner/nieuws/artikel/spanjaardsbrug-dicht-voor-autoverkeer-tot-en-met-11-september) | Dated Lage Rijndijk/Spanjaardsbrug car-and-bus closure, signed detour, emergency/cycle/moped exception and direction-specific Baanderij access | Mobility, road logistics/supply | Human-readable official notice; valid 17 August–11 September 2026; event-driven cadence and machine-data licence unstated | Integrated on an exact NWB Leiden–Leiderdorp centreline chain as gray, validity-bounded context. No traffic mix, direction geometry or detour throughput is invented: `capacitySemantics=unknown`, `affectsSimulation=false`, absence or expiry never proves open, and the route remains excluded from causal transfers |
| 53 | [Rijkswaterstaat N280 Kelperbrug restriction](https://www.rijkswaterstaat.nl/nieuws/archief/2026/06/n280-vrachtwagens-landbouwvoertuigen-en-bussen-niet-meer-toegestaan-op-kelperbrug) | Structural-capacity restriction for trucks, agricultural vehicles and non-scheduled buses, with scheduled-public-transport/emergency exemptions and signed diversions | Mobility, road logistics/supply | Human-readable official current-status notice effective 9 June 2026; no published end date, event-driven cadence or machine-data licence | Integrated only on the exact N280 Weert–Leudal NWB corridor. The evidence interval stops at 3 September retrieval, no later state is extrapolated, no modal-share capacity loss is invented, and an empty NDW match remains Unknown rather than open |
| 54 | [Gemeente Lingewaard Rijndijk closure](https://samen.lingewaard.nl/p/Dijkversterking/i/05tYK/afsluiting-rijndijk-vanwege-realisatie-bouwweg-via15) | Dated Rijndijk closure between Angeren and Doornenburg for the ViA15 work-road crossing, with N838 detour | Mobility, road logistics/supply | Human-readable official notice; valid 24 August–2 October 2026; event-driven cadence and machine-data licence unstated | Integrated on exact NWB sections 389272008/391270006 as an internal gray context corridor. No modal exceptions, emergency priority, queue or detour throughput is invented; `capacitySemantics=unknown`, `affectsSimulation=false`, and empty NDW never proves open |
| 55 | [Rijkswaterstaat A44/Lisserweg lifecycle notice](https://www.rijkswaterstaat.nl/nieuws/archief/2026/09/onderdoorgang-lisserwegviaduct-weer-open-vanaf-6-september-2026) | A44 main-carriageway reopening, continuing Lisserweg underpass/local-connection closure and planned 6 September transition | Mobility, road logistics/supply | Human-readable official project update; date-specific but no exact reopening time or machine-data licence; planned completion can change | Integrated as evidence-card lifecycle context only because the current graph lacks the exact local underpass asset. The 6 September date is never promoted to confirmed open; A44 through traffic, local access, N207/N208 and Ringvaart/Lisserbrug remain distinct, while zero NDW matches remain Unknown |
| 56 | [Rijkswaterstaat Stuw Linne active-mode closure](https://www.rijkswaterstaat.nl/nieuws/archief/2026/03/hinder-voor-fietsers-door-onderhoud-stuw-linne-in-2026) | Pedestrian/cycle crossing closure and signed detour during stuw maintenance | Mobility, facilities/access | Human-readable official plan; valid 28 August–4 September 2026; no exact reopening time, live confirmation, fixed cadence or machine-data licence | Integrated as validity-aware evidence-card context because the crossing is absent from the causal road graph. It applies only to walking/cycling and never closes or numerically reduces an A2/A73 logistics edge; outside/empty NDW state remains Unknown |
| 57 | [PDOK Luchtfoto RGB](https://www.pdok.nl/ogc-webservices/-/article/pdok-luchtfoto-rgb-open-) | Nationwide current-edition RGB aerial orthophotography | Every map as a selectable basemap | WMTS; annual summer 25 cm nationwide product plus higher-resolution winter coverage where available; service attribution applies | Integrated as `Actueel_ortho25` at all relevant zooms. It is explicitly labeled annual aerial context—not live satellite imagery, weather or event evidence—and never changes the simulation |
| 58 | [PDOK 3D Basisvoorziening](https://www.pdok.nl/introductie/-/article/3d-basisvoorziening-1) and its [OGC API](https://api.pdok.nl/kadaster/3d-basisvoorziening/ogc/v1) | Nationwide LoD2.2/LoD1.3 buildings and 3D terrain derived from BAG, AHN, aerial imagery and BGT | Every city-scale map as an optional perspective | OGC 3D Tiles/CityJSON/quantized mesh; annual; CC BY 4.0 | Integrated through lazy 3D Tiles for the `gebouwen` and `terreinen` collections from zoom 12.5. Geometry remains static context—not occupancy, damage, flood depth, passability or live condition—and the affected-region overlay stays above it |
| 59 | [Rijkswaterstaat road-camera media policy](https://www.rijkswaterstaat.nl/wegen/wegbeheer/onderzoek/verkeersonderzoek/wat-doet-rijkswaterstaat-met-camerabeelden) and [NDW Viewer roadmap](https://www.ndw.nu/producten-en-diensten/applicaties/ndw-viewer) | Governance boundary for a future traffic-camera inventory/status/media adapter | Optional camera overlay beside traffic incidents | Rijkswaterstaat describes roughly 3,000 operational road cameras but does not generally supply their images to private parties without a legal basis; NDW lists traffic-camera support as under development | Client-safe empty adapter integrated. Inventory, device state and media availability are separate; no direct stream URL/credential reaches the browser, media needs observation/expiry plus privacy/licence approval, and empty/unavailable remains Unknown |

## KNMI forecast-adapter contract

The public forecast stack was rechecked on 3 September 2026. It supplies two complementary,
not interchangeable, time horizons:

- `seamless_precipitation_ensemble_forecast_probabilities` v1.0 is a pilot 1 km ensemble
  product with 72 five-minute valid steps from +5 through +360 minutes. It reports probability
  of exceeding `0.1`, `0.3`, `1`, `3`, `10` or `30 mm/h`; it does not report a deterministic
  rain intensity. WMS requests must carry `TIME`, `DIM_REFERENCE_TIME` and `DIM_THRESHOLD`.
  Bare `reference_time` or `threshold` parameters can return a valid-looking but empty PNG and
  therefore fail the ingest contract. The cached artifact must record all three dimension values,
  the style, bounds/CRS, response hash and retrieval time. A transparent pixel is not “no rain”.
- `harmonie_arome_cy43_p2a` v1.0 is KNMI's operational Cy43 Netherlands ensemble product with
  hourly near-surface parameters. KNMI documents leads from +00/+1 through +60 hours; the
  rolling 72-hour statement is a file-retention window, not forecast reach. Five-member batches
  start at successive run hours, so constructing all 30 members sacrifices lead overlap and yields
  about a 54-hour common window. It is therefore a short-range backbone, not a full exercise-horizon
  source. Complete model archives are too large for a
  browser-path adapter, so deployment should selectively extract only declared variables, levels,
  members/statistics and valid hours, then publish small checksum-bound Cloud-Optimized GeoTIFF,
  Zarr or vector-summary artifacts. The deterministic `harmonie_arome_cy43_p1` v1.0 product is
  useful for comparison, but its complete hourly archives were about 865 MB in the 3 September
  probe and must not be fetched per user or per map frame.

A live run may initialize T+0 from the newest complete cycle whose issue time is not in the future.
A historical replay must use a retained cycle, not today's forecast. A synthetic exercise may use
a named forecast as forcing only when the UI says so explicitly. In every mode the adapter must
preserve model cycle/issue time, valid time, forecast lead, ensemble/member or probability meaning,
variable/level/unit, grid and NoData metadata, licence, retrieval time and content hash. It must
reject partial cycles, parameter/unit changes, impossible valid-time sequences and gaps masquerading
as zeros. Seamless rainfall probability ends at +6; HARMONIE can supply later candidate weather only
through about +60 (+54 for a coherent lagged 30-member set). T+60–T+72 needs a separately issued,
compatible source or remains Unknown. The six-day KNMI outlook may add national narrative context,
but cannot be rasterized or numerically blended into municipal forcing by implication.

## Waterinfo forecast-adapter contract

The public Rijkswaterstaat Waterinfo rolling forecast endpoint was rechecked and cached on
3 September 2026. The adapter requests separate `waterhoogte` and `waterafvoer` windows ending
at +1, +6, +12, +24, +48 and +72 hours. In this deployment it retained 629 water-level and 44
discharge values: respectively `145/144/144/144/52/0` and `11/11/11/11/0/0` points at those
checkpoints, assigned by CBS 2025 polygon containment to 62 municipalities where possible.
This is point coverage, not national hydraulic coverage; an outside or missing municipal point is
Unknown/NoData.

Every cached value retains forecast versus source parameter identity, requested lead window,
per-value valid time, physical unit, vertical datum where provided, official class/colour,
possible-fault flag and municipality-assignment method. Every response retains URL, server response
time where supplied, byte count and SHA-256 hash. The public rolling-map endpoint does not expose a
single model cycle or issue time, so `issueTime` is deliberately `null`; the UI states that the
deployment forecast is not assumed to align with exercise T+0. The endpoint is also not documented
as a stable external contract, requiring schema monitoring and a last-known-good cache.

At runtime the Water and relevant flood Hazard maps select the nearest cached checkpoint and render
forecast rings/labels separately from observations. A horizon with zero returned features produces
an empty layer plus an explicit NoData notice, never a numeric zero, safe state or interpolation.
The snapshot is `official-forecast` evidence but `affectsSimulation=false`: causal use requires an
expert-governed station/boundary-condition selection with a recoverable issue/valid-time binding,
compatible hydraulic scenario, datum/unit checks and declared gap policy.

## LIWO causal-adapter contract

The public LIWO deployment was rechecked on 3 September 2026 rather than inferred from a
generic flood-map screenshot. Its published web configuration identifies application release
`2025.1.6`, backend `release-0.3.29`, Google Earth Engine collection
`projects/deltares-rws/liwo/2025_0_1`, a public WMS, an anonymous catalogue service and a
separate hydro engine. The WMS exposes composite products and individually identified regional
scenarios with distinct depth, velocity, affected, damage and casualty styles. The API exposes
scenario metadata and variant dimensions such as exceedance frequency, breach, failure moment,
water-level course, intervention and climate scenario. The live service also warns that large-map
downloads can currently fail, so a production ingest must be resumable, checksum its result and
retain the last known valid release rather than silently accepting a partial download.

A selected LIWO event may affect the simulation only after the adapter persists all of the
following as one immutable scenario package:

1. LIWO release, dataset collection, scenario ID(s), scenario title and source authority;
2. source-water system, breach/overflow location and defence/control assumptions;
3. every selected variant and probability/exceedance interpretation;
4. native CRS, grid resolution, band name, true unit, coverage and publisher NoData value;
5. depth, velocity, arrival, duration/recession and dewatering layers when available;
6. content hashes, retrieval time, licence/reuse status and any service/download warning;
7. the explicit mapping from hydraulic time to exercise T+0 through T+72; and
8. area- and population-weighted municipality/buurt summaries that reconcile to the retained
   source raster without replacing it.

The end-to-end API probe used scenario `13535` only as a contract test, not as a new default.
The returned authority metadata describes a Zuid-Holland/VNK2 dike-ring 16 Papendrecht breach
scenario dated 30 May 2012, based on a 2008 model schematization, AHN1 terrain, 100 m model
resolution and seven bands (depth, velocity, rise rate, damage, casualties, affected and arrival
time). A request for its `waterdepth` band produced a scenario-specific tile service. This is an
important realism check: a current LIWO release can legitimately contain older source models, so
the UI must show both catalogue release and scenario/model dates and must never market catalogue
freshness as event freshness. The probe is deliberately not persisted as an operational tile URL;
generated Earth Engine map identifiers can be transient and must be refreshed and checksum-bound
through an adapter.

The UI should first ask the exercise author to select a mechanism and named scenario, then show
only compatible layers and assumptions. A nationwide maximum-depth composite is useful planning
context, but must never initialize a local event or be presented as one coherent flood. If the
scenario lacks arrival/recession, defence state, local/regional-water coverage or a defensible
cross-border boundary condition, those fields remain `Unknown`; proximity, transparent pixels and
missing catalogue records are not substitutes.

## First implementation wave

The best return for the first 72-hour version is not dozens of simultaneous live connections.
It is a small set of resilient adapters that materially changes the model:

1. **Flood forcing:** the RWS national 70 mm-in-two-hours depth WMS is now a pluvial-map context
   layer with its centimetre classes, CC0 licence and NoData warning preserved. It does not change
   modeled forcing. Next, ingest named LIWO/local Climate Impact Atlas rasters and aggregate them to
   municipality and buurt with area/population-weighted exposure, while retaining the original
   raster for city view. Store scenario ID, mechanism, depth unit, probability class, arrival and
   recession time.
2. **Weather forcing:** a deployment-cached KNMI radar rendering, T+1/T+3/T+6 Seamless
   precipitation exceedance-probability rendering, sparse 10-minute station
   observations and the continually issued 48-hour province-warning product are now timestamped,
   non-causal overlays on relevant Hazard maps. The station adapter preserves WSI, interval-end time,
   source-file hash, variable-level NoData and retrieval freshness; it never interpolates a fixed point
   into a municipality. The warning adapter prefers structured XML and fails closed; a public-page
   fallback can assert only an explicit timestamped national no-warning state. The Seamless adapter
   retains its reference time, selected 3 mm/h threshold, valid checkpoint, 1 km probability meaning,
   EPSG:3857 request and image checksum; radar and forecast requests no longer rely on the service's
   currently transposed CRS:84 bounds. Next, selectively extract the HARMONIE-AROME Cy43 P2A ensemble
   for the hourly short-range backbone through at most T+60, and preserve the final T+60–T+72 gap as
   Unknown unless a separately governed longer-range product is added. The two forecast products
   must retain distinct issue, valid-time, probability/member, unit and NoData semantics; Seamless
   must stop at +6 hours rather than being extrapolated. Historical exercises require retained named
   cycles. Transformed KNMI'23 time series remain climate-sensitivity inputs, not current forecasts.
   Issued warnings remain context unless the exercise date, hazard, valid interval and geographic
   scope are explicitly bound.
3. **Water/drainage graph:** IMWA/DAMO pumps, RWZIs, weirs and sluices plus overlapping
   DAMO/GWSW pipe layers are now displayed as official context. Add object-level GWSW
   deduplication, drainage areas and level areas next; only connect
   assets causally when a public capacity/dependency field or an approved partner fixture supports it.
4. **Mobility state:** the same-origin server adapter now filters NDW's DATEX II current picture to
   real, unrestricted records intersecting publication time through T+72, preserves validity/source
   fields, refreshes through a 60-second cache, and shows explicit live/stale/fallback state on
   Mobility and Supply. Next, join records to the existing NWB
   graph and GTFS services. A closure may affect only the matching location, direction/mode and
   validity interval; stale status must expire to unknown, and the scenario clock must explicitly align.
   The N3 Papendrechtsebrug record is the first end-to-end reference-date example: a blank exercise
   date leaves it contextual, an overlapping date closes only Mobility and road logistics/Supply, and
   an out-of-window date does not infer that the bridge is open. The A27 Merwedebrug record also
   exercises a non-destructive class restriction: an aligned run exposes affected and allowed vehicle
   classes, but leaves the generalized edge unchanged until a source-backed vehicle mix can convert
   the restriction into a defensible numeric effect.
5. **Critical facilities:** current RIVM SEH roles, KVK public-service establishments and daily DUO
   RIO education-location uses are now separate, source-typed overlays. Add BAG use purposes next.
   Never infer beds, attendance, staff, generator endurance, shelter activation or acceptance
   capacity from an address or registry recognition.
6. **Ground/elevation exposure:** AHN4's 0.5 m DTM now appears at city scale on flood Hazard
   views with acquisition years, interpolation/filtering meaning, CC0 licence and NoData warning.
   It remains non-causal terrain context. Next derive low-point, high-rise, groundwater and access
   indicators from AHN, BRO, BAG and BGT. These become explanatory covariates, not automatic outage
   facts.
7. **National utility boundary conditions:** Liander public cable/station/pipe geometry is now
   visible as non-causal context, with full high-voltage retrieval and scale-aware visible-extent
   distribution queries. Stedin electricity lines and its explicitly incomplete gas-replacement
   programme now join the same failure-bounded visible-extent path. Hourly GTS physical-flow
   directions from ENTSOG are now cached on Gas with exact period, provisional state, extraction
   attribution and zero/NoData semantics; they remain non-additive national transmission context
   because the public point map has no documented WGS84 contract and does not establish municipal
   delivery. Add TenneT and other DSO products for national/feeding-area
   context. Keep connectivity, switching, flow, capacity, outage and restoration synthetic or
   unknown until an authoritative operational product supports them.
   Queries are isolated per public layer: a failed Liander or Stedin response does not erase valid
   geometry returned by another layer, the map labels the result partial, and failure remains
   NoData rather than evidence that no asset exists.
   Next, obtain approved `read:disruptions` credentials for the joint Energieonderbrekingen.nl
   API and ingest only records whose provider timestamp and planned/actual validity overlap the
   explicit exercise reference time. Current outages may initialize or contextualize a live drill;
   they are not automatically replayed through an unrelated 72-hour scenario. Liander's public
   transport forecast CSVs remain quarantined after a freshness/unit plausibility failure in this
   review rather than being silently rescaled.
8. **External-safety context:** REV regulated activities and attention areas are now visible on
   Hazard, with hazardous-substance pipeline references on Gas and Basisnet activity locations on
   Mobility/Supply. They identify where regulated risk context exists; they do not assert that an
   incident has occurred or supply an event-time release, plume, shipment, damage or closure.
9. **Air-quality observation context:** the RIVM Luchtmeetnet adapter now preserves station identity,
   active-location metadata, latest PM2.5 and available co-pollutants, measurement interval,
   retrieval window and source-response hashes. The resulting points appear only for wildfire/smoke
   Hazard and never affect the modeled smoke field. A municipality with no station is explicitly
   outside this snapshot's municipal station coverage; it is not assigned a zero concentration.
10. **Water observations:** Rijkswaterstaat Waterinfo latest water-level and discharge records now
    appear as station points on Water and relevant flood Hazard views. The ingest preserves vertical
    datum, observation age, official class, possible-fault flag, CC0 terms, source-response hash and
    the service's non-mission-critical caveat. Stale observations stay visibly flagged; the points do
    not become a hydraulic surface, breach/depth scenario, forecast series or causal model input.
11. **Water forecast context:** a separate Waterinfo deployment adapter preserves issued water-level
    and discharge points for +1/+6/+12/+24/+48/+72 request windows. Timeline maps select the nearest
    checkpoint while the Inspector exposes national and selected-municipality point coverage,
    retrieval and valid times, missing cycle issue time, CC0 terms and non-causal role. Current
    empty discharge +48/+72 and water-level +72 windows remain explicit NoData rather than zero.
12. **Nature-fire eligibility:** IPO/Risicokaart forest, heath and dune polygons now appear on
    wildfire Hazard views with Public Domain terms and catalogue date. They remain non-causal
    eligibility context; a causal fire scenario still requires a named ignition/perimeter,
    event-valid weather, fuel/moisture, access, extinguishing water and suppression state.
13. **Seismic observation context:** the KNMI FDSN Event adapter now retains origin time, event ID,
    magnitude/type, depth, location, review/evaluation state, response checksum and retrieval window.
    It filters the earthquake Hazard overlay to earthquakes and induced/triggered events while
    explicitly excluding controlled explosions, quarry blasts and sonic booms. The catalogue points
    never become shaking, felt intensity, damage, probability, forecast or scenario-clock forcing;
    later calibration requires an event-specific ShakeMap/strong-motion field plus building and
    lifeline fragility evidence.
14. **Agricultural exposure context:** RVO's BRP crop-declaration WMS now appears at its supported
    city scale on heat/drought, wildfire and emergency-supply maps. The interface preserves the
    annual 15 May reference date, 2025 definitive edition and differing permissive dataset/service
    licence statements. It never turns declared crop geometry into current crop presence/condition,
    dryness/fuel, yield, stock, damage, passability or T+72 supply; transparent coverage remains
    no mapped declaration rather than no agriculture or risk.
15. **Inland-waterway network context:** Rijkswaterstaat FIS-VNDS fairway lines and scale-aware
    bridge/lock points now appear on Mobility and Supply. The live CC0 MapServer establishes static
    identity and geometry only. It does not provide current navigability, water depth, restriction,
    bridge/lock operation, vessel throughput or future availability, and it never alters simulated
    routes. The source's separate `vaarwegstatus` values are route-role codes (for example main or
    alternative route), not open/closed status. A timestamped Notices-to-Skippers adapter remains
    required before operational restrictions can be aligned to observation/replay time.
16. **Aerial and 3D reference views:** PDOK `Actueel_ortho25` is now a selectable annual aerial
    basemap and PDOK 3D Basisvoorziening terrain/buildings load on demand from city zoom 12.5.
    Basemap and perspective switches preserve selected place, simulation time, question and impact
    overlay. Neither source is live or causal: a visible building is not occupied/intact and visible
    terrain is not a flood surface.
17. **Affected-region composition:** the current simulation frame now produces a separate municipal
    affected/critical/unsupported state at every quarter hour. That overlay composes with all eleven
    statistics and both basemaps/perspectives. Unsupported hazard geography remains gray Unknown;
    it is not counted as unaffected and cannot provide false reassurance.
18. **Traffic and camera adapters:** NDW `Actueel beeld` accidents, congestion and other incidents
    now have an independent overlay with publication time and explicit live/stale/fallback semantics.
    A same-origin server adapter refreshes through a 60-second last-known-good cache; the browser
    never polls the source XML directly. The next production step is schema/freshness alerting and
    validated NWB direction/link matching. A separate camera
    contract is ready for an authorized provider, but keeps inventory, operating state and media
    rights distinct and ships no direct stream URL or credential.

## Normalized data contract

```ts
interface EvidenceEnvelope<T> {
  value: T | null
  evidenceClass:
    | 'observed-live'
    | 'official-forecast'
    | 'official-scenario'
    | 'official-context'
    | 'derived'
    | 'synthetic'
    | 'unknown'
  sourceId: string
  sourceUrl: string
  publisher: string
  licence: string | null
  edition: string | null
  retrievedAt: string
  observedAt?: string
  issuedAt?: string
  validFrom?: string
  validTo?: string
  forecastLead?: string
  probabilityOrMember?: string
  spatialResolution?: string
  temporalResolution?: string
  coverage: 'complete' | 'partial' | 'outside-coverage' | 'unknown'
  transformation?: {
    method: string
    inputChecksums: string[]
    codeVersion: string
  }
  caveats: string[]
}
```

Adapters should download server-side, retain source metadata and checksums, validate schema and
coordinate reference system, normalize to WGS84 for the web, and publish compact versioned assets.
Large rasters should become cloud-optimized GeoTIFFs or tiles rather than being copied into the
main JavaScript bundle. Live feeds need bounded polling, exponential backoff, last-known-good age
and a visible stale/unknown state.

## Release gates

- Every map feature and statistic exposes source class, publisher, observation/edition time and
  whether it affects the simulation or is display-only.
- Every completed municipality audit whose verdict is `correction-required` or blocked must be
  represented in the generated fail-closed guard. Production builds compare the checked-in guard
  byte-for-byte with the immutable audit artifacts and stop when it is missing or stale. The guard
  marks local hazard dimensions unsupported and therefore numerically neutral for downstream
  service pressure; it preserves diagnostics and an explicit Unknown/NoData explanation instead of
  converting missing evidence to zero or safe.
- Audit automation is an evidence gate, not an automatic model correction. River/coastal mechanism
  eligibility, defence connectivity, fire-source containment, network topology and every transition
  from context to causal forcing require a reviewed, source-specific implementation and validation.
- A data-source outage cannot turn unknown into operational or failed.
- No cross-edition join occurs silently; stable CBS codes and an explicit concordance are required.
- Raster aggregation is tested against known cells and preserves `no data` separately from zero.
- Operational feeds expire according to their validity interval and never become permanent
  closures/outages.
- Utility, telecom, facility and emergency-service details are aggregated or omitted when public
  release would create security or privacy risk.
- Historical event replay and subject-matter review are required before a source can change a
  public-facing physical-unit forecast.

## Deliberately synthetic until partnership data exists

Liander now supplies public street-level electricity and gas *geometry* in its own territory, and
Stedin supplies public electricity geometry plus a narrower gas-replacement programme in its own
territory. Those products do not disclose a usable connected operational topology, switching/valve
state, flow, available capacity, failures or restoration resources. Comparable current coverage from
Enexis, every smaller DSO, drinking-water and telecom operator is also absent. Those fields—plus crew locations, spares, fuel
stock, backup endurance, control-system state, restoration order, hospital staffing/beds, shelter
occupancy and household inventories—remain editable scenario assumptions or explicit unknowns.
The application must never reverse-engineer them from road proximity, antenna points, building use
or public map screenshots.

### Netbeheer Nederland capacity-map boundary

The current national capacity map exposes public `servicearea/find` and `servicearea/get` JSON
responses. The generated snapshot resolves 339 of 342 municipalities to 250 distinct service areas
using the nearest valid public DUO education postcode to each CBS municipality reference point.
The Power map shows those sample points: marker colour is the returned TenneT withdrawal constraint
class and halo size is the sampled large-user withdrawal queue. Three no-match results remain
Unknown, and a single postcode never claims complete municipal or feeder-area coverage.

Netbeheer Nederland's current design calls the capacity-map data product open data and states a
quarterly cadence for capacity/projects and monthly cadence for queues. It does not give the
frontend endpoints a contractual stability promise or identify an exact dataset licence. The live
vector-tile key is origin-restricted, so this application does not reuse it. More importantly, the
publisher's separate topology/load/capacity design treats detailed topology, station locations,
operational limits and load as closed, use-case data. Therefore this layer can support congestion
and investment planning context only. It cannot drive outage, switching, spare-capacity, damage,
restoration or T+72 service calculations.
