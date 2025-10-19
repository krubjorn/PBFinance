/* (c)2025 KrugerNyasulu 
    app.js — Clean UI: supply-chain & rebound toggles; quadrant plots; nicer Plotly visuals.
   Works as a drop-in replacement. Keeps internal supplyChainMult & reboundElasticity arrays.
*/

/* -------------------------- Data & defaults -------------------------- */
const PB_NAMES = [
  "Climate (tCO2 / $1M)",
  "Biodiversity (extinctions / $1M)",
  "Biogeochemical (kg N-eq / $1M)",
  "Chemical pollution (n-kg CP / $1M)",
  "Land-system (ha / $1M)",
  "Freshwater (m3 / $1M)",
  "Ocean acid (kmol H3O+ / $1M)",
  "Ozone (kg CFC-11 eq / $1M)",
  "Aerosols (n-kg AE / $1M)"
];

const PB_THRESHOLDS = [188.5, 0.00000013, 161.0, 3000.0, 33.0, 81408.0, 0.0370, 2.48, 3000.0];

let INDUSTRIES = [
  "Renewable Energy","Fossil Fuels","Agriculture","Mining & Materials","Manufacturing","Waste & Env Services","Reforestation & Conservation"
];

const R0_BASE = [6.0,8.0,5.0,7.0,6.5,4.5,3.5];

let INTENSITY = [
  [20.0,1e-9,10.0,100.0,1.0,500.0,0.005,0.01,50.0],
  [900.0,1e-7,5.0,500.0,5.0,1000.0,0.02,0.5,400.0],
  [150.0,1e-6,900.0,800.0,20.0,30000.0,0.005,0.005,200.0],
  [300.0,1e-6,20.0,700.0,10.0,2000.0,0.003,0.2,500.0],
  [200.0,5e-7,50.0,900.0,2.0,400.0,0.008,0.1,350.0],
  [120.0,2e-7,10.0,300.0,1.0,800.0,0.002,0.02,100.0],
  [-50.0,-1e-6,-2.0,10.0,-15.0,50.0,-0.001,0.0,5.0]
];

const TOTAL_CAPITAL_M = 100.0;
const DEFAULT_RAW_ALLOC = [15,25,15,10,20,5,10];

// internal multipliers & rebound elasticities (kept in background)
let supplyChainMult = [1.15, 1.6, 1.4, 1.5, 1.3, 1.2, 1.05];
let reboundElasticity = [0.02, 0.15, 0.08, 0.05, 0.03, 0.02, -0.02];

// PB coupling (small default)
let PB_COUPLING = (function(){
  const K = PB_NAMES.length;
  const C = Array.from({length:K}, ()=> new Array(K).fill(0));
  const find = name => PB_NAMES.findIndex(s=>s.startsWith(name));
  const climate = find("Climate"), nutrients = find("Biogeochemical"), biodiversity = find("Biodiversity"), ocean = find("Ocean acid");
  if (climate>=0 && ocean>=0) C[climate][ocean] = 0.05;
  if (nutrients>=0 && biodiversity>=0) { C[nutrients][biodiversity] = 0.08; C[nutrients][3] = 0.04; }
  return C;
})();

/* -------------------------- DOM refs -------------------------- */
const slidersContainer = document.getElementById("alloc-sliders"); // kept from older builds but not shown in new UI
const roiBox = document.getElementById("roi-value");
const betaFileInput = document.getElementById("beta-file");
const exportBtn = document.getElementById("export-json");
const importInput = document.getElementById("import-json");
const importBtn = document.getElementById("import-json-btn");
const simLog = document.getElementById("simulation-log");

const regenSlider = document.getElementById("regen-fraction");
const regenOutput = document.getElementById("regen-fraction-val");
const integratorSelect = document.getElementById("integrator-select");
const dtInput = document.getElementById("dt-input");
const mitigationControls = document.getElementById("mitigation-controls");
const addQuarterBtn = document.getElementById("add-quarter");
const removeQuarterBtn = document.getElementById("remove-quarter");
const clearQuartersBtn = document.getElementById("clear-quarters");
const quarterCountSpan = document.getElementById("quarter-count");

const enableSupplychain = document.getElementById("enable-supplychain");
const enableRebound = document.getElementById("enable-rebound");

const roiFeedbackToggle = document.getElementById("roi-feedback-toggle");
const etaInput = document.getElementById("eta-input");
const etaVal = document.getElementById("eta-val");

const pbChartDiv = document.getElementById("pb-chart");
const allocChartDiv = document.getElementById("alloc-chart");
const tsChartDiv = document.getElementById("ts-chart");
const sensitivityHeatmapDiv = document.getElementById("sensitivity-heatmap");

/* controls at bottom */
const simulateBtn = document.getElementById("simulate-quarters");
const simulate24Btn = document.getElementById("simulate-quarters-24");
const simulateScenarioBtn = document.getElementById("simulate-scenario");
const computeSensitivityBtn = document.getElementById("compute-sensitivity");
const downloadSensitivityBtn = document.getElementById("download-sensitivity");
const clearLogBtn = document.getElementById("clear-log");

/* -------------------------- State -------------------------- */
let sliderInputs = []; // we won't display per-industry sliders, but we use internal scenario stamping (uses getRawValuesFromSliders stub)
let mitigationPct = new Array(PB_NAMES.length).fill(0.0);
let scenarioQuarters = [];
let currentStocks = PB_THRESHOLDS.map(t=>0.5*t);
let lastRevenueM = null;

/* -------------------------- Utility functions -------------------------- */
function normalizeAlloc(raw) {
  const clipped = raw.map(x => Math.max(0, Number(x) || 0));
  const sum = clipped.reduce((a,b) => a + b, 0);
  if (sum <= 0) return new Array(clipped.length).fill(1 / clipped.length);
  return clipped.map(x => x / sum);
}

// Even though supply-chain UI removed, this function respects the enableSupplychain checkbox
function getAdjustedIntensityMatrix() {
  const N = INDUSTRIES.length, K = PB_NAMES.length;
  const B = new Array(N);
  const useSC = enableSupplychain.checked;
  for (let i=0;i<N;i++){
    const mult = useSC ? (supplyChainMult[i]||1.0) : 1.0;
    B[i] = new Array(K);
    for (let k=0;k<K;k++){
      B[i][k] = (INTENSITY[i] && INTENSITY[i][k] !== undefined ? Number(INTENSITY[i][k]) : 0) * mult;
    }
  }
  return B;
}

// compute fluxes reverberating rebound if enabled
function computeFluxes(revenueM, prevRevenueM = null) {
  const N = INDUSTRIES.length, K = PB_NAMES.length;
  const Bbase = getAdjustedIntensityMatrix();
  const useReb = enableRebound.checked;
  const s = new Array(N).fill(0);
  if (useReb && prevRevenueM) {
    for (let i=0;i<N;i++){
      const prev = Math.max(prevRevenueM[i]||0, 1e-9);
      s[i] = (revenueM[i] - prev) / prev;
    }
  }
  const Bprime = new Array(N);
  for (let i=0;i<N;i++){
    Bprime[i] = new Array(K);
    const rho = (useReb ? (reboundElasticity[i]||0) : 0);
    const factor = 1 + rho * s[i];
    for (let k=0;k<K;k++){
      Bprime[i][k] = Bbase[i][k] * factor;
    }
  }
  const pbTotals = new Array(K).fill(0);
  for (let i=0;i<N;i++){
    const rev = revenueM[i] || 0;
    for (let k=0;k<K;k++){
      pbTotals[k] += (Bprime[i][k] || 0) * rev;
    }
  }
  const pbMitig = pbTotals.map((v,k)=> v * (1 - (mitigationPct[k]||0)));
  const totalRev = revenueM.reduce((a,b)=>a+b,0) || 1e-9;
  const pbPer1M = pbMitig.map(v => v / totalRev);
  return { pbTotals: pbMitig, pbPer1M, totalRev, Bprime };
}

function applyPBCoupling(pbPer1M) {
  const K = PB_NAMES.length;
  const norm = pbPer1M.map((p,k)=> p / PB_THRESHOLDS[k]);
  const eff = pbPer1M.slice();
  for (let k=0;k<K;k++){
    let addNorm = 0;
    for (let j=0;j<K;j++){
      if (j===k) continue;
      addNorm += (PB_COUPLING[j] && PB_COUPLING[j][k]) ? PB_COUPLING[j][k] * norm[j] : 0;
    }
    eff[k] = eff[k] + addNorm * PB_THRESHOLDS[k];
  }
  return eff;
}

function computeROI(revenueM, Bstocks = null) {
  const totalRev = revenueM.reduce((a,b)=>a+b,0) || 1e-9;
  const weights = revenueM.map(r => r / totalRev);
  const r0 = R0_BASE.slice(0, INDUSTRIES.length);
  if (roiFeedbackToggle.checked && Bstocks) {
    const Bmat = getAdjustedIntensityMatrix();
    const exposure = Bmat.map(row => row.reduce((a,b)=>a+b,0));
    const r_eff = [];
    for (let i=0;i<INDUSTRIES.length;i++){
      let pen = 0;
      for (let k=0;k<PB_NAMES.length;k++){
        const over = Math.max(0, (Bstocks[k] / PB_THRESHOLDS[k]) - 1.0);
        const sens = (Bmat[i][k] || 0) / (exposure[i] || 1e-9);
        pen += sens * over;
      }
      const scale = Math.max(0, 1 - (parseFloat(etaInput.value) || 0.35) * pen);
      r_eff[i] = (r0[i] || 5.0) * scale;
    }
    return weights.reduce((acc,w,i)=> acc + w * (r_eff[i]||5.0), 0);
  } else {
    return weights.reduce((acc,w,i)=> acc + w * (r0[i]||5.0), 0);
  }
}

/* -------------------------- ODE integrators -------------------------- */
function derivs_from_flux(B, t, flux_in_per_year, regenFraction) {
  const K = PB_NAMES.length;
  const dB = new Array(K).fill(0.0);
  for (let k = 0; k < K; k++) {
    const regen = regenFraction * PB_THRESHOLDS[k];
    dB[k] = (flux_in_per_year[k] || 0) - regen;
  }
  return dB;
}

function rk4_step(B, t, dt, flux_func, regenFraction) {
  const k1_flux = flux_func(t, B);
  const k1 = derivs_from_flux(B, t, k1_flux, regenFraction);
  const addScaled = (a, karr, scale) => a.map((v,i) => v + karr[i]*scale);
  const Bk2 = addScaled(B, k1, dt/2);
  const k2_flux = flux_func(t + dt/2, Bk2);
  const k2 = derivs_from_flux(Bk2, t + dt/2, k2_flux, regenFraction);
  const Bk3 = addScaled(B, k2, dt/2);
  const k3_flux = flux_func(t + dt/2, Bk3);
  const k3 = derivs_from_flux(Bk3, t + dt/2, k3_flux, regenFraction);
  const Bk4 = addScaled(B, k3, dt);
  const k4_flux = flux_func(t + dt, Bk4);
  const k4 = derivs_from_flux(Bk4, t + dt, k4_flux, regenFraction);
  const next = new Array(PB_NAMES.length);
  for (let i=0;i<PB_NAMES.length;i++){
    next[i] = B[i] + dt*(k1[i] + 2*k2[i] + 2*k3[i] + k4[i]) / 6.0;
  }
  return next;
}

function euler_step(B, t, dt, flux_func, regenFraction) {
  const flux = flux_func(t, B);
  const dB = derivs_from_flux(B, t, flux, regenFraction);
  return B.map((b,i) => b + dt * dB[i]);
}

/* -------------------------- Charting: nicer Plotly visuals -------------------------- */
function colorForRatio(ratio) {
  if (ratio === null) return '#9ca3af';
  if (ratio >= 1.0) return '#ef4444';
  if (ratio >= 0.8) return '#f59e0b';
  return '#10b981';
}

function percentOfThreshold(pbPer1M) {
  return pbPer1M.map((p,k) => {
    const thr = PB_THRESHOLDS[k];
    if (!isFinite(thr) || thr === 0) return null;
    return p / thr;
  });
}

function drawPBChart(pbPer1M) {
  const ratios = percentOfThreshold(pbPer1M);
  const colors = ratios.map(r => colorForRatio(r));
  const traceBars = {
    x: pbPer1M,
    y: PB_NAMES,
    orientation: 'h',
    type: 'bar',
    marker: { color: colors, line: { width: 1, color: '#0b1220' } },
    hovertemplate: '<b>%{y}</b><br>Intensity: %{x:.4g} per $1M<br>Threshold: %{customdata}<extra></extra>',
    customdata: PB_THRESHOLDS
  };
  const thrScatter = {
    x: PB_THRESHOLDS,
    y: PB_NAMES,
    mode: 'markers',
    marker: { color: '#ef4444', symbol: 'triangle-left', size: 12 },
    hoverinfo: 'x+y',
    showlegend: false
  };
  const layout = {
    title: { text: 'PB Pressures per $1M', font: { size: 14 } },
    margin: { l: 300, r: 20, t: 40, b: 30 },
    xaxis: { title: 'Intensity per $1M', zeroline: false },
    height: 420
  };
  Plotly.newPlot(pbChartDiv, [traceBars, thrScatter], layout, {responsive:true, displayModeBar:true});
}

function drawAllocChart(revenueM) {
  const total = revenueM.reduce((a,b)=>a+b,0) || 1e-9;
  const percent = revenueM.map(r => (r/total)*100);
  const trace = { x: INDUSTRIES, y: percent, type: 'bar', marker: { color: INDUSTRIES.map((_,i)=> `rgba(${50+i*25},${120-i*10},220,0.8)`) }, hovertemplate: '%{x}<br>%{y:.2f}% of portfolio<extra></extra>' };
  const layout = { title: { text:'Allocation (% of portfolio)' }, margin: { l: 40, r: 10, t: 36, b: 120 }, xaxis: { tickangle: -25 }, yaxis: { range:[0,100] }, height: 420 };
  Plotly.newPlot(allocChartDiv, [trace], layout, {responsive:true, displayModeBar:true});
}

function drawTimeSeries(history) {
  const t = history.map(h => h.quarter);
  const traces = [];
  const n = PB_NAMES.length;
  // choose diverse color palette
  const palette = ['#0ea5a4','#7c3aed','#06b6d4','#f97316','#ef4444','#10b981','#c084fc','#f59e0b','#60a5fa'];
  for (let k=0;k<n;k++){
    traces.push({
      x: t,
      y: history.map(h => h.B[k]),
      name: PB_NAMES[k],
      mode: 'lines+markers',
      line: { color: palette[k % palette.length], width: 2 },
      hovertemplate: `${PB_NAMES[k]}<br>Q%{x}: %{y:.4g}<extra></extra>`
    });
  }
  // shapes for thresholds
  const shapes = [];
  for (let k=0;k<n;k++){
    shapes.push({ type:'line', xref:'x', yref:'y', x0: Math.min(...t)-0.5, x1: Math.max(...t)+0.5, y0: PB_THRESHOLDS[k], y1: PB_THRESHOLDS[k], line:{color:'#ef4444', width:1, dash:'dash'}});
  }
  const layout = { title: { text:'Boundary Stocks B_k(t) over quarters' }, height: 420, legend: { orientation:'h' } };
  Plotly.newPlot(tsChartDiv, traces, layout, {responsive:true, displayModeBar:true});
}

function drawSensitivityHeatmap(S) {
  const z = S;
  const data = [{
    z: z,
    x: INDUSTRIES,
    y: PB_NAMES,
    type: 'heatmap',
    colorscale: 'RdBu',
    zmid: 0,
    hovertemplate: '<b>%{y}</b><br>Industry: %{x}<br>Δ intensity: %{z:.4g} per $1M<extra></extra>'
  }];
  const layout = { title: { text:'Sensitivity ∂P_k / ∂Revenue_j (units per $1M)' }, margin: { l: 260 }, height: 420 };
  Plotly.newPlot(sensitivityHeatmapDiv, data, layout, {responsive:true, displayModeBar:true});
}

/* -------------------------- Update logic & UI wiring -------------------------- */
// NOTE: since per-industry sliders are not in the UI, the getRawValuesFromSliders uses a simple default allocation placeholder
function getRawValuesFromSliders() {
  // build simple default proportional allocation if not present: evenly split
  return new Array(INDUSTRIES.length).fill(100 / INDUSTRIES.length);
}

function updateFromSliders() {
  const raw = getRawValuesFromSliders();
  const fracs = normalizeAlloc(raw);
  const revenueM = fracs.map(f => f * TOTAL_CAPITAL_M);
  const { pbPer1M } = computeFluxes(revenueM, lastRevenueM);
  const pbPer1M_eff = applyPBCoupling(pbPer1M);
  const roi = computeROI(revenueM, currentStocks);
  roiBox.innerText = `${roi.toFixed(2)}% (annual avg)`;
  drawPBChart(pbPer1M_eff);
  drawAllocChart(revenueM);
  lastRevenueM = revenueM.slice();
  const ratios = percentOfThreshold(pbPer1M_eff);
  const summary = PB_NAMES.map((n,i)=> `${n}: ${pbPer1M_eff[i].toExponential(3)} / $1M (${ratios[i] !== null ? (ratios[i]*100).toFixed(1)+'%' : 'n/a'}) ${ratios[i]>=1 ? '⚠️' : ''}`).join('\n');
  simLog.textContent = summary;
}

/* -------------------------- Mitigation UI build -------------------------- */
function buildMitigationUI() {
  mitigationControls.innerHTML = '';
  mitigationPct = mitigationPct.slice(0, PB_NAMES.length);
  for (let k=0;k<PB_NAMES.length;k++){
    const wrap = document.createElement('div'); wrap.className = 'mit-row';
    const lbl = document.createElement('div'); lbl.className = 'mit-label'; lbl.innerText = PB_NAMES[k];
    const range = document.createElement('input'); range.type='range'; range.min=0; range.max=100; range.step=1; range.value = Math.round((mitigationPct[k]||0)*100);
    const out = document.createElement('div'); out.className = 'mit-out'; out.innerText = (Math.round((mitigationPct[k]||0)*100)) + '%';
    range.addEventListener('input', ()=> { mitigationPct[k] = parseFloat(range.value)/100.0; out.innerText = range.value + '%'; updateFromSliders(); });
    wrap.appendChild(lbl); wrap.appendChild(range); wrap.appendChild(out);
    mitigationControls.appendChild(wrap);
  }
}

/* -------------------------- CSV loader & snapshot -------------------------- */
betaFileInput.addEventListener('change', (e)=> {
  const file = e.target.files[0]; if(!file) return;
  Papa.parse(file, { header:false, dynamicTyping:true, skipEmptyLines:true, complete: (results)=> {
    const data = results.data.map(r => r.slice(0, PB_NAMES.length).map(Number));
    if (data.length===0) { alert('No rows found'); return; }
    if (data.length !== INDUSTRIES.length) {
      if (!confirm(`CSV has ${data.length} rows but expected ${INDUSTRIES.length}. Replace industries with generic names?`)) return;
      INDUSTRIES = data.map((_,i)=>`Industry ${i+1}`);
    }
    INTENSITY = data;
    buildMitigationUI();
    updateFromSliders();
    alert(`Loaded beta matrix with ${INTENSITY.length} rows.`);
  }, error: (err)=>{ console.error(err); alert('Failed to parse CSV'); }});
});

document.getElementById('export-json').addEventListener('click', ()=> {
  const payload = { timestamp: new Date().toISOString(), industries: INDUSTRIES, intensity: INTENSITY, mitigationPct, supplyChainMult, reboundElasticity, scenarioQuarters };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type:'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download='snapshot_networked.json'; a.click(); URL.revokeObjectURL(a.href);
});
document.getElementById('import-json-btn').addEventListener('click', ()=> document.getElementById('import-json').click());
importInput.addEventListener('change', async (e)=> {
  const f = e.target.files[0]; if(!f) return;
  const txt = await f.text();
  try {
    const obj = JSON.parse(txt);
    if (obj.intensity && obj.industries) {
      INDUSTRIES = obj.industries; INTENSITY = obj.intensity; mitigationPct = obj.mitigationPct || mitigationPct;
      supplyChainMult = obj.supplyChainMult || supplyChainMult;
      reboundElasticity = obj.reboundElasticity || reboundElasticity;
      buildMitigationUI();
      scenarioQuarters = obj.scenarioQuarters || [];
      quarterCountSpan.innerText = scenarioQuarters.length;
      updateFromSliders();
      alert('Imported snapshot');
    } else {
      alert('Invalid snapshot');
    }
  } catch(err) { alert('Invalid JSON'); }
});

/* -------------------------- Scenario timeline (stamping only) -------------------------- */
addQuarterBtn.addEventListener('click', ()=> {
  // stamp current (default/synthetic) allocation
  const raw = getRawValuesFromSliders();
  scenarioQuarters.push(raw.slice());
  quarterCountSpan.innerText = scenarioQuarters.length;
});
removeQuarterBtn.addEventListener('click', ()=> {
  scenarioQuarters.pop();
  quarterCountSpan.innerText = scenarioQuarters.length;
});
clearQuartersBtn.addEventListener('click', ()=> {
  scenarioQuarters = []; quarterCountSpan.innerText = '0';
});

/* -------------------------- Simulation (per-quarter allocations) -------------------------- */
function make_flux_func_fromScenario(scenario) {
  const precomputed = scenario.map(raw => {
    const fracs = normalizeAlloc(raw);
    const rev = fracs.map(f => f * TOTAL_CAPITAL_M);
    const { pbTotals } = computeFluxes(rev, null);
    return pbTotals;
  });
  return function(qIndex, t, B) {
    const idx = Math.min(qIndex, precomputed.length - 1);
    return precomputed[idx].slice();
  };
}

function simulateScenarioUsingTimeline(useScenario = true, maxQuarters = 8) {
  const timeline = scenarioQuarters.length>0 ? scenarioQuarters : [ getRawValuesFromSliders() ];
  const fluxFunc = make_flux_func_fromScenario(timeline);
  const dt = parseFloat(dtInput.value) || 0.25;
  const regenFraction = parseFloat(regenSlider.value) || 0.05;
  const integrator = integratorSelect.value || 'RK4';
  let B = currentStocks.slice();
  const history = [];
  for (let q=0; q<maxQuarters; q++){
    const qIndex = q % timeline.length;
    const quarterFluxFunc = (tcur, Bcur) => fluxFunc(qIndex, tcur, Bcur);
    if (integrator === 'RK4') B = rk4_step(B, q, dt, quarterFluxFunc, regenFraction);
    else B = euler_step(B, q, dt, quarterFluxFunc, regenFraction);
    history.push({ quarter: q+1, B: B.slice(), breaches: B.map((b,k)=> b > PB_THRESHOLDS[k]) });
    currentStocks = B.slice();
  }
  return { history };
}

/* -------------------------- Simulation UI wiring -------------------------- */
simulateBtn.addEventListener('click', ()=> {
  const out = simulateScenarioUsingTimeline(false, 8);
  simLog.textContent = out.history.map(r => `Q${r.quarter}: breaches=${r.breaches.filter(Boolean).length}`).join('\n');
  drawTimeSeries(out.history);
});
simulate24Btn.addEventListener('click', ()=> {
  const out = simulateScenarioUsingTimeline(false, 24);
  simLog.textContent = out.history.map(r => `Q${r.quarter}: breaches=${r.breaches.filter(Boolean).length}`).join('\n');
  drawTimeSeries(out.history);
});
simulateScenarioBtn.addEventListener('click', ()=> {
  if (scenarioQuarters.length === 0 && !confirm('No quarters stamped. Run repeating current allocation?')) return;
  const out = simulateScenarioUsingTimeline(true, Math.max(8, scenarioQuarters.length));
  simLog.textContent = out.history.map(r => `Q${r.quarter}: breaches=${r.breaches.filter(Boolean).length}`).join('\n');
  drawTimeSeries(out.history);
});
clearLogBtn.addEventListener('click', ()=> simLog.textContent = '');

/* -------------------------- Sensitivity (numerical) -------------------------- */
function computeSensitivityMatrix(deltaRev = 0.1) {
  const raw = getRawValuesFromSliders();
  const fracs = normalizeAlloc(raw);
  const baseRev = fracs.map(f => f * TOTAL_CAPITAL_M);
  const { pbPer1M: basePk } = computeFluxes(baseRev, lastRevenueM);
  const basePkEff = applyPBCoupling(basePk);
  const N = INDUSTRIES.length, K = PB_NAMES.length;
  const S = Array.from({length:K}, ()=> new Array(N).fill(0));
  for (let j=0;j<N;j++){
    const pertRev = baseRev.slice(); pertRev[j] += deltaRev;
    const { pbPer1M: pertPk } = computeFluxes(pertRev, baseRev);
    const pertPkEff = applyPBCoupling(pertPk);
    for (let k=0;k<K;k++){
      S[k][j] = (pertPkEff[k] - basePkEff[k]) / deltaRev;
    }
  }
  return { S, basePkEff, baseRev };
}

computeSensitivityBtn.addEventListener('click', ()=> {
  const { S } = computeSensitivityMatrix(0.1);
  drawSensitivityHeatmap(S);
  // prepare download
  downloadSensitivityBtn.onclick = ()=> {
    const rows = [];
    rows.push(['PB \\ Industry', ...INDUSTRIES]);
    for (let k=0;k<S.length;k++) rows.push([PB_NAMES[k], ...S[k].map(v=>v.toExponential(6))]);
    const csv = rows.map(r=> r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'sensitivity.csv'; a.click(); URL.revokeObjectURL(a.href);
  };
});

/* -------------------------- Init -------------------------- */
function init() {
  buildMitigationUI();
  regenOutput.value = parseFloat(regenSlider.value).toFixed(3);
  regenSlider.addEventListener('input', ()=> regenOutput.value = parseFloat(regenSlider.value).toFixed(3));
  etaVal.value = parseFloat(etaInput.value).toFixed(2);
  etaInput.addEventListener('input', ()=> etaVal.value = parseFloat(etaInput.value).toFixed(2));
  updateFromSliders();
}
window.addEventListener('load', init);
