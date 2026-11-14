import { reduce, initialState, evaluate, explainRipple, simulate, Action, GameState, availableInstruments } from './src/sim/engine';
import assert from 'node:assert';
let s: GameState = initialState(); const go = (a: Action) => (s = reduce(s, a));
const hdr = (t: string) => console.log('\n=== ' + t + ' ===');
const blockers = () => s.blockers.forEach(b => console.log(`  ✖ [${b.seg}] ${b.title}\n      ${b.why}`));
const report = () => { const r = s.result!; console.log(`  → ${r.outcome} | score ${r.score} | science ${Math.round(r.sciencePct)}% | ${JSON.stringify(r.breakdown)}`);
  r.segments.forEach(x => console.log(`    ${x.seg.padEnd(6)} ${x.grade} ${String(x.score).padStart(3)}  ${x.why}`)); r.timeline.forEach(t => console.log(`    d${String(t.day).padEnd(4)} ${t.phase}: ${t.text}`));
  console.log('    match:', r.matches.map(m => `${m.mission.name} ${m.similarity}% [${m.why.join('; ')}]`).join(' | ')); console.log('    ' + r.lesson); };
const start = (obj: string, sc: any) => { s = initialState(); go({ type: 'SET_OBJECTIVE', id: obj }); go({ type: 'ADVANCE' }); go({ type: 'SET_SCALE', scale: sc }); go({ type: 'ADVANCE' }); };

hdr('RUN 1: Lunar CubeSat. Bad first try, then fix (CML3 trade study)');
start('ice', 'cubesat');
go({ type: 'UPDATE_DESIGN', patch: { instruments: ['neutron-mini'], solarM2: .17, batteryWh: 40, antennaId: 'uhf', groundId: 'commercial', duty: 1 } }); // default cold-gas thruster
go({ type: 'ADVANCE' }); blockers();
const e1 = evaluate(s.design!); go({ type: 'UPDATE_DESIGN', patch: { propId: 'mono' } });
console.log('  ripple (cold gas → hydrazine):', explainRipple(e1, evaluate(s.design!)).join(' | '));
go({ type: 'ADVANCE' }); go({ type: 'LAUNCH', seed: 3 }); report();

hdr('RUN 2: Wildfire SmallSat. Data bottleneck lesson');
start('fire', 'smallsat');
go({ type: 'UPDATE_DESIGN', patch: { instruments: ['vis-hi', 'tir'], launcherId: 'small', duty: 1, solarM2: 4, batteryWh: 600 } });
const e2 = evaluate(s.design!); e2.issues.filter(i => i.sev !== 'info').forEach(i => console.log(`  ${i.sev.toUpperCase()} [${i.seg}] ${i.title}\n      ${i.why}`));
go({ type: 'UPDATE_DESIGN', patch: { duty: .25, groundId: 'nsn', redundancy: 1 } });
console.log('  ripple (duty 100%→25%, NSN, redundancy):', explainRipple(e2, evaluate(s.design!)).join(' | '));
go({ type: 'ADVANCE' }); blockers(); go({ type: 'ADVANCE' }); go({ type: 'LAUNCH', seed: 11 }); report();

hdr('RUN 3: Mars Flagship. Laser comm + DSN');
start('mars', 'flagship');
go({ type: 'UPDATE_DESIGN', patch: { instruments: ['vis-hi', 'nir', 'tir', 'sar'], propId: 'biprop', antennaId: 'kahga', groundId: 'dsn', launcherId: 'medium', solarM2: 40, batteryWh: 4000, duty: .45, redundancy: 2 } });
const e3 = evaluate(s.design!); console.log(`  RF dish: data returned ${Math.round(e3.data.ret * 100)}%, science ${Math.round(e3.science.sci)}%`);
go({ type: 'UPDATE_DESIGN', patch: { antennaId: 'laser' } }); const e3b = evaluate(s.design!);
console.log('  ripple (Ka dish → laser comm):', explainRipple(e3, e3b).join(' | '));
go({ type: 'ADVANCE' }); blockers(); go({ type: 'ADVANCE' }); go({ type: 'LAUNCH', seed: 5 }); report();

hdr('CHECKS');
start('ice', 'smallsat'); go({ type: 'UPDATE_DESIGN', patch: { instruments: ['neutron', 'tir-lo'], launcherId: 'medium', groundId: 'commercial', antennaId: 'xhga', solarM2: 3, batteryWh: 300, duty: .8 } });
assert.deepStrictEqual(simulate(s.design!, 42), simulate(s.design!, 42)); console.log('  ✓ same seed → identical result (deterministic)');
const outs = new Set([1, 2, 3, 4, 5, 6, 7, 8].map(x => simulate(s.design!, x).outcome)); console.log('  ✓ different seeds → outcomes:', [...outs].join(', '));
const eLEO = evaluate({ ...s.design!, objectiveId: 'fire', orbitId: 'leo', scale: 'smallsat' }); console.log(`  ✓ LEO 500 km: period ${eLEO.power.periodMin.toFixed(1)} min, eclipse ${eLEO.power.eclipseMin.toFixed(1)} min (${(eLEO.power.eclipseMin / eLEO.power.periodMin).toFixed(3)} of orbit)`);
assert(Math.abs(eLEO.power.periodMin - 94.6) < .5 && Math.abs(eLEO.power.eclipseMin / eLEO.power.periodMin - .378) < .01);
go({ type: 'RESET' }); go({ type: 'ADVANCE' }); assert(s.phase === 'CML1' && s.blockers.length === 1); console.log('  ✓ cannot skip CML1 without an objective');
start('irsky', 'cubesat'); go({ type: 'RESET' }); go({ type: 'SET_OBJECTIVE', id: 'irsky' }); go({ type: 'ADVANCE' }); go({ type: 'SET_SCALE', scale: 'cubesat' }); go({ type: 'ADVANCE' }); assert(s.phase === 'CML2'); console.log('  ✓ CML2 blocks infeasible class:', s.blockers[0].title);
console.log('  ✓ disabled instruments (ice/cubesat):', availableInstruments('ice', 'cubesat').filter(x => !x.enabled).map(x => x.instr.id).join(', '));
