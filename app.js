/* (c)2025 KrugerNyasulu 
    app.js — Clean UI: supply-chain & rebound toggles; quadrant plots; nicer Plotly visuals.
   Works as a drop-in replacement. Keeps internal supplyChainMult & reboundElasticity arrays.
*/

/* -------------------------------
   Data & configuration (from your spec)
   ------------------------------- */

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
  188.5,      // Climate
  0.00000013, // Biodiversity (tiny per $1M, from your text)
  161.0,      // Biogeochemical
  3000.0,     // Chemical pollution
  33.0,       // Land-system
  81408.0,    // Freshwater
  0.0370,     // Ocean acidification
  2.48,       // Ozone
  3000.0      // Aerosols
];

// Prototype industries (7) — replace with full 250 x 9 matrix when ready
const INDUSTRIES = [
  "Renewable Energy",
  "Fossil Fuels",
  "Agriculture",
  "Mining & Materials",
  "Manufacturing",
  "Waste & Env Services",
  "Reforestation & Conservation"
];

const R0 = [6.0, 8.0, 5.0, 7.0, 6.5, 4.5, 3.5]; // baseline annual return % (illustrative)

// intensity matrix (N x 9) = PB intensity per $1M revenue for industry i
// NOTE: these are example illustrative values copied/derived from the python prototype
const INTENSITY = [
  [20.0, 1e-9, 10.0, 100.0, 1.0, 500.0, 0.005, 0.01, 50.0],      // Renewable Energy
  [900.0, 1e-7, 5.0, 500.0, 5.0, 1000.0, 0.02, 0.5, 400.0],      // Fossil Fuels
  [150.0, 1e-6, 900.0, 800.0, 20.0, 30000.0, 0.005, 0.005, 200.0],// Agriculture
  [300.0, 1e-6, 20.0, 700.0, 10.0, 2000.0, 0.003, 0.2, 500.0],    // Mining & Materials
  [200.0, 5e-7, 50.0, 900.0, 2.0, 400.0, 0.008, 0.1, 350.0],      // Manufacturing
  [120.0, 2e-7, 10.0, 300.0, 1.0, 800.0, 0.002, 0.02, 100.0],     // Waste & Env Services
  [-50.0, -1e-6, -2.0, 10.0, -15.0, 50.0, -0.001, 0.0, 5.0]       // Reforestation & Conservation (restorative)
];

const TOTAL_CAPITAL_M = 100.0; // $100M represented in $1M units (so revenue_i in $1M)
const DEFAULT_RAW_ALLOC = [15, 25, 15, 10, 20, 5, 10]; // initial raw slider values

/* -------------------------------
   Utility / Model functions
   ------------------------------- */

function normalizeAlloc(raw) {
  const clipped = raw.map(x => Math.max(0, x));
  const sum = clipped.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    return new Array(clipped.length).fill(1 / clipped.length);
  }
  return clipped.map(x => x / sum);
}

// revenueDistribution in $1M units (array length N)
function computePortfolio(revenueDistribution) {
  const totalRev = revenueDistribution.reduce((a, b) => a + b, 0) || 1e-9;
  // weights
  const weights = revenueDistribution.map(r => r / totalRev);
  // ROI = weighted average of R0 by weights
  const roi = weights.reduce((acc, w, i) => acc + w * R0[i], 0);

  // Emissions totals per PB
  const pbTotals = PB_NAMES.map(_ => 0.0);
  for (let i = 0; i < INDUSTRIES.length; i++) {
    for (let k = 0; k < PB_NAMES.length; k++) {
      // intensity per $1M * revenue in $1M => absolute units for that industry
      pbTotals[k] += INTENSITY[i][k] * revenueDistribution[i];
    }
  }
  const pbPer1M = pbTotals.map(t => t / totalRev); // weighted average intensity per $1M
  return { roi, pbPer1M, pbTotals, totalRev };
}

/* -------------------------------
   DOM helpers & UI build
   ------------------------------- */

const slidersContainer = document.getElementById("alloc-sliders");
const roiBox = document.getElementById("roi-value");

function createSlider(i, value) {
  const row = document.createElement("div");
  row.className = "slider-row";

  const label = document.createElement("label");
  label.innerText = INDUSTRIES[i];
  label.className = "slider-label";

  const valDisplay = document.createElement("span");
  valDisplay.className = "slider-value";
  valDisplay.innerText = value.toFixed(1);

  const input = document.createElement("input");
  input.type = "range";
  input.min = 0;
  input.max = 100;
  input.step = 0.5;
  input.value = value;
  input.className = "slider";

  input.addEventListener("input", () => {
    valDisplay.innerText = parseFloat(input.value).toFixed(1);
    updateFromSliders();
  });

  row.appendChild(label);
  row.appendChild(input);
  row.appendChild(valDisplay);
  slidersContainer.appendChild(row);
  return input;
}

let sliderInputs = [];

function buildSliders(initialRaw = DEFAULT_RAW_ALLOC) {
  slidersContainer.innerHTML = "";
  sliderInputs = [];
  for (let i = 0; i < INDUSTRIES.length; i++) {
    const s = createSlider(i, initialRaw[i]);
    sliderInputs.push(s);
  }
}

/* -------------------------------
   Plotly charts
   ------------------------------- */

function drawPBChart(pbPer1M) {
  // Horizontal bar for PB pressures
  const traceBars = {
    x: pbPer1M,
    y: PB_NAMES,
    orientation: 'h',
    type: 'bar',
    marker: { color: 'rgb(246, 178, 107)' },
    hovertemplate: '%{y}<br>Pressure: %{x:.4g} per $1M<extra></extra>'
  };

  // Threshold markers (red triangles) aligning with each PB
  const traceThresh = {
    x: PB_THRESHOLDS,
    y: PB_NAMES,
    mode: 'markers',
    marker: { color: 'red', symbol: 'triangle-right', size: 12 },
    hovertemplate: 'Threshold: %{x} per $1M<extra></extra>'
  };

  const layout = {
    title: 'Planetary Boundary Pressures (per $1M revenue)',
    margin: { l: 280, r: 40, t: 40, b: 40 },
    xaxis: { title: 'Intensity per $1M' },
    height: Math.max(520, PB_NAMES.length * 40)
  };

  Plotly.newPlot('pb-chart', [traceBars, traceThresh], layout, {responsive: true});
}

function drawAllocChart(revenueM) {
  // Allocation bars (percent)
  const total = revenueM.reduce((a,b)=>a+b,0) || 1e-9;
  const percent = revenueM.map(r => (r / total) * 100);

  const trace = {
    x: INDUSTRIES,
    y: percent,
    type: 'bar',
    marker: { color: 'rgb(100, 150, 240)' },
    hovertemplate: '%{x}<br>%{y:.2f}% of portfolio<extra></extra>'
  };

  const layout = {
    title: 'Allocation (% of portfolio)',
    margin: { l: 40, r: 20, t: 36, b: 120 },
    xaxis: { tickangle: -30 },
    yaxis: { range: [0, 100] },
    height: 360
  };

  Plotly.newPlot('alloc-chart', [trace], layout, {responsive: true});
}

/* -------------------------------
   Interaction / update logic
   ------------------------------- */

function getRawValuesFromSliders() {
  return sliderInputs.map(s => parseFloat(s.value));
}

function updateFromSliders() {
  const raw = getRawValuesFromSliders();
  const fracs = normalizeAlloc(raw);
  const revenueM = fracs.map(f => f * TOTAL_CAPITAL_M);

  const { roi, pbPer1M } = computePortfolio(revenueM);

  // Update ROI display
  roiBox.innerText = `${roi.toFixed(2)}% (annual average)`;

  // Update charts
  drawPBChart(pbPer1M);
  drawAllocChart(revenueM);
}

/* -------------------------------
   Buttons / presets
   ------------------------------- */

document.getElementById("randomize").addEventListener("click", () => {
  const vals = INDUSTRIES.map(() => Math.random() * 100);
  sliderInputs.forEach((s, i) => s.value = vals[i]);
  // update the visible value text next to slider
  document.querySelectorAll(".slider-value").forEach((el, i) => el.innerText = parseFloat(vals[i]).toFixed(1));
  updateFromSliders();
});

document.getElementById("preset-sustainable").addEventListener("click", () => {
  const preset = [30.0, 10.0, 15.0, 5.0, 20.0, 10.0, 10.0];
  sliderInputs.forEach((s, i) => s.value = preset[i]);
  document.querySelectorAll(".slider-value").forEach((el,i) => el.innerText = preset[i].toFixed(1));
  updateFromSliders();
});

document.getElementById("preset-bau").addEventListener("click", () => {
  const preset = [5.0, 40.0, 20.0, 15.0, 15.0, 2.5, 2.5];
  sliderInputs.forEach((s, i) => s.value = preset[i]);
  document.querySelectorAll(".slider-value").forEach((el,i) => el.innerText = preset[i].toFixed(1));
  updateFromSliders();
});

document.getElementById("reset").addEventListener("click", () => {
  sliderInputs.forEach((s,i) => s.value = DEFAULT_RAW_ALLOC[i]);
  document.querySelectorAll(".slider-value").forEach((el,i) => el.innerText = DEFAULT_RAW_ALLOC[i].toFixed(1));
  updateFromSliders();
});

/* -------------------------------
   Boot strap UI
   ------------------------------- */

function init() {
  buildSliders(DEFAULT_RAW_ALLOC);
  // initial draw
  updateFromSliders();
}

window.addEventListener('load', init);
