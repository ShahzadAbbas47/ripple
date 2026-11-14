/* =====================================================================
 RIPPLE engine: pure, deterministic, zero UI. Drop into src/sim/engine.ts
 CML1-4 state machine + trade-off math + anomalies + real-mission match.
 All catalog numbers are ROUNDED / APPROXIMATE and meant to be tuned.
 Real-mission figures: verify against NASA pages before pitching.
===================================================================== */
export type ScaleId = 'cubesat' | 'smallsat' | 'flagship';
export type Seg = 'launch' | 'space' | 'ground' | 'user';
export type Phase = 'CML1' | 'CML2' | 'CML3' | 'CML4' | 'DEBRIEF';
export interface Issue { seg: Seg; sev: 'block' | 'warn' | 'info'; code: string; title: string; why: string }
const G0 = 9.80665;
const SCALE_ORDER: ScaleId[] = ['cubesat', 'smallsat', 'flagship'];
// Link model: rate[Mbps] = K * EIRP[W] * groundFactor / dist[km]^2 (capped by hardware).
// Sanity: MRO-class (EIRP~4e6 W) ~4 Mbps at 2.25e8 km; MarCO-class (~3e3 W) ~16 kbps at 1e8 km.
const LINK_K = 5.06e10;

// ---------------- CATALOG ----------------
type Fit = ['ok' | 'risky' | 'no', string];
export interface Objective { id: string; name: string; pitch: string; wavelengths: string[]; weights: Record<string, number>; orbits: string[]; lifeYears: number; minSci: number; fullSci: number; scaleFit: Record<ScaleId, Fit> }
export const OBJECTIVES: Record<string, Objective> = {
  fire: { id: 'fire', name: 'Track wildfires from orbit', pitch: 'Spot hot spots early and map burn scars.', wavelengths: ['Thermal IR 3-12 µm (heat)', 'Visible 0.4-0.7 µm (smoke, burn scars)', 'Near-IR (vegetation dryness)'],
    weights: { 'thermal-ir': .5, visible: .35, 'nir-spec': .15 }, orbits: ['leo'], lifeYears: 1, minSci: 30, fullSci: 60,
    scaleFit: { cubesat: ['ok', 'Tiny thermal + visible payloads fit; the catch is data volume and ground contact time.'], smallsat: ['ok', 'The sweet spot: capable imagers without flagship cost.'], flagship: ['risky', 'Overkill: you pay for capability this objective cannot use.'] } },
  ice: { id: 'ice', name: 'Find water ice at the lunar poles', pitch: 'Map hydrogen and ice in permanently shadowed craters.', wavelengths: ['Neutrons (hydrogen signature)', 'Radar S-band (subsurface ice)', 'Thermal IR (cold traps)', 'Visible (context)'],
    weights: { neutron: .5, radar: .25, 'thermal-ir': .15, visible: .1 }, orbits: ['moon'], lifeYears: 1, minSci: 25, fullSci: 65,
    scaleFit: { cubesat: ['risky', 'One mini neutron spectrometer is all that fits (LunaH-Map style): minimum science only, and lunar orbit insertion fights the rocket equation.'], smallsat: ['ok', 'Lunar Prospector-class missions did real ice science at this scale.'], flagship: ['ok', 'LRO-class: full instrument suite, big budget and mass.'] } },
  irsky: { id: 'irsky', name: 'Observe the early universe in infrared', pitch: 'Detect faint, redshifted light from the first galaxies.', wavelengths: ['Near/Mid-IR 0.6-28 µm (cold optics required)', 'Visible (guide + context)'],
    weights: { 'ir-tel': .85, visible: .15 }, orbits: ['l2', 'leo'], lifeYears: 5, minSci: 30, fullSci: 70,
    scaleFit: { cubesat: ['no', 'A cryogenic telescope needs aperture, cooling and a sunshield that cannot fit in a CubeSat.'], smallsat: ['no', 'Aperture + cryo-cooling mass exceed smallsat class.'], flagship: ['ok', 'JWST-class. Infrared needs cold: L2 gives passive cooling.'] } },
  mars: { id: 'mars', name: 'Map Mars water and climate', pitch: 'Find where water lives: surface, subsurface and atmosphere.', wavelengths: ['Near-IR spectra (minerals, hydrated)', 'Thermal IR (surface/atmosphere)', 'Radar (subsurface ice)', 'Visible (geology)'],
    weights: { 'nir-spec': .3, 'thermal-ir': .25, radar: .25, visible: .2 }, orbits: ['mars'], lifeYears: 2, minSci: 30, fullSci: 65,
    scaleFit: { cubesat: ['no', 'Mars orbit insertion needs >1 km/s. MarCO CubeSats only flew past Mars; none can brake into orbit.'], smallsat: ['no', 'A dedicated Mars orbiter needs ~1.5 km/s of Δv, a deep-space link and a ride to Mars: together they cost more than a smallsat budget.'], flagship: ['ok', 'MRO-class. Mars forces the Deep Space Network.'] } },
};
export const SCALES: Record<ScaleId, { name: string; maxKg: number; budgetM: number; baseW: number; avionicsKg: number; structFrac: number; busBaseM: number; costPerKg: number; maxSolarM2: number; maxBattWh: number; storageGB: number }> = {
  cubesat: { name: 'CubeSat (6-12U)', maxKg: 24, budgetM: 15, baseW: 6, avionicsKg: 1.2, structFrac: .2, busBaseM: 1.5, costPerKg: .15, maxSolarM2: .5, maxBattWh: 100, storageGB: 8 },
  smallsat: { name: 'SmallSat (100-500 kg)', maxKg: 500, budgetM: 150, baseW: 60, avionicsKg: 20, structFrac: .18, busBaseM: 25, costPerKg: .08, maxSolarM2: 10, maxBattWh: 2000, storageGB: 256 },
  flagship: { name: 'Flagship (1-8 t)', maxKg: 8000, budgetM: 900, baseW: 300, avionicsKg: 120, structFrac: .15, busBaseM: 250, costPerKg: .15, maxSolarM2: 80, maxBattWh: 20000, storageGB: 2000 },
};
export interface Instr { id: string; name: string; kind: string; massKg: number; powerW: number; mbps: number; costM: number; q: number; cold?: boolean; minScale: ScaleId }
export const INSTR: Record<string, Instr> = {
  mag: { id: 'mag', name: 'Magnetometer', kind: 'mag', massKg: 1, powerW: 1, mbps: .001, costM: 1, q: .5, minScale: 'cubesat' },
  'vis-lo': { id: 'vis-lo', name: 'Compact visible imager', kind: 'visible', massKg: 2, powerW: 8, mbps: 4, costM: 3, q: .4, minScale: 'cubesat' },
  'vis-hi': { id: 'vis-hi', name: 'High-res visible camera', kind: 'visible', massKg: 65, powerW: 90, mbps: 60, costM: 60, q: 1, minScale: 'smallsat' },
  'tir-lo': { id: 'tir-lo', name: 'Compact thermal-IR imager', kind: 'thermal-ir', massKg: 4, powerW: 12, mbps: .5, costM: 5, q: .5, minScale: 'cubesat' },
  tir: { id: 'tir', name: 'Cooled thermal-IR radiometer', kind: 'thermal-ir', massKg: 12, powerW: 25, mbps: 2, costM: 20, q: .9, cold: true, minScale: 'smallsat' },
  nir: { id: 'nir', name: 'Near-IR imaging spectrometer', kind: 'nir-spec', massKg: 30, powerW: 40, mbps: 10, costM: 40, q: .9, cold: true, minScale: 'smallsat' },
  'neutron-mini': { id: 'neutron-mini', name: 'Mini neutron spectrometer', kind: 'neutron', massKg: 3, powerW: 8, mbps: .01, costM: 4, q: .6, minScale: 'cubesat' },
  neutron: { id: 'neutron', name: 'Neutron spectrometer', kind: 'neutron', massKg: 10, powerW: 12, mbps: .05, costM: 12, q: .9, minScale: 'smallsat' },
  sar: { id: 'sar', name: 'Imaging radar / sounder', kind: 'radar', massKg: 70, powerW: 250, mbps: 12, costM: 90, q: 1, minScale: 'flagship' },
  'ir-tel': { id: 'ir-tel', name: 'Cryogenic IR telescope', kind: 'ir-tel', massKg: 600, powerW: 150, mbps: 5, costM: 400, q: 1, cold: true, minScale: 'flagship' },
};
export const ANTENNAS: Record<string, { name: string; massKg: number; txW: number; gainDbi: number; drawW: number; maxMbps: number }> = {
  uhf: { name: 'UHF whip', massKg: .1, txW: 1, gainDbi: 2, drawW: 3, maxMbps: .1 },
  xpatch: { name: 'X-band patch', massKg: .4, txW: 5, gainDbi: 8, drawW: 20, maxMbps: 10 },
  xhga: { name: 'X-band 0.5 m dish', massKg: 5, txW: 20, gainDbi: 32, drawW: 70, maxMbps: 150 },
  kahga: { name: 'Ka-band 3 m dish', massKg: 40, txW: 100, gainDbi: 50, drawW: 300, maxMbps: 1000 },
  laser: { name: 'Laser comm terminal (DSOC-class demo)', massKg: 30, txW: 4, gainDbi: 74, drawW: 100, maxMbps: 250 },
};
export const PROPS: Record<string, { name: string; isp: number; fixedKg: number; costM: number; scales: ScaleId[] }> = {
  cold: { name: 'Cold gas (Isp 70 s)', isp: 70, fixedKg: .6, costM: .3, scales: ['cubesat', 'smallsat'] },
  mono: { name: 'Hydrazine monoprop (Isp 220 s)', isp: 220, fixedKg: 4, costM: 3, scales: ['cubesat', 'smallsat', 'flagship'] },
  biprop: { name: 'Bipropellant (Isp 315 s)', isp: 315, fixedKg: 25, costM: 15, scales: ['smallsat', 'flagship'] },
};
export const GROUNDS: Record<string, { name: string; factor: number; leoMin: number; deepMin: number; minKm: number; maxKm: number; costPerYr: number }> = {
  univ: { name: 'University station (5 m)', factor: .02, leoMin: 40, deepMin: 90, minKm: 0, maxKm: 6e5, costPerYr: .5 },
  commercial: { name: 'Commercial network', factor: .15, leoMin: 240, deepMin: 180, minKm: 0, maxKm: 2e6, costPerYr: 3 },
  nsn: { name: 'NASA Near Space Network', factor: .4, leoMin: 300, deepMin: 240, minKm: 0, maxKm: 2e6, costPerYr: 6 },
  dsn: { name: 'NASA Deep Space Network (34/70 m)', factor: 1, leoMin: 0, deepMin: 480, minKm: 5e4, maxKm: 1e12, costPerYr: 15 },
};
export const LAUNCHERS: Record<string, { name: string; costM: number; cap: Record<string, number> }> = {
  rideshare: { name: 'Rideshare slot', costM: 1.2, cap: { leo: 150, moon: 30, mars: 30, l2: 0 } },
  small: { name: 'Small launcher (Electron-class)', costM: 8, cap: { leo: 300, moon: 0, mars: 0, l2: 0 } },
  medium: { name: 'Medium (Falcon 9 / Atlas V-class)', costM: 70, cap: { leo: 10000, moon: 3500, mars: 2500, l2: 2800 } },
  heavy: { name: 'Heavy (Falcon Heavy / Ariane 6-class)', costM: 160, cap: { leo: 40000, moon: 14000, mars: 12000, l2: 8000 } },
};
export const ORBITS: Record<string, { name: string; dest: 'leo' | 'moon' | 'mars' | 'l2'; mu: number; R: number; alt: number; flux: number; dvMps: number; effDv: number; distKm: number; transit: [number, number]; passiveCold?: boolean; blurb: string }> = {
  leo: { name: 'Low Earth Orbit 500 km', dest: 'leo', mu: 398600.4, R: 6371, alt: 500, flux: 1361, dvMps: 150, effDv: 1, distKm: 1500, transit: [0, 0], blurb: 'Close to home: easy launch and fast comms, but ~36 min of shadow every 95 min orbit.' },
  moon: { name: 'Lunar polar orbit 100 km', dest: 'moon', mu: 4902.8, R: 1737, alt: 100, flux: 1361, dvMps: 1000, effDv: .8, distKm: 384400, transit: [5, 100], blurb: 'Lunar orbit insertion costs ~1 km/s. Low-energy transfers save Δv but take months.' },
  mars: { name: 'Mars orbit 400 km', dest: 'mars', mu: 42828, R: 3390, alt: 400, flux: 590, dvMps: 1500, effDv: .85, distKm: 2.25e8, transit: [210, 330], blurb: 'Sunlight is only 43% of Earth\'s and signals take minutes. Only the Deep Space Network reaches this far.' },
  l2: { name: 'Sun-Earth L2 halo orbit', dest: 'l2', mu: 0, R: 0, alt: 0, flux: 1361, dvMps: 150, effDv: .9, distKm: 1.5e6, transit: [30, 90], passiveCold: true, blurb: 'No eclipses, and a sunshield keeps optics cold. Far from Earth: ~1.5 million km.' },
};

// ---------------- DESIGN + EVALUATION ----------------
export interface Design { objectiveId: string; orbitId: string; trajectory: 'fast' | 'efficient'; scale: ScaleId; instruments: string[]; duty: number; solarM2: number; batteryWh: number; antennaId: string; propId: string; groundId: string; launcherId: string; redundancy: 0 | 1 | 2; lifeYears: number }
export interface Evaluation {
  mass: { instrKg: number; dryKg: number; propKg: number; wetKg: number; dvMps: number; mult: number };
  power: { loadW: number; solarW: number; margin: number; dod: number; eclipseMin: number; periodMin: number; cyclesPerYr: number };
  data: { genGBday: number; downGBday: number; rateMbps: number; contactMin: number; ret: number; bufferDays: number };
  launch: { capKg: number; margin: number; cheapest: string | null };
  cost: { total: number; budget: number; margin: number };
  science: { sci: number; effLife: number; transitDays: number };
  issues: Issue[];
}
export function defaultDesign(objectiveId: string, scale: ScaleId): Design {
  const o = OBJECTIVES[objectiveId];
  return { objectiveId, orbitId: o.orbits[0], trajectory: 'fast', scale, instruments: [], duty: .5,
    solarM2: { cubesat: .15, smallsat: 3, flagship: 20 }[scale], batteryWh: { cubesat: 40, smallsat: 400, flagship: 3000 }[scale],
    antennaId: { cubesat: 'xpatch', smallsat: 'xhga', flagship: 'xhga' }[scale], propId: scale === 'cubesat' ? 'cold' : 'mono',
    groundId: { cubesat: 'univ', smallsat: 'commercial', flagship: 'dsn' }[scale], launcherId: { cubesat: 'rideshare', smallsat: 'small', flagship: 'medium' }[scale], redundancy: 0, lifeYears: o.lifeYears };
}
export function availableInstruments(objectiveId: string, scale: ScaleId) {
  const o = OBJECTIVES[objectiveId];
  return Object.values(INSTR).map(i => {
    let reason = '';
    if (!(i.kind in o.weights)) reason = `Measures ${i.kind}, which this objective does not need.`;
    else if (SCALE_ORDER.indexOf(scale) < SCALE_ORDER.indexOf(i.minScale)) reason = `Too big for a ${scale}: needs ${i.minScale}-class mass/power (${i.massKg} kg, ${i.powerW} W).`;
    return { instr: i, enabled: !reason, reason };
  });
}
function orbitMech(o: typeof ORBITS[string]) {
  if (!o.mu) return { periodMin: 1440, eclFrac: 0 }; // L2 halo: no eclipse
  const a = o.R + o.alt;
  return { periodMin: 2 * Math.PI * Math.sqrt(a ** 3 / o.mu) / 60, eclFrac: Math.asin(o.R / a) / Math.PI }; // worst-case eclipse (beta = 0)
}
const n0 = (x: number) => Math.round(x).toLocaleString('en-US');
const f1 = (x: number) => x.toFixed(1);

export function evaluate(d: Design): Evaluation {
  const obj = OBJECTIVES[d.objectiveId], sc = SCALES[d.scale], orb = ORBITS[d.orbitId], ant = ANTENNAS[d.antennaId], prop = PROPS[d.propId], gs = GROUNDS[d.groundId], L = LAUNCHERS[d.launcherId];
  const ins = d.instruments.map(i => INSTR[i]);
  const issues: Issue[] = [];
  const add = (seg: Seg, sev: Issue['sev'], code: string, title: string, why: string) => issues.push({ seg, sev, code, title, why });
  const { periodMin, eclFrac } = orbitMech(orb), eclMin = periodMin * eclFrac;
  const transitDays = orb.transit[d.trajectory === 'fast' ? 0 : 1], effLife = d.lifeYears - transitDays / 365;

  // GROUND SEGMENT: contact + link
  const inRange = orb.distKm <= gs.maxKm && orb.distKm >= gs.minKm;
  const contactMin = inRange ? (orb.distKm < 5e4 ? gs.leoMin : gs.deepMin) : 0;
  if (!inRange) add('ground', 'block', 'GS_RANGE', `${gs.name} cannot track this orbit`, orb.distKm > gs.maxKm
    ? `${orb.name} is ${n0(orb.distKm)} km away. Received power falls as 1/d², and this network's antennas can't close the link beyond ${n0(gs.maxKm)} km. Beyond ~2 million km only the Deep Space Network works.`
    : `The DSN's giant dishes are built for deep space (> ${n0(gs.minKm)} km). Near-Earth missions use the Near Space Network or commercial stations.`);
  const eirp = ant.txW * 10 ** (ant.gainDbi / 10);
  const rateMbps = Math.min(ant.maxMbps, LINK_K * eirp * gs.factor / orb.distKm ** 2);
  const downGB = rateMbps * contactMin * .0075; // Mbps * s / 8 / 1000
  const genGB = ins.reduce((s, i) => s + i.mbps * d.duty * 10.8, 0); // Mbps*86400/8/1000
  const ret = genGB > 0 ? Math.min(1, downGB / genGB) : 1;
  const bufferDays = genGB > downGB ? sc.storageGB / (genGB - downGB) : Infinity;
  if (genGB > 0 && ret < .6 && inRange) add('ground', ret < .25 ? 'block' : 'warn', 'DOWNLINK', `Data bottleneck: only ${Math.round(ret * 100)}% of your data can come home`,
    `Your instruments make ${f1(genGB)} GB/day, but ${ant.name} reaches ${rateMbps.toFixed(rateMbps < 1 ? 3 : 1)} Mbps at ${n0(orb.distKm)} km (signal ∝ 1/d²) and ${gs.name} sees you ${contactMin} min/day → ${f1(downGB)} GB/day. The rest is lost once the ${sc.storageGB} GB recorder fills (${isFinite(bufferDays) ? f1(bufferDays) : '∞'} days). Fix: lower duty cycle, bigger antenna (costs mass + power), better ground network, or leaner instruments.`);

  // SPACE SEGMENT: power
  const cooling = orb.passiveCold ? 0 : ins.filter(i => i.cold).length, coolerKg = cooling * 8, coolerW = cooling * 40;
  if (cooling) add('space', 'info', 'CRYO', `${cooling} cooled detector(s) need active cryocoolers`, `Infrared detectors must be cold. Away from L2's sunshield passive cooling, each costs ~8 kg and ~40 W.`);
  const loadW = sc.baseW + ins.reduce((s, i) => s + i.powerW * d.duty, 0) + coolerW + ant.drawW * contactMin / 1440;
  const solarW = d.solarM2 * orb.flux * .28 * .85 * (1 - .02 * d.lifeYears); // cell eff * packing, 2%/yr degradation
  const sunH = periodMin * (1 - eclFrac) / 60, needWh = loadW * (sunH + eclMin / 60 / .9), genWh = solarW * sunH;
  const pMargin = needWh > 0 ? genWh / needWh - 1 : 0;
  const dod = eclMin > 0 ? (d.batteryWh > 0 ? loadW * eclMin / 60 / d.batteryWh : Infinity) : 0;
  const cycles = eclFrac > 0 ? 365 * 1440 / periodMin : 0;
  if (pMargin < 0) add('space', 'block', 'POWER', `Power-negative: ${Math.round(pMargin * 100)}% margin`, `Average load ${f1(loadW)} W vs ${f1(solarW)} W of solar at end-of-life (${orb.flux} W/m² sunlight × 28% cells × 0.85 packing, minus 2%/yr). The battery can only shift energy, not create it. Add array area or cut duty cycle / instruments.`);
  else if (pMargin < .05) add('space', 'warn', 'POWER_THIN', `Power margin only ${Math.round(pMargin * 100)}%`, `Anything under ~10% leaves no room for degradation or anomalies. Real teams hold 10-30%.`);
  if (dod > 1) add('space', 'block', 'BATTERY', 'Battery cannot carry the eclipse', `Eclipse lasts ${f1(eclMin)} min at ${f1(loadW)} W = ${n0(loadW * eclMin / 60)} Wh, more than the ${d.batteryWh} Wh battery holds.`);
  else if (dod > .4) add('space', 'warn', 'DOD', `Battery depth-of-discharge ${Math.round(dod * 100)}%`, `${n0(cycles)} eclipse cycles per year. Li-ion cells cycled deeper than ~40% wear out early (this is why long LEO missions carry oversized batteries).`);

  // SPACE SEGMENT: mass + rocket equation
  const instrKg = ins.reduce((s, i) => s + i.massKg, 0);
  const base = sc.avionicsKg + 3 * d.solarM2 + d.batteryWh / 150 + ant.massKg + .05 * loadW + coolerKg; // array 3 kg/m², battery 150 Wh/kg, thermal 0.05 kg/W
  const bus = base + sc.structFrac * (base + instrKg), redKg = [0, .12, .3][d.redundancy] * bus;
  const D0 = instrKg + bus + redKg + prop.fixedKg;
  const dv = orb.dvMps * (d.trajectory === 'efficient' ? orb.effDv : 1) * 1.1; // +10% Δv margin
  const k = Math.exp(dv / (prop.isp * G0)) - 1, den = 1 - .1 * k; // tanks = 10% of propellant
  const feasible = den > .05, propKg = feasible ? D0 * k / den : Infinity, wet = feasible ? D0 + 1.1 * propKg : Infinity;
  if (!feasible) add('launch', 'block', 'ROCKET_EQ', 'The rocket equation says no', `Δv ${n0(dv)} m/s at Isp ${prop.isp} s needs propellant ×${f1(k)} of dry mass, and the tanks alone outweigh any reasonable spacecraft. Use a higher-Isp engine, a lower-Δv trajectory, or a smaller mission.`);
  if (transitDays > 60) add('launch', 'info', 'TRANSIT', `Low-energy transfer: ${transitDays} days in transit`, `You save ${Math.round((1 - orb.effDv) * 100)}% Δv, but ${f1(transitDays / 30)} months of your ${d.lifeYears}-year design life are spent just arriving.`);
  if (effLife <= 0) add('user', 'block', 'LIFE', 'Arrives after end of life', 'Transit time exceeds the design life, so no science is ever collected.');
  if (wet > sc.maxKg) add('space', 'block', 'SCALE_MASS', `Too heavy for a ${sc.name}`, `${n0(wet)} kg wet vs ${n0(sc.maxKg)} kg class limit. Step up a class or cut mass (each kg of dry mass becomes ${f1(wet / D0)} kg at launch).`);
  if (d.solarM2 > sc.maxSolarM2 || d.batteryWh > sc.maxBattWh) add('space', 'block', 'BUS_FIT', 'Solar array / battery do not fit this bus class', `${sc.name} supports ≤ ${sc.maxSolarM2} m² of array and ≤ ${n0(sc.maxBattWh)} Wh.`);
  if (!prop.scales.includes(d.scale)) add('space', 'block', 'PROP_SCALE', `${prop.name} not available on a ${d.scale}`, 'Fixed hardware mass and plumbing make this engine impractical at this size.');
  ins.forEach(i => { if (SCALE_ORDER.indexOf(d.scale) < SCALE_ORDER.indexOf(i.minScale)) add('space', 'block', 'INSTR_SCALE', `${i.name} won't fit a ${d.scale}`, `Needs ${i.minScale}-class mass/power (${i.massKg} kg, ${i.powerW} W).`);
    if (!(i.kind in obj.weights)) add('user', 'warn', 'INSTR_USELESS', `${i.name} adds no science here`, `This objective needs ${Object.keys(obj.weights).join(', ')}. You pay mass, power and money for nothing.`); });
  if (!ins.length) add('user', 'block', 'NO_INSTR', 'No instruments selected', 'A spacecraft with nothing to measure returns no science.');

  // LAUNCH SEGMENT
  const capKg = L.cap[orb.dest], lMargin = capKg > 0 && isFinite(wet) ? capKg / wet - 1 : -1;
  const cheapest = Object.values(LAUNCHERS).filter(l => l.cap[orb.dest] >= wet * 1.1).sort((a, b) => a.costM - b.costM)[0]?.name ?? null;
  if (capKg === 0) add('launch', 'block', 'LAUNCH_REACH', `${L.name} cannot reach ${orb.dest.toUpperCase()}`, `Reaching ${orb.name} needs more energy than this vehicle's upper stage can deliver, whatever the payload.${cheapest ? ` Cheapest option that fits: ${cheapest}.` : ''}`);
  else if (isFinite(wet) && lMargin < 0) add('launch', 'block', 'LAUNCH_MASS', `Too heavy for ${L.name}`, `${n0(wet)} kg wet vs ${n0(capKg)} kg capacity to ${orb.dest.toUpperCase()}. Propellant for ${n0(dv)} m/s of Δv multiplies your dry mass by ${f1(wet / D0)}×.${cheapest ? ` Upgrade to: ${cheapest} (+cost), or cut dry mass.` : ' No launcher in the catalog fits.'}`);
  else if (lMargin < .05) add('launch', 'warn', 'LAUNCH_THIN', `Launch margin only ${Math.round(lMargin * 100)}%`, 'Mass grows during development (typically 10-20%). Real projects hold mass margin.');
  else if (lMargin > 3 && cheapest && cheapest !== L.name && LAUNCHERS[Object.keys(LAUNCHERS).find(k2 => LAUNCHERS[k2].name === cheapest)!].costM < L.costM) add('launch', 'info', 'OVERBUILT_LAUNCH', 'Launcher is overkill', `${Math.round(lMargin * 100)}% spare capacity. ${cheapest} would do and cost less.`);

  // COST
  const instrM = ins.reduce((s, i) => s + i.costM, 0), busM = (sc.busBaseM + sc.costPerKg * (bus + prop.fixedKg)) * (1 + [0, .15, .4][d.redundancy]);
  const total = instrM + busM + prop.costM + L.costM + gs.costPerYr * d.lifeYears;
  if (total > sc.budgetM) add('launch', 'block', 'BUDGET', `Over budget: $${f1(total)}M vs $${sc.budgetM}M`, `Instruments $${f1(instrM)}M + bus $${f1(busM)}M + propulsion $${f1(prop.costM)}M + launch $${f1(L.costM)}M + operations $${f1(gs.costPerYr * d.lifeYears)}M.`);

  // USER SEGMENT: science return
  const bestQ: Record<string, number> = {}; ins.forEach(i => { bestQ[i.kind] = Math.max(bestQ[i.kind] ?? 0, i.q); });
  const raw = Object.entries(obj.weights).reduce((s, [kind, w]) => s + w * (bestQ[kind] ?? 0), 0);
  const sci = 100 * raw * d.duty ** .5 * ret * Math.min(1, Math.max(0, effLife) / obj.lifeYears);
  if (ins.length && sci < obj.minSci && !issues.some(i => i.sev === 'block')) add('user', 'warn', 'SCI_LOW', `Projected science ${Math.round(sci)}% is below minimum success (${obj.minSci}%)`, 'Even if nothing breaks, this design cannot meet the Level-1 science threshold. Add the missing measurement types, raise duty cycle, or fix the data bottleneck.');
  const order = { block: 0, warn: 1, info: 2 }; issues.sort((a, b) => order[a.sev] - order[b.sev]);
  return { mass: { instrKg, dryKg: D0, propKg, wetKg: wet, dvMps: dv, mult: wet / D0 }, power: { loadW, solarW, margin: pMargin, dod, eclipseMin: eclMin, periodMin, cyclesPerYr: cycles },
    data: { genGBday: genGB, downGBday: downGB, rateMbps, contactMin, ret, bufferDays }, launch: { capKg, margin: lMargin, cheapest },
    cost: { total, budget: sc.budgetM, margin: 1 - total / sc.budgetM }, science: { sci, effLife, transitDays }, issues };
}
/** Ripple Graph captions: what changed between two evaluations, in causal order. */
export function explainRipple(a: Evaluation, b: Evaluation): string[] {
  const o: string[] = [], ch = (x: number, y: number, t: number) => Math.abs(y - x) > t;
  if (ch(a.data.genGBday, b.data.genGBday, .05)) o.push(`DATA ${f1(a.data.genGBday)} → ${f1(b.data.genGBday)} GB/day`);
  if (ch(a.data.ret, b.data.ret, .02)) o.push(`DOWNLINK return ${Math.round(a.data.ret * 100)}% → ${Math.round(b.data.ret * 100)}%`);
  if (ch(a.power.loadW, b.power.loadW, .5)) o.push(`POWER load ${f1(a.power.loadW)} → ${f1(b.power.loadW)} W (margin ${Math.round(b.power.margin * 100)}%)`);
  if (ch(a.mass.dryKg, b.mass.dryKg, .1)) o.push(`MASS dry ${f1(a.mass.dryKg)} → ${f1(b.mass.dryKg)} kg`);
  if (isFinite(b.mass.wetKg) && ch(a.mass.wetKg, b.mass.wetKg, .1)) o.push(`ROCKET EQ wet ${n0(a.mass.wetKg)} → ${n0(b.mass.wetKg)} kg (×${f1(b.mass.mult)})`);
  if (ch(a.launch.margin, b.launch.margin, .01)) o.push(`LAUNCH margin ${Math.round(a.launch.margin * 100)}% → ${Math.round(b.launch.margin * 100)}%`);
  if (ch(a.cost.total, b.cost.total, .05)) o.push(`COST $${f1(a.cost.total)}M → $${f1(b.cost.total)}M`);
  if (ch(a.science.sci, b.science.sci, .5)) o.push(`SCIENCE ${Math.round(a.science.sci)}% → ${Math.round(b.science.sci)}%`);
  return o;
}

// ---------------- CML4: SIMULATION ----------------
function rng(seed: number) { let a = seed | 0; return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
interface Ev { id: string; name: string; w: number; p: (d: Design, e: Evaluation) => number; loss: number; fatal?: boolean; ok: string; bad: string }
const EVENTS: Ev[] = [
  { id: 'spe', name: 'Solar particle event', w: 2, p: (d) => .45 + .25 * d.redundancy + (d.orbitId === 'leo' ? .15 : 0), loss: .15, ok: 'Cross-strapped/redundant avionics rebooted cleanly.', bad: 'Radiation flipped bits in a single-string computer → weeks in safe mode. Redundancy is the cure (LEO is shielded by Earth\'s magnetosphere; deep space is not).' },
  { id: 'wheel', name: 'Reaction wheel failure', w: 2, p: (d) => .35 + .3 * d.redundancy, loss: .4, ok: 'A spare wheel took over; pointing stayed sharp.', bad: 'No spare wheel: pointing accuracy degraded and instruments lost lock for long stretches.' },
  { id: 'gs', name: 'Ground-station outage', w: 1, p: (d) => d.groundId === 'univ' ? .5 : d.groundId === 'commercial' ? .8 : .92, loss: .1, ok: 'A backup station / network handoff kept data flowing.', bad: 'Single small station went dark; the recorder filled and data was overwritten.' },
  { id: 'thermal', name: 'Thermal / micrometeoroid anomaly', w: 1, p: (d) => .6 + .15 * d.redundancy, loss: .2, ok: 'Margin in thermal design absorbed the hit.', bad: 'A heater circuit failed; one instrument ran out of its temperature range.' },
];
export interface TLEvent { day: number; phase: 'Launch' | 'Transit' | 'Commissioning' | 'Science Ops' | 'End of Life'; text: string; ok?: boolean }
export interface SegScore { seg: Seg; score: number; grade: string; why: string }
export interface SimResult { outcome: 'FULL SUCCESS' | 'MINIMUM SUCCESS' | 'MISSION FAILURE'; sciencePct: number; score: number; breakdown: { science: number; efficiency: number; resilience: number }; segments: SegScore[]; timeline: TLEvent[]; matches: MatchResult[]; ev: Evaluation; lesson: string }
const grade = (s: number) => s >= 90 ? 'A' : s >= 80 ? 'B' : s >= 70 ? 'C' : s >= 60 ? 'D' : 'F';
const userScore = (sci: number, o: { minSci: number; fullSci: number }) => sci >= o.fullSci ? 100 : sci >= o.minSci ? 60 + 40 * (sci - o.minSci) / (o.fullSci - o.minSci) : 60 * sci / o.minSci;
const health = (m: number) => m < 0 ? 0 : m < .05 ? 40 : m <= .25 ? 100 : m <= .5 ? 80 : 65; // reward 5-25% margin; punish thin AND wasteful

export function simulate(d: Design, seed: number): SimResult {
  const e = evaluate(d), obj = OBJECTIVES[d.objectiveId], orb = ORBITS[d.orbitId], r = rng(seed), tl: TLEvent[] = [];
  const blockers = e.issues.filter(i => i.sev === 'block');
  const L = LAUNCHERS[d.launcherId];
  tl.push({ day: 0, phase: 'Launch', text: blockers.length ? `LAUNCH ABORTED: ${blockers[0].title}` : `Launch on ${L.name}, ${n0(e.mass.wetKg)} kg to ${orb.dest.toUpperCase()}.`, ok: !blockers.length });
  let mult = blockers.length ? 0 : 1, fatal = !!blockers.length, resLost = 0, resTotal = 0;
  const tDays = e.science.transitDays, opsDays = Math.max(1, Math.round(e.science.effLife * 365));
  if (!blockers.length) {
    if (tDays) tl.push({ day: 1, phase: 'Transit', text: `${tDays}-day ${d.trajectory === 'fast' ? 'direct' : 'low-energy'} transfer to ${orb.name}.` });
    const forced: Ev[] = [];
    if (orb.dest === 'moon' || orb.dest === 'mars') forced.push({ id: 'moi', name: 'Orbit insertion burn', w: 0, p: () => .8 + .07 * d.redundancy, loss: 1, fatal: true, ok: `Burn nominal: captured into ${orb.name}.`, bad: 'Insertion burn failed. One missed burn = no second chance (Mars Climate Orbiter was lost at Mars in 1999 over a pound-force vs newton unit mismatch).' });
    if (e.power.dod > .4 && isFinite(e.power.dod)) forced.push({ id: 'batt', name: 'Battery wear-out', w: 0, p: () => .35, loss: .35, ok: 'Battery limped on with reduced capacity.', bad: `Cycling ${Math.round(e.power.dod * 100)}% deep ${n0(e.power.cyclesPerYr)}×/yr aged the cells; usable capacity collapsed.` });
    const n = Math.min(5, 1 + Math.round(e.science.effLife)), picked = [...forced];
    const pool = [...EVENTS]; for (let i = 0; i < n && pool.length; i++) { let t = r() * pool.reduce((s, x) => s + x.w, 0); for (let j = 0; j < pool.length; j++) { t -= pool[j].w; if (t <= 0) { picked.push(pool.splice(j, 1)[0]); break; } } }
    tl.push({ day: tDays + 2, phase: 'Commissioning', text: 'Instruments checked out; calibration complete.' });
    const sched = picked.map(x => ({ x, day: x.id === 'moi' ? tDays : tDays + 30 + Math.floor(r() * opsDays) })).sort((a, b) => a.day - b.day);
    for (const { x, day } of sched) {
      if (fatal) break; const ok = r() < x.p(d, e); resTotal += x.loss; if (!ok) { resLost += x.loss; if (x.fatal) fatal = true; else mult *= 1 - x.loss; }
      tl.push({ day, phase: 'Science Ops', text: `${x.name}: ${ok ? 'SURVIVED. ' + x.ok : 'FAILED. ' + x.bad}`, ok });
    }
    if (!fatal) tl.push({ day: tDays + opsDays, phase: 'End of Life', text: 'Design life reached. Passivation and decommissioning.' });
  }
  const sciencePct = fatal ? 0 : e.science.sci * mult;
  const outcome = sciencePct >= obj.fullSci ? 'FULL SUCCESS' : sciencePct >= obj.minSci ? 'MINIMUM SUCCESS' : 'MISSION FAILURE';
  const resilience = resTotal ? 100 * (1 - resLost / resTotal) : 100;
  const science = userScore(sciencePct, obj);
  const rightSized = e.launch.margin > .25 && e.launch.cheapest === L.name; // smallest vehicle that fits: spare capacity is unavoidable, not waste
  const launchHealth = rightSized ? 90 : health(e.launch.margin);
  const efficiency = blockers.length ? 0 : (health(e.power.margin) + launchHealth + health(e.cost.margin) + (e.power.dod <= .4 ? 100 : 50)) / 4;
  const score = Math.round(outcome === 'MISSION FAILURE' ? .3 * (.5 * science + .25 * efficiency + .25 * resilience) : .5 * science + .25 * efficiency + .25 * resilience);
  const segments: SegScore[] = ([
    ['launch', blockers.some(b => b.seg === 'launch') ? 0 : launchHealth, `Launch margin ${Math.round(e.launch.margin * 100)}%, rocket-equation multiplier ${f1(e.mass.mult)}×, cost $${f1(e.cost.total)}M of $${e.cost.budget}M.`],
    ['space', blockers.some(b => b.seg === 'space') ? 0 : (health(e.power.margin) + (e.power.dod <= .4 ? 100 : 50)) / 2, `Power margin ${Math.round(e.power.margin * 100)}%, battery DoD ${isFinite(e.power.dod) ? Math.round(e.power.dod * 100) : '∞'}%.`],
    ['ground', blockers.some(b => b.seg === 'ground') ? 0 : e.data.ret * 100, `${f1(e.data.genGBday)} GB/day generated vs ${f1(e.data.downGBday)} GB/day downlinked (${Math.round(e.data.ret * 100)}% returned).`],
    ['user', science, `Science delivered ${Math.round(sciencePct)}% (minimum ${obj.minSci}%, full ${obj.fullSci}%).`]] as [Seg, number, string][]).map(([seg, s, why]) => ({ seg, score: Math.round(s), grade: grade(s), why }));
  const worst = segments.reduce((a, b) => a.score <= b.score ? a : b).seg;
  const lessons: Record<Seg, string> = { launch: 'Every kilogram you add multiplies through the rocket equation. Mass is the most expensive thing in space.', space: 'Power and batteries are set by orbit geometry (eclipse), not by hope. Size for the worst case, with margin.', ground: 'A mission is only as good as the data it can bring home. Instruments, antenna and ground contact must be designed together.', user: 'Science value comes from the right measurements at the right quality, not the most hardware.' };
  if (tl.length && tl[0].phase === 'Launch' && !blockers.length) tl.push({ day: tDays + opsDays + 1, phase: 'End of Life', text: `Outcome: ${outcome}.` });
  tl.sort((a, b) => a.day - b.day);
  return { outcome, sciencePct, score, breakdown: { science: Math.round(science), efficiency: Math.round(efficiency), resilience: Math.round(resilience) }, segments, timeline: tl, matches: matchMissions(d, e), ev: e, lesson: `Weakest segment: ${worst.toUpperCase()}. ${lessons[worst]}` };
}

// ---------------- REAL MISSION MATCH (approximate, verify before pitching) ----------------
export interface RealMission { id: string; name: string; year: number; dest: string; kg: number; costM?: number; kinds: string[]; note: string }
export const REAL_MISSIONS: RealMission[] = [
  { id: 'bird', name: 'BIRD (DLR)', year: 2001, dest: 'leo', kg: 92, kinds: ['thermal-ir', 'visible'], note: 'Small satellite built to detect hot spots such as wildfires.' },
  { id: 'landsat9', name: 'Landsat 9', year: 2021, dest: 'leo', kg: 2750, costM: 750, kinds: ['visible', 'nir-spec', 'thermal-ir'], note: 'Land imaging flagship; thermal sensor aids fire/water monitoring.' },
  { id: 'terra', name: 'Terra (MODIS)', year: 1999, dest: 'leo', kg: 4800, kinds: ['thermal-ir', 'visible', 'nir-spec'], note: 'Large Earth-observing platform; MODIS data supports global fire detection.' },
  { id: 'prospector', name: 'Lunar Prospector', year: 1998, dest: 'moon', kg: 295, costM: 63, kinds: ['neutron', 'mag'], note: 'Low-cost orbiter whose neutron data pointed to hydrogen at the lunar poles.' },
  { id: 'lro', name: 'Lunar Reconnaissance Orbiter', year: 2009, dest: 'moon', kg: 1900, costM: 500, kinds: ['neutron', 'radar', 'thermal-ir', 'visible'], note: 'Flagship polar orbiter: neutron, radar, thermal and camera suite.' },
  { id: 'lunahmap', name: 'LunaH-Map (6U CubeSat)', year: 2022, dest: 'moon', kg: 14, kinds: ['neutron'], note: 'CubeSat neutron mapper for polar hydrogen, a secondary payload to the Moon.' },
  { id: 'marco', name: 'MarCO (CubeSats)', year: 2018, dest: 'mars', kg: 14, kinds: [], note: 'First interplanetary CubeSats: flew past Mars as a relay, did not enter orbit.' },
  { id: 'odyssey', name: 'Mars Odyssey', year: 2001, dest: 'mars', kg: 730, costM: 300, kinds: ['thermal-ir', 'visible', 'neutron'], note: 'Mapped Martian water-ice signatures from orbit.' },
  { id: 'mro', name: 'Mars Reconnaissance Orbiter', year: 2005, dest: 'mars', kg: 2180, costM: 720, kinds: ['visible', 'nir-spec', 'radar', 'thermal-ir'], note: 'Flagship: HiRISE camera, CRISM spectrometer, SHARAD radar, climate sounder.' },
  { id: 'jwst', name: 'James Webb Space Telescope', year: 2021, dest: 'l2', kg: 6200, costM: 10000, kinds: ['ir-tel'], note: 'Cryogenic IR observatory at Sun-Earth L2 behind a 5-layer sunshield.' },
];
export interface MatchResult { mission: RealMission; similarity: number; why: string[] }
export function matchMissions(d: Design, e: Evaluation, top = 2): MatchResult[] {
  const mine = new Set(d.instruments.map(i => INSTR[i].kind)), dest = ORBITS[d.orbitId].dest;
  return REAL_MISSIONS.map(m => {
    const k = new Set(m.kinds), inter = [...mine].filter(x => k.has(x)).length, jac = inter / (new Set([...mine, ...k]).size || 1);
    const ms = isFinite(e.mass.wetKg) ? 1 - Math.min(1, Math.abs(Math.log10(e.mass.wetKg / m.kg)) / 1.5) : 0, dm = m.dest === dest ? 1 : 0;
    const why = [dm ? `same destination (${dest.toUpperCase()})` : '', inter ? `shared instruments: ${[...mine].filter(x => k.has(x)).join(', ')}` : '', ms > .6 && isFinite(e.mass.wetKg) ? `similar mass (${n0(e.mass.wetKg)} vs ~${n0(m.kg)} kg)` : ''].filter(Boolean);
    return { mission: m, similarity: Math.round(100 * (.4 * jac + .35 * dm + .25 * ms)), why };
  }).sort((a, b) => b.similarity - a.similarity).slice(0, top);
}

// ---------------- CML STATE MACHINE ----------------
export const PHASE_INFO: Record<Phase, { title: string; goal: string }> = {
  CML1: { title: 'CML 1: Science Need', goal: 'Pick the science question, the wavelengths/data you need, and where to observe from.' },
  CML2: { title: 'CML 2: Feasibility & Risk', goal: 'Choose the spacecraft class. Is this even possible at CubeSat, SmallSat or Flagship scale?' },
  CML3: { title: 'CML 3: Trade Studies', goal: 'Balance Launch, Space, Ground and User segments until no blocker remains.' },
  CML4: { title: 'CML 4: Point Design & Flight', goal: 'Design frozen. Launch, operate, survive anomalies.' },
  DEBRIEF: { title: 'Engineering Debrief', goal: 'Why it worked or failed, and which real NASA mission you resemble.' },
};
const PHASES: Phase[] = ['CML1', 'CML2', 'CML3', 'CML4', 'DEBRIEF'];
export interface GameState { phase: Phase; design: Design | null; scaleChosen: boolean; result: SimResult | null; blockers: Issue[]; log: string[] }
export type Action = { type: 'SET_OBJECTIVE'; id: string } | { type: 'SET_SCALE'; scale: ScaleId } | { type: 'UPDATE_DESIGN'; patch: Partial<Design> } | { type: 'ADVANCE' } | { type: 'BACK' } | { type: 'LAUNCH'; seed: number } | { type: 'REDESIGN' } | { type: 'RESET' };
export const initialState = (): GameState => ({ phase: 'CML1', design: null, scaleChosen: false, result: null, blockers: [], log: [] });
const blk = (title: string, why: string, seg: Seg = 'user'): Issue => ({ seg, sev: 'block', code: 'GATE', title, why });
/** What stops the player leaving the current phase. Empty array = can advance. */
export function gate(s: GameState): Issue[] {
  const d = s.design;
  if (s.phase === 'CML1') return d ? [] : [blk('Pick a science objective', 'Every mission starts from a science need, not from hardware.')];
  if (s.phase === 'CML2') { if (!d || !s.scaleChosen) return [blk('Choose a spacecraft class', 'Size the mission before sizing the subsystems.')]; const [fit, why] = OBJECTIVES[d.objectiveId].scaleFit[d.scale]; return fit === 'no' ? [blk(`${SCALES[d.scale].name} is infeasible for this objective`, why, 'space')] : []; }
  if (s.phase === 'CML3') return d ? evaluate(d).issues.filter(i => i.sev === 'block') : [];
  return [];
}
export function reduce(s: GameState, a: Action): GameState {
  const log = (m: string) => [...s.log, m];
  switch (a.type) {
    case 'SET_OBJECTIVE': return s.phase !== 'CML1' ? s : { ...s, design: defaultDesign(a.id, 'smallsat'), scaleChosen: false, blockers: [], log: log(`Objective: ${OBJECTIVES[a.id].name}`) };
    case 'SET_SCALE': return s.phase !== 'CML2' || !s.design ? s : { ...s, design: { ...defaultDesign(s.design.objectiveId, a.scale), orbitId: s.design.orbitId, trajectory: s.design.trajectory }, scaleChosen: true, blockers: [], log: log(`Class: ${SCALES[a.scale].name}. ${OBJECTIVES[s.design.objectiveId].scaleFit[a.scale][1]}`) };
    case 'UPDATE_DESIGN': { if (!s.design || (s.phase !== 'CML1' && s.phase !== 'CML3')) return s; const p = { ...a.patch }; if (s.phase === 'CML1') for (const k of Object.keys(p)) if (k !== 'orbitId' && k !== 'trajectory') delete (p as any)[k]; if (p.orbitId && !OBJECTIVES[s.design.objectiveId].orbits.includes(p.orbitId)) delete p.orbitId; return { ...s, design: { ...s.design, ...p }, blockers: [] }; }
    case 'ADVANCE': { if (s.phase === 'CML4' || s.phase === 'DEBRIEF') return s; const b = gate(s); return b.length ? { ...s, blockers: b } : { ...s, phase: PHASES[PHASES.indexOf(s.phase) + 1], blockers: [], log: log(`Passed gate → ${PHASE_INFO[PHASES[PHASES.indexOf(s.phase) + 1]].title}`) }; }
    case 'BACK': return s.phase === 'CML1' ? s : { ...s, phase: PHASES[Math.max(0, PHASES.indexOf(s.phase) - 1)], result: null, blockers: [] };
    case 'LAUNCH': return s.phase !== 'CML4' || !s.design ? s : { ...s, phase: 'DEBRIEF', result: simulate(s.design, a.seed), log: log('Launch!') };
    case 'REDESIGN': return s.phase !== 'DEBRIEF' ? s : { ...s, phase: 'CML3', result: null, blockers: [], log: log('Redesign and re-fly') };
    case 'RESET': return initialState();
  }
}
