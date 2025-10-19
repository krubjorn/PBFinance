/* app.js — improved planetary-pressure model with UI controls for regenFraction, integrator and dt.
   Replace your existing app.js with this file.
*/

// ---------------------- Config & sample data ----------------------
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

const PB_THRESHOLDS = [
  188.5,
  0.00000013,
  161.0,
  3000.0,
  33.0,
  81408.0,
  0.0370,
  2.48,
  3000.0
];

let INDUSTRIES = [
  "Renewable Energy",
  "Fossil Fuels",
  "Agriculture",
  "Mining & Materials",
  "Manufacturing",
  "Waste & Env Services",
  "Reforestation & Conservation"
];

const R0 = [6.0, 8.0, 5.0, 7.0, 6.5, 4.5, 3.5];

let INTENSITY = [
  [20.0, 1e-9, 10.0, 100.0, 1.0, 500.0, 0.005, 0.01, 50.0],
  [900.0, 1e-7, 5.0, 500.0, 5.0, 1000.0, 0.02, 0.5, 400.0],
  [150.0, 1e-6, 900.0, 800.0, 20.0, 30000.0, 0.005, 0.005, 200.0],
  [300.0, 1e-6, 20.0, 700.0, 10.0, 2000.0, 0.003, 0.2, 500.0],
  [200.0, 5e-7, 50.0, 900.0, 2.0, 400.0, 0.008, 0.1, 350.0],
  [120.0, 2e-7, 10.0, 300.0, 1.0, 800.0, 0.002, 0.02, 100.0],
  [-50.0, -1e-6, -2.0, 10.0, -15.0, 50.0, -0.001, 0.0, 5.0]
];

const TOTAL_CAPITAL_M = 100.0;
const DEFAULT_RAW_ALLOC = [15, 25, 15, 10, 20, 5, 10];

// Defaults for integrator UI (tuned from elements)
let UI = {
  regenFraction: 0.05,
  integrator: 'RK4',
  dt: 0.25
};

// ---------------------- Model functions ----------------------
function normalizeAlloc(raw) {
  const clipped = raw.map(x => Math.max(0, Number(x) || 0));
  const sum = clipped.reduce((a,b) => a + b, 0);
  if (sum <= 0) return new Array(clipped.length).fill(1 / clipped.length);
  return clipped.map(x => x / sum);
}

function computePortfolio(revenueM) {
  const totalRev = revenueM.reduce((a,b) => a + b, 0) || 1e-9;
  const pbTotals = PB_NAMES.map(_ => 0.0);
  for (let i = 0; i < INDUSTRIES.length; i++) {
    const rev = revenueM[i] || 0;
    for (let k = 0; k < PB_NAMES.length; k++) {
      const intensity_ik = (INTENSITY[i] && INTENSITY[i][k] !== undefined) ? Number(INTENSITY[i][k]) : 0.0;
      pbTotals[k] += intensity_ik * rev;
    }
  }
  const pbPer1M = pbTotals.map(t => t / totalRev);
  const weights = revenueM.map(r => r / totalRev);
  const roi = weights.reduce((acc,w,i) => acc + w * (R0[i] ?? 5.0), 0);
  return { roi, pbPer1M, pbTotals, totalRev };
}

function percentOfThreshold(pbPer1M) {
  return pbPer1M.map((p,k) => {
    const thr = PB_THRESHOLDS[k];
    if (!isFinite(thr) || thr === 0) return null;
    return p / thr;
  });
}

function colorForRatio(ratio) {
  if (ratio === null) return 'gray';
  if (ratio >= 1.0) return 'red';
  if (ratio >= 0.8) return 'orange';
  return 'green';
}

// ---------------------- ODE helpers ----------------------
function derivs_from_flux(B, t, flux_in_per_year, regenFraction, mitigation) {
  const K = PB_NAMES.length;
  const dB = new Array(K).fill(0.0);
  for (let k = 0; k < K; k++) {
    const regen = regenFraction * PB_THRESHOLDS[k];
    const mit = (mitigation && mitigation[k]) ? mitigation[k] : 0.0;
    dB[k] = (flux_in_per_year[k] || 0) - regen - mit;
  }
  return dB;
}

function rk4_step(B, t, dt, flux_func, regenFraction, mitigation) {
  const K = PB_NAMES.length;
  const k1_flux = flux_func(t, B);
  const k1 = derivs_from_flux(B, t, k1_flux, regenFraction, mitigation);
  const addScaled = (a, karr, scale) => a.map((v,i) => v + karr[i]*scale);
  const Bk2 = addScaled(B, k1, dt/2);
  const k2_flux = flux_func(t + dt/2, Bk2);
  const k2 = derivs_from_flux(Bk2, t + dt/2, k2_flux, regenFraction, mitigation);
  const Bk3 = addScaled(B, k2, dt/2);
  const k3_flux = flux_func(t + dt/2, Bk3);
  const k3 = derivs_from_flux(Bk3, t + dt/2, k3_flux, regenFraction, mitigation);
  const Bk4 = addScaled(B, k3, dt);
  const k4_flux = flux_func(t + dt, Bk4);
  const k4 = derivs_from_flux(Bk4, t + dt, k4_flux, regenFraction, mitigation);
  const next = new Array(K);
  for (let i=0;i<K;i++){
    next[i] = B[i] + dt*(k1[i] + 2*k2[i] + 2*k3[i] + k4[i]) / 6.0;
  }
  return next;
}

function euler_step(B, t, dt, flux_func, regenFraction, mitigation) {
  const flux = flux_func(t, B);
  const dB = derivs_from_flux(B, t, flux, regenFraction, mitigation);
  return B.map((b,i) => b + dt * dB[i]);
}

// ---------------------- UI wiring & plotting ----------------------
const slidersContainer = document.getElementById("alloc-sliders");
const roiBox = document.getElementById("roi-value");
const betaFileInput = document.getElementById("beta-file");
const exportBtn = document.getElementById("export-json");
const importInput = document.getElementById("import-json");
const importBtn = document.getElementById("import-json-btn");
const simLog = document.getElementById("simulation-log");
const simulateBtn = document.getElementById("simulate-quarters");
const simulate24Btn = document.getElementById("simulate-quarters-24");
const clearLogBtn = document.getElementById("clear-log");

// New controls
const regenSlider = document.getElementById("regen-fraction");
const regenOutput = document.getElementById("regen-fraction-val");
const integratorSelect = document.getElementById("integrator-select");
const dtInput = document.getElementById("dt-input");

function createSlider(i, value) {
  const row = document.createElement("div");
  row.className = "slider-row";
  const label = document.createElement("label");
  label.innerText = INDUSTRIES[i];
  label.className = "slider-label";
  label.setAttribute('aria-label', INDUSTRIES[i]);
  const valDisplay = document.createElement("span");
  valDisplay.className = "slider-value";
  valDisplay.innerText = value.toFixed(1);
  const input = document.createElement("input");
  input.type = "range"; input.min = 0; input.max = 100; input.step = 0.5; input.value = value; input.className = "slider";
  input.setAttribute('aria-valuemin','0'); input.setAttribute('aria-valuemax','100'); input.setAttribute('aria-valuenow',value.toString());
  input.addEventListener("input", ()=>{ valDisplay.innerText = parseFloat(input.value).toFixed(1); input.setAttribute('aria-valuenow', input.value.toString()); updateFromSliders(); });
  row.appendChild(label); row.appendChild(input); row.appendChild(valDisplay); slidersContainer.appendChild(row);
  return input;
}

let sliderInputs = [];
function buildSliders(initialRaw = DEFAULT_RAW_ALLOC) {
  slidersContainer.innerHTML = "";
  sliderInputs = [];
  for (let i = 0; i < INDUSTRIES.length; i++) {
    const val = (initialRaw[i] !== undefined) ? initialRaw[i] : (100/INDUSTRIES.length);
    sliderInputs.push(createSlider(i, val));
  }
}

function drawPBChart(pbPer1M) {
  const ratios = percentOfThreshold(pbPer1M);
  const colors = ratios.map(r => colorForRatio(r));
  const traceBars = {
    x: pbPer1M,
    y: PB_NAMES,
    orientation: 'h',
    type: 'bar',
    marker: { color: colors },
    hovertemplate: '%{y}<br>Intensity: %{x:.4g} per $1M<br>Threshold: %{customdata}<extra></extra>',
    customdata: PB_THRESHOLDS
  };
  const thrTrace = {
    x: PB_THRESHOLDS,
    y: PB_NAMES,
    type: 'scatter',
    mode: 'markers',
    marker: { color: 'red', symbol: 'triangle-right', size: 12 },
    hoverinfo: 'x+y',
    showlegend: false
  };
  const layout = {
    title: 'Planetary Boundary Pressures (per $1M revenue)',
    margin: { l: 320, r: 40, t: 40, b: 40 },
    xaxis: { title: 'Intensity per $1M' },
    height: Math.max(520, PB_NAMES.length * 40)
  };
  Plotly.newPlot('pb-chart', [traceBars, thrTrace], layout, {responsive:true});
}

function drawAllocChart(revenueM) {
  const total = revenueM.reduce((a,b)=>a+b,0) || 1e-9;
  const percent = revenueM.map(r => (r/total)*100);
  const trace = { x: INDUSTRIES, y: percent, type: 'bar', marker: { color: 'rgb(100,150,240)' }, hovertemplate: '%{x}<br>%{y:.2f}% of portfolio<extra></extra>' };
  const layout = { title: 'Allocation (% of portfolio)', margin: { l: 40, r: 20, t: 36, b: 120 }, xaxis: { tickangle: -30 }, yaxis: { range: [0,100] }, height: 320 };
  Plotly.newPlot('alloc-chart', [trace], layout, {responsive:true});
}

function getRawValuesFromSliders() { return sliderInputs.map(s => parseFloat(s.value)); }

function updateFromSliders() {
  const raw = getRawValuesFromSliders();
  const fracs = normalizeAlloc(raw);
  const revenueM = fracs.map(f => f * TOTAL_CAPITAL_M);
  const { roi, pbPer1M, pbTotals } = computePortfolio(revenueM);
  roiBox.innerText = `${roi.toFixed(2)}% (annual avg)`;
  drawPBChart(pbPer1M);
  drawAllocChart(revenueM);
  const ratios = percentOfThreshold(pbPer1M);
  const summary = PB_NAMES.map((n,i) => {
    const r = ratios[i];
    return `${n}: ${pbPer1M[i].toExponential(3)} per $1M (${r !== null ? (r*100).toFixed(1) + '%' : 'n/a'}) ${r >= 1 ? '⚠️ BREACHED' : ''}`;
  }).join('\n');
  simLog.dataset.summary = summary;
}

betaFileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  Papa.parse(file, { header:false, dynamicTyping:true, skipEmptyLines:true,
    complete: (results) => {
      const data = results.data.map(r => r.slice(0, PB_NAMES.length).map(Number));
      if (data.length === 0) { alert('No rows found in CSV'); return; }
      if (data.length !== INDUSTRIES.length) {
        if (!confirm(`CSV has ${data.length} rows but expected ${INDUSTRIES.length}. Replace industries with generic names?`)) return;
        INDUSTRIES = data.map((_, i) => `Industry ${i+1}`);
      }
      INTENSITY = data;
      buildSliders(new Array(INDUSTRIES.length).fill(100 / INDUSTRIES.length));
      updateFromSliders();
      alert(`Loaded beta matrix with ${INTENSITY.length} rows and ${PB_NAMES.length} columns.`);
    },
    error: (err) => { console.error(err); alert('Failed to parse CSV'); }
  });
});

exportBtn.addEventListener('click', () => {
  const raw = getRawValuesFromSliders();
  const fracs = normalizeAlloc(raw);
  const payload = { timestamp: new Date().toISOString(), raw, fracs, industries: INDUSTRIES, intensity: INTENSITY };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'planetary_portfolio_snapshot.json'; a.click(); URL.revokeObjectURL(url);
});
importBtn.addEventListener('click', () => importInput.click());
importInput.addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const text = await f.text();
  try {
    const obj = JSON.parse(text);
    if (obj.raw && obj.raw.length === INDUSTRIES.length) {
      sliderInputs.forEach((s,i)=>s.value = obj.raw[i]);
      document.querySelectorAll('.slider-value').forEach((el,i)=>el.innerText = parseFloat(obj.raw[i]).toFixed(1));
      updateFromSliders(); alert('Imported allocation snapshot');
    } else if (obj.intensity && obj.industries) {
      INDUSTRIES = obj.industries; INTENSITY = obj.intensity;
      buildSliders(obj.raw || new Array(INDUSTRIES.length).fill(0)); updateFromSliders(); alert('Imported full snapshot with intensity matrix');
    } else { alert('Invalid snapshot: industry mismatch or missing data'); }
  } catch(err) { alert('Invalid JSON file'); }
});

// ---------------- Simulation wiring (respects UI controls) ----------------
function make_flux_func_fixedAlloc(revenueM) {
  const { pbTotals } = computePortfolio(revenueM);
  return function(t,B) { return pbTotals.slice(); };
}

function simulateQuarters(numQuarters = 8) {
  const raw = getRawValuesFromSliders();
  const fracs = normalizeAlloc(raw);
  const revenueM = fracs.map(f => f * TOTAL_CAPITAL_M);
  let B = PB_THRESHOLDS.map(t => 0.5 * t);
  const dt = parseFloat(dtInput.value) || UI.dt;
  const regenFraction = parseFloat(regenSlider.value) || UI.regenFraction;
  const integrator = integratorSelect.value || UI.integrator;
  const fluxFunc = make_flux_func_fixedAlloc(revenueM);
  const mitigation = null;
  const history = [];
  let t = 0;
  for (let q = 1; q <= numQuarters; q++) {
    if (integrator === 'RK4') {
      B = rk4_step(B, t, dt, fluxFunc, regenFraction, mitigation);
    } else {
      B = euler_step(B, t, dt, fluxFunc, regenFraction, mitigation);
    }
    t += dt;
    const breaches = B.map((b,k) => b > PB_THRESHOLDS[k]);
    history.push({ quarter: q, B: B.slice(), breaches });
  }
  return { history, revenueM, params: { dt, regenFraction, integrator } };
}

simulateBtn.addEventListener('click', () => {
  const out = simulateQuarters(8);
  simLog.textContent = out.history.map(row => {
    const breaches = row.breaches.map((b,i)=> b? PB_NAMES[i] : null).filter(Boolean);
    return `Q${row.quarter}: breaches=${breaches.length} ${breaches.length ? '('+breaches.join(', ')+')' : ''}`;
  }).join('\n\n');
  simLog.textContent = (simLog.dataset.summary ? simLog.dataset.summary + '\n\n' : '') + `Params: dt=${out.params.dt}, regen=${out.params.regenFraction}, integrator=${out.params.integrator}\n\n` + simLog.textContent;
});

simulate24Btn.addEventListener('click', () => {
  const out = simulateQuarters(24);
  simLog.textContent = out.history.map(row => {
    const breaches = row.breaches.map((b,i)=> b? PB_NAMES[i] : null).filter(Boolean);
    return `Q${row.quarter}: breaches=${breaches.length} ${breaches.length ? '('+breaches.join(', ')+')' : ''}`;
  }).join('\n\n');
  simLog.textContent = (simLog.dataset.summary ? simLog.dataset.summary + '\n\n' : '') + `Params: dt=${out.params.dt}, regen=${out.params.regenFraction}, integrator=${out.params.integrator}\n\n` + simLog.textContent;
});

clearLogBtn.addEventListener('click', () => { simLog.textContent = simLog.dataset.summary || ''; });

// presets
document.getElementById("randomize").addEventListener("click", () => {
  const vals = INDUSTRIES.map(()=>Math.random()*100);
  sliderInputs.forEach((s,i)=>s.value = vals[i]);
  document.querySelectorAll(".slider-value").forEach((el,i)=>el.innerText = parseFloat(vals[i]).toFixed(1));
  updateFromSliders();
});

document.getElementById("preset-sustainable").addEventListener("click", () => {
  const preset = new Array(INDUSTRIES.length).fill(0);
  INDUSTRIES.forEach((name,i)=> {
    if (/renewable/i.test(name)) preset[i]=30;
    else if (/reforest|conserv/i.test(name)) preset[i]=15;
    else if (/waste/i.test(name)) preset[i]=10;
    else preset[i]=(100/INDUSTRIES.length);
  });
  sliderInputs.forEach((s,i)=>s.value = preset[i]);
  document.querySelectorAll(".slider-value").forEach((el,i)=>el.innerText = parseFloat(preset[i]).toFixed(1));
  updateFromSliders();
});

document.getElementById("preset-bau").addEventListener("click", () => {
  const preset = INDUSTRIES.map(name => {
    if (/fossil/i.test(name)) return 40;
    if (/agric/i.test(name)) return 20;
    return 100/INDUSTRIES.length;
  });
  sliderInputs.forEach((s,i)=>s.value = preset[i]);
  document.querySelectorAll(".slider-value").forEach((el,i)=>el.innerText = parseFloat(preset[i]).toFixed(1));
  updateFromSliders();
});

document.getElementById("reset").addEventListener("click", () => {
  const raw = DEFAULT_RAW_ALLOC.slice(0, INDUSTRIES.length);
  if (raw.length !== INDUSTRIES.length) {
    buildSliders(new Array(INDUSTRIES.length).fill(100/INDUSTRIES.length));
  } else {
    sliderInputs.forEach((s,i)=>s.value = raw[i]);
    document.querySelectorAll(".slider-value").forEach((el,i)=>el.innerText = raw[i].toFixed(1));
  }
  updateFromSliders();
});

// ---------------------- UI control reactions ----------------------
regenSlider.addEventListener('input', () => {
  const v = parseFloat(regenSlider.value);
  regenOutput.value = v.toFixed(3);
});

integratorSelect.addEventListener('change', () => {
  // nothing else needed — simulations read current value
});

dtInput.addEventListener('change', () => {
  let val = parseFloat(dtInput.value);
  if (isNaN(val) || val <= 0) { dtInput.value = UI.dt; }
});

// ---------------------- Init ----------------------
function init() {
  buildSliders(DEFAULT_RAW_ALLOC);
  regenOutput.value = parseFloat(regenSlider.value).toFixed(3);
  updateFromSliders();
}
window.addEventListener('load', init);
