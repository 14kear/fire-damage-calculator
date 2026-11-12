'use strict';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SUB_DIGITS = '₀₁₂₃₄₅₆₇₈₉';
const toSub = n => String(n).replace(/\d/g, d => SUB_DIGITS[Number(d)]);
const fmt = (v, d = 3) => Number(v).toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: d });
const fmtFixed = (v, d = 3) => Number(v).toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });
const cleanNum = v => (Math.abs(Number(v)) < 1e-10 ? 0 : Number(Number(v).toFixed(6)));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const SHORT_LABELS = [
  'Количество погибших людей',
  'Количество травмированных людей',
  'Прямой ущерб от пожаров',
  'Неисправность производственного оборудования, нарушение техпроцесса',
  'Нарушение правил устройства и эксплуатации электрооборудования',
  'Нарушение правил устройства и эксплуатации газового оборудования',
  'Нарушение ПБ при проведении электрогазосварочных работ',
  'Взрывы',
  'Самовозгорание веществ и материалов',
  'Нарушение правил устройства и эксплуатации печей',
  'Нарушение правил устройства и эксплуатации теплогенерирующих установок',
  'Нарушение правил ПБ при проведении огневых работ',
  'Грозовые разряды',
  'Неустановленные причины',
  'Установленный поджог',
];

const PERT_LABELS = [
  'Объём аварийно-химически опасных веществ на предприятии',
  'Количество задействованных (доступных) сил пожарной охраны',
  'Климатический район предприятия',
  'Цены на оборудование',
  'Количество инструктажей пожарной безопасности',
];

const DEFAULT_PERTURBATIONS = [
  { a: 0.00, b: 0.05, c: 0.35 },
  { a: 0.00, b: 0.15, c: 0.30 },
  { a: 0.00, b: 0.00, c: 0.15 },
  { a: 0.00, b: 0.05, c: 0.15 },
  { a: 0.00, b: 0.10, c: 0.25 },
];

const LINE_COLORS = [
  '#1d4ed8', '#dc2626', '#15803d', '#b45309', '#7c3aed',
  '#0e7490', '#be185d', '#4d7c0f', '#9a3412', '#4338ca',
  '#0f766e', '#a21caf', '#b91c1c', '#374151', '#ca8a04',
];

const LINE_DASHES = [
  '', '7 3', '3 3', '10 3 2 3', '5 2',
  '', '8 3', '2 3', '9 3 2 3', '6 2',
  '', '7 3', '3 3', '10 3 2 3', '5 2',
];

const STORAGE_KEY = 'fire-calc-ideal-v2';

let D = null;
let BASE_FUNCS = {};
let currentResult = null;
let currentSeries = null;
let chartMode = 'all';

/* === ВВОД С ЖЁСТКИМ ОГРАНИЧЕНИЕМ [0, 1] === */
function attachClamp01(root = document) {
  $$('[data-clamp01]', root).forEach(el => {
    const minVal = el.dataset.clamp01 === 'min01' ? 0.1 : 0;
    el.addEventListener('keydown', e => {
      if (e.key === '-' || e.key === '+' || e.key === 'e' || e.key === 'E') {
        e.preventDefault();
      }
    });
    el.addEventListener('input', () => {
      let raw = el.value.replace(',', '.');
      if (raw === '' || raw === '0.' || raw === '0,') return;
      if (raw.startsWith('-')) {
        el.value = String(minVal);
        return;
      }
      const num = Number(raw);
      if (!Number.isFinite(num)) {
        el.value = String(minVal);
      } else if (num > 1) {
        el.value = '1';
      } else if (num < 0) {
        el.value = String(minVal);
      }
    });
    el.addEventListener('blur', () => {
      const raw = el.value.trim().replace(',', '.');
      let num = Number(raw);
      if (raw === '' || !Number.isFinite(num)) num = minVal;
      num = clamp(num, minVal, 1);
      el.value = String(Number(num.toFixed(4)));
    });
  });
}

/* === БАЗОВЫЕ ФУНКЦИИ ИЗ СТАТЬИ === */
function buildBaseFunctions() {
  const cat = D.function_catalogs.article;
  const out = {};
  for (let k = 1; k <= 78; k++) {
    const item = cat[String(k)];
    out[k] = {
      id: item.id,
      input: item.input,
      target: item.target,
      c2: cleanNum(item.c),
      c1: cleanNum(item.b),
      c0: cleanNum(item.a),
    };
  }
  return out;
}

/* === ФОРМИРОВАНИЕ HTML ИНТЕРФЕЙСА === */
function renderWorkspace() {
  // Наборы начальных условий
  const presetInit = $('#preset-initial');
  presetInit.innerHTML =
    `<option value="article">Исходные (2015 г. / статья)</option>` +
    D.years.map((y, idx) => `<option value="year-${idx}">${y} г. — статистика МЧС</option>`).join('') +
    `<option value="mean">Средние по статистике</option>` +
    `<option value="custom">Пользовательские / случайные</option>`;

  // Селектор показателя для серии
  $('#series-metric').innerHTML = SHORT_LABELS.map(
    (lbl, i) => `<option value="${i}">X${toSub(i + 1)} — ${esc(lbl)}</option>`
  ).join('');
  $('#series-metric').value = '2';

  // Таблица 15 характеристик X1..X15
  $('#params-tbody').innerHTML = SHORT_LABELS.map((lbl, i) => `
    <tr>
      <td><span class="var-badge">X<sub>${i + 1}</sub></span> ${esc(lbl)}</td>
      <td><input type="number" min="0" max="1" step="0.01" data-initial="${i}" data-clamp01="01" aria-label="Начальное условие X${i + 1}"></td>
      <td><input type="number" min="0" max="1" step="0.01" data-limit="${i}" data-clamp01="01" aria-label="Допустимое значение X${i + 1}"></td>
    </tr>
  `).join('');

  // Блок 5 возмущений E1..E5 (в порядке возрастания степеней t: c + b·t + a·t²)
  $('#perturbations-list').innerHTML = PERT_LABELS.map((lbl, m) => `
    <div class="pert-card">
      <div class="pert-title"><strong>E<sub>${m + 1}</sub>(t)</strong> — ${esc(lbl)}</div>
      <div class="poly-inline">
        <span class="lhs">E<sub>${m + 1}</sub>(t) =</span>
        <input type="number" min="0" max="1" step="0.01" data-pert-c="${m}" data-clamp01="01" aria-label="E${m + 1} свободный член">
        <span>+</span>
        <input type="number" min="0" max="1" step="0.01" data-pert-b="${m}" data-clamp01="01" aria-label="E${m + 1} коэффициент при t">
        <span>t +</span>
        <input type="number" min="0" max="1" step="0.01" data-pert-a="${m}" data-clamp01="01" aria-label="E${m + 1} коэффициент при t²">
        <span>t<sup>2</sup></span>
      </div>
    </div>
  `).join('');

  // Система 15 дифференциальных уравнений с нижними индексами
  $('#equations-list').innerHTML = D.equations.map((eq, i) => `
    <div class="eq-item">${equationHTML(i, eq)}</div>
  `).join('');

  // Сплошной список всех 78 функций f1..f78 в точном порядке статьи: f(X) = β₀ + β₁·X + β₂·X²
  let funcsHTML = '';
  for (let i = 0; i < 15; i++) {
    const eq = D.equations[i];
    const ids = [...eq.positive, ...eq.negative];
    funcsHTML += `<div class="func-group-header">Уравнение dX<sub>${i + 1}</sub>/dt — ${esc(SHORT_LABELS[i])}</div>`;
    for (const fid of ids) {
      const fn = BASE_FUNCS[fid];
      const xIdx = fn.input;
      funcsHTML += `
        <div class="func-row" data-func-row="${fid}">
          <span class="lhs" title="Влияние X${toSub(xIdx)} на X${toSub(fn.target)}">f<sub>${fid}</sub>(X<sub>${xIdx}</sub>) =</span>
          <input type="number" step="0.001" data-fn-c0="${fid}" aria-label="f${fid} свободный член">
          <span class="term-lbl">+</span>
          <input type="number" step="0.001" data-fn-c1="${fid}" aria-label="f${fid} коэффициент при X${xIdx}">
          <span class="term-lbl">X<sub>${xIdx}</sub> +</span>
          <input type="number" step="0.001" data-fn-c2="${fid}" aria-label="f${fid} коэффициент при X${xIdx}²">
          <span class="term-lbl">X<sub>${xIdx}</sub><sup>2</sup></span>
        </div>
      `;
    }
  }
  $('#functions-list').innerHTML = funcsHTML;

  attachClamp01(document);
}

function equationHTML(i, eq) {
  const fmtE = ids => ids.length === 1 ? `E<sub>${ids[0]}</sub>(t)` : `(${ids.map(m => `E<sub>${m}</sub>(t)`).join(' + ')})`;
  const posParts = eq.positive.map(k => `f<sub>${k}</sub>(X<sub>${BASE_FUNCS[k].input}</sub>)`);
  if (eq.external_positive.length) posParts.push(fmtE(eq.external_positive));
  const posStr = posParts.join(' · ') || '0';

  let negStr = '';
  if (eq.external_subtract.length) {
    negStr = fmtE(eq.external_subtract);
  } else if (eq.negative.length) {
    const negParts = eq.negative.map(k => `f<sub>${k}</sub>(X<sub>${BASE_FUNCS[k].input}</sub>)`);
    if (eq.external_negative.length) negParts.push(fmtE(eq.external_negative));
    negStr = negParts.join(' · ');
  }
  return `<strong>dX<sub>${i + 1}</sub>/dt</strong> = ${posStr}${negStr ? ' − ' + negStr : ''}`;
}

function equationPlain(i, eq) {
  const fmtE = ids => ids.length === 1 ? `E${toSub(ids[0])}(t)` : `(${ids.map(m => `E${toSub(m)}(t)`).join(' + ')})`;
  const posParts = eq.positive.map(k => `f${toSub(k)}(X${toSub(BASE_FUNCS[k].input)})`);
  if (eq.external_positive.length) posParts.push(fmtE(eq.external_positive));
  let negStr = '';
  if (eq.external_subtract.length) {
    negStr = fmtE(eq.external_subtract);
  } else if (eq.negative.length) {
    const negParts = eq.negative.map(k => `f${toSub(k)}(X${toSub(BASE_FUNCS[k].input)})`);
    if (eq.external_negative.length) negParts.push(fmtE(eq.external_negative));
    negStr = negParts.join(' · ');
  }
  return `dX${toSub(i + 1)}/dt = ${posParts.join(' · ') || '0'}${negStr ? ' − ' + negStr : ''}`;
}

/* === ЗАПОЛНЕНИЕ И СЧИТЫВАНИЕ ФОРМЫ === */
function fillParameters(params) {
  $('#duration').value = clamp(Number(params.duration ?? 1), 0.1, 1);
  const initVals = params.initial || D.article_initial;
  const limVals = params.limits || D.limits[2];
  const perts = params.perturbations || DEFAULT_PERTURBATIONS;
  const fnOverrides = params.functions || {};

  $$('[data-initial]').forEach((el, i) => {
    el.value = Number(clamp(Number(initVals[i] ?? 0.5), 0, 1).toFixed(4));
  });
  $$('[data-limit]').forEach((el, i) => {
    el.value = Number(clamp(Number(limVals[i] ?? 0.5), 0, 1).toFixed(3));
  });
  for (let m = 0; m < 5; m++) {
    const p = perts[m] || DEFAULT_PERTURBATIONS[m];
    $(`[data-pert-a="${m}"]`).value = Number(clamp(Number(p.a ?? 0), 0, 1).toFixed(3));
    $(`[data-pert-b="${m}"]`).value = Number(clamp(Number(p.b ?? 0), 0, 1).toFixed(3));
    $(`[data-pert-c="${m}"]`).value = Number(clamp(Number(p.c ?? 0), 0, 1).toFixed(3));
  }
  for (let k = 1; k <= 78; k++) {
    const ov = fnOverrides[k] || fnOverrides[String(k)];
    const base = BASE_FUNCS[k];
    $(`[data-fn-c0="${k}"]`).value = cleanNum(ov?.c0 ?? base.c0);
    $(`[data-fn-c1="${k}"]`).value = cleanNum(ov?.c1 ?? base.c1);
    $(`[data-fn-c2="${k}"]`).value = cleanNum(ov?.c2 ?? base.c2);
  }
  updateAllFuncHighlights();
}

function updateFuncRowHighlight(k) {
  const row = $(`[data-func-row="${k}"]`);
  if (!row) return;
  const base = BASE_FUNCS[k];
  const c0 = readNum($(`[data-fn-c0="${k}"]`), -1e4, 1e4, base.c0);
  const c1 = readNum($(`[data-fn-c1="${k}"]`), -1e4, 1e4, base.c1);
  const c2 = readNum($(`[data-fn-c2="${k}"]`), -1e4, 1e4, base.c2);
  const modified =
    Math.abs(c0 - base.c0) > 1e-5 ||
    Math.abs(c1 - base.c1) > 1e-5 ||
    Math.abs(c2 - base.c2) > 1e-5;
  row.classList.toggle('is-modified', modified);
}

function updateAllFuncHighlights() {
  for (let k = 1; k <= 78; k++) updateFuncRowHighlight(k);
}

function readNum(el, lo, hi, fallback = 0) {
  const raw = String(el.value).trim().replace(',', '.');
  const v = Number(raw);
  if (raw === '' || !Number.isFinite(v)) return fallback;
  return clamp(v, lo, hi);
}

function readParameters() {
  const duration = readNum($('#duration'), 0.1, 1, 1);
  $('#duration').value = Number(duration.toFixed(4));

  const initial = $$('[data-initial]').map(el => {
    const v = readNum(el, 0, 1, 0);
    el.value = Number(v.toFixed(4));
    return v;
  });

  const limits = $$('[data-limit]').map(el => {
    const v = readNum(el, 0, 1, 0.5);
    el.value = Number(v.toFixed(4));
    return v;
  });

  const perturbations = [];
  for (let m = 0; m < 5; m++) {
    const a = readNum($(`[data-pert-a="${m}"]`), 0, 1, 0);
    const b = readNum($(`[data-pert-b="${m}"]`), 0, 1, 0);
    const c = readNum($(`[data-pert-c="${m}"]`), 0, 1, 0);
    $(`[data-pert-a="${m}"]`).value = Number(a.toFixed(4));
    $(`[data-pert-b="${m}"]`).value = Number(b.toFixed(4));
    $(`[data-pert-c="${m}"]`).value = Number(c.toFixed(4));
    perturbations.push({ a, b, c });
  }

  const functions = {};
  for (let k = 1; k <= 78; k++) {
    const c2 = readNum($(`[data-fn-c2="${k}"]`), -1e4, 1e4, BASE_FUNCS[k].c2);
    const c1 = readNum($(`[data-fn-c1="${k}"]`), -1e4, 1e4, BASE_FUNCS[k].c1);
    const c0 = readNum($(`[data-fn-c0="${k}"]`), -1e4, 1e4, BASE_FUNCS[k].c0);
    functions[k] = { c2, c1, c0 };
  }

  return { duration, steps: 200, initial, limits, perturbations, functions };
}

/* === МГНОВЕННОЕ ЧИСЛЕННОЕ РЕШЕНИЕ RK4 (< 1 МС) === */
function evalPert(spec, t) {
  return clamp(spec.a * t * t + spec.b * t + spec.c, 0, 1);
}

function simulateJS(params) {
  const T = clamp(Number(params.duration) || 1, 0.1, 1);
  const n = 200;
  const h = T / n;
  const equations = D.equations;
  const limits = params.limits;
  const perts = params.perturbations;

  const fnInput = new Int32Array(79);
  const fnC2 = new Float64Array(79);
  const fnC1 = new Float64Array(79);
  const fnC0 = new Float64Array(79);
  for (let k = 1; k <= 78; k++) {
    const base = BASE_FUNCS[k];
    const ov = params.functions?.[k] || params.functions?.[String(k)] || base;
    fnInput[k] = base.input - 1;
    fnC2[k] = ov.c2;
    fnC1[k] = ov.c1;
    fnC0[k] = ov.c0;
  }

  function rhs(t, state, out) {
    const E0 = evalPert(perts[0], t);
    const E1 = evalPert(perts[1], t);
    const E2 = evalPert(perts[2], t);
    const E3 = evalPert(perts[3], t);
    const E4 = evalPert(perts[4], t);
    const E = [E0, E1, E2, E3, E4];

    let jSum = 0;
    for (let i = 0; i < 15; i++) {
      const eq = equations[i];
      let pos = 0;
      if (eq.positive.length) {
        pos = 1;
        for (let pIdx = 0; pIdx < eq.positive.length; pIdx++) {
          const k = eq.positive[pIdx];
          const u = state[fnInput[k]];
          pos *= (fnC2[k] * u + fnC1[k]) * u + fnC0[k];
        }
        if (eq.external_positive.length) {
          let eSum = 0;
          for (const m of eq.external_positive) eSum += E[m - 1];
          pos *= eSum;
        }
      }

      let neg = 0;
      if (eq.external_subtract.length) {
        for (const m of eq.external_subtract) neg += E[m - 1];
      } else if (eq.negative.length) {
        neg = 1;
        for (let nIdx = 0; nIdx < eq.negative.length; nIdx++) {
          const k = eq.negative[nIdx];
          const u = state[fnInput[k]];
          neg *= (fnC2[k] * u + fnC1[k]) * u + fnC0[k];
        }
        if (eq.external_negative.length) {
          let eSum = 0;
          for (const m of eq.external_negative) eSum += E[m - 1];
          neg *= eSum;
        }
      }

      let dx = pos - neg;
      const xi = state[i];
      if (xi <= 0 && dx < 0) dx = 0;
      else if (xi >= 1 && dx > 0) dx = 0;
      out[i] = dx;
      const diff = xi - limits[i];
      jSum += diff * diff;
    }
    out[15] = jSum / 15;
  }

  const tGrid = new Array(n + 1);
  const series = Array.from({ length: 15 }, () => new Array(n + 1));
  const forcing = Array.from({ length: 5 }, () => new Array(n + 1));
  const criterion = new Array(n + 1);

  const y = new Float64Array(16);
  for (let i = 0; i < 15; i++) y[i] = clamp(params.initial[i], 0, 1);
  y[15] = 0;

  tGrid[0] = 0;
  for (let i = 0; i < 15; i++) series[i][0] = y[i];
  for (let m = 0; m < 5; m++) forcing[m][0] = evalPert(perts[m], 0);
  criterion[0] = 0;

  const k1 = new Float64Array(16);
  const k2 = new Float64Array(16);
  const k3 = new Float64Array(16);
  const k4 = new Float64Array(16);
  const tmp = new Float64Array(16);

  for (let step = 0; step < n; step++) {
    const t = step * h;
    rhs(t, y, k1);

    for (let j = 0; j < 16; j++) {
      const v = y[j] + 0.5 * h * k1[j];
      tmp[j] = j < 15 ? clamp(v, 0, 1) : v;
    }
    rhs(t + 0.5 * h, tmp, k2);

    for (let j = 0; j < 16; j++) {
      const v = y[j] + 0.5 * h * k2[j];
      tmp[j] = j < 15 ? clamp(v, 0, 1) : v;
    }
    rhs(t + 0.5 * h, tmp, k3);

    for (let j = 0; j < 16; j++) {
      const v = y[j] + h * k3[j];
      tmp[j] = j < 15 ? clamp(v, 0, 1) : v;
    }
    rhs(t + h, tmp, k4);

    for (let j = 0; j < 16; j++) {
      const v = y[j] + (h / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]);
      y[j] = j < 15 ? clamp(v, 0, 1) : Math.max(0, v);
    }

    const nextIdx = step + 1;
    const tNext = Number((nextIdx * h).toFixed(8));
    tGrid[nextIdx] = tNext;
    for (let i = 0; i < 15; i++) series[i][nextIdx] = y[i];
    for (let m = 0; m < 5; m++) forcing[m][nextIdx] = evalPert(perts[m], tNext);
    criterion[nextIdx] = y[15];
  }

  const snapIndices = [0, n / 4, n / 2, (3 * n) / 4, n];
  const snapshots = snapIndices.map(idx => ({
    t: tGrid[idx],
    tau: idx / n,
    values: series.map(arr => arr[idx]),
  }));

  return { parameters: structuredClone(params), t: tGrid, series, forcing, criterion, snapshots };
}

function runSeriesJS(params) {
  const cases = [
    { name: 'Текущие условия', year: null, initial: params.initial },
    ...[1, 3, 5, 7].map(idx => ({
      name: `${D.years[idx]} г.`,
      year: D.years[idx],
      initial: D.normalized[idx].map(v => Number(v.toFixed(4))),
    })),
  ];
  return cases.map(c => ({
    name: c.name,
    year: c.year,
    result: simulateJS({ ...params, initial: c.initial }),
  }));
}

/* === ПОСТРОЕНИЕ ГРАФИКОВ СО ШКАЛОЙ [0..1] И ПОДПИСЯМИ X₁, X₂ === */
function svgSubText(s) {
  const map = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9' };
  const parts = String(s).split(/([₀-₉]+)/g);
  let shifted = false;
  return parts.map(part => {
    if (!part) return '';
    if (/^[₀-₉]+$/.test(part)) {
      shifted = true;
      return `<tspan dy="3" font-size="10">${[...part].map(ch => map[ch]).join('')}</tspan>`;
    }
    const prefix = shifted ? ' dy="-3"' : '';
    shifted = false;
    return prefix ? `<tspan${prefix}>${esc(part)}</tspan>` : esc(part);
  }).join('');
}

function buildLineChartSVG(t, lines, { width = 1040, height = 390, yLabel = 'Значения характеристик (0…1)', xLabel = 'Время t' } = {}) {
  const padL = 62, padR = 38, padT = 22, padB = 46;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const tMax = t[t.length - 1] || 1;

  const xx = val => padL + (val / tMax) * plotW;
  const yy = val => padT + (1 - clamp(val, 0, 1)) * plotH;

  let svg = `<svg class="chart-svg" xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(yLabel)}">`;
  svg += `<rect width="${width}" height="${height}" fill="#ffffff"/>`;

  // Сетка по шкале 0 … 1 (шаг 0.2)
  for (let k = 0; k <= 5; k++) {
    const v = k * 0.2;
    const py = yy(v);
    svg += `<line x1="${padL}" y1="${py.toFixed(1)}" x2="${width - padR}" y2="${py.toFixed(1)}" stroke="${k === 0 || k === 5 ? '#b8c2cc' : '#e5e9f0'}" stroke-width="1"/>`;
    svg += `<text x="${padL - 10}" y="${(py + 4.5).toFixed(1)}" text-anchor="end" font-family="Arial, sans-serif" font-size="13" fill="#334155">${fmt(v, 1)}</text>`;

    const tx = (k / 5) * tMax;
    const px = xx(tx);
    svg += `<line x1="${px.toFixed(1)}" y1="${padT}" x2="${px.toFixed(1)}" y2="${height - padB}" stroke="#eef2f6" stroke-width="1"/>`;
    svg += `<text x="${px.toFixed(1)}" y="${height - padB + 20}" text-anchor="middle" font-family="Arial, sans-serif" font-size="13" fill="#334155">${fmt(tx, 2)}</text>`;
  }

  svg += `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${height - padB}" stroke="#64748b" stroke-width="1.3"/>`;
  svg += `<line x1="${padL}" y1="${height - padB}" x2="${width - padR}" y2="${height - padB}" stroke="#64748b" stroke-width="1.3"/>`;

  // Подписи осей
  svg += `<text x="${padL + plotW / 2}" y="${height - 7}" text-anchor="middle" font-family="Arial, sans-serif" font-size="13.5" font-weight="bold" fill="#1e293b">${esc(xLabel)}</text>`;
  svg += `<text transform="translate(17, ${padT + plotH / 2}) rotate(-90)" text-anchor="middle" font-family="Arial, sans-serif" font-size="13.5" font-weight="bold" fill="#1e293b">${svgSubText(yLabel)}</text>`;

  // Линии кривых
  lines.forEach((line, idx) => {
    const color = line.color || LINE_COLORS[idx % LINE_COLORS.length];
    const dash = line.dash ?? LINE_DASHES[idx % LINE_DASHES.length];
    const pts = line.y.map((v, j) => `${xx(t[j]).toFixed(1)},${yy(v).toFixed(1)}`).join(' ');
    svg += `<polyline fill="none" stroke="${color}" stroke-width="2.3" ${dash ? `stroke-dasharray="${dash}"` : ''} points="${pts}"/>`;
  });

  // Размещение подписей X₁, X₂ … прямо возле кривых без наложений
  const placedBoxes = [];
  const candidateFracs = [0.16, 0.28, 0.40, 0.52, 0.64, 0.76, 0.86, 0.22, 0.34, 0.46, 0.58, 0.70, 0.82, 0.12, 0.91];

  lines.forEach((line, idx) => {
    if (!line.shortBase) return;
    const color = line.color || LINE_COLORS[idx % LINE_COLORS.length];
    const boxW = line.shortSub && String(line.shortSub).length > 1 ? 30 : 25;
    const boxH = 18;

    let bestPos = null;
    let bestScore = -Infinity;

    for (let c = 0; c < candidateFracs.length; c++) {
      const frac = candidateFracs[(idx + c * 3) % candidateFracs.length];
      const sampleIdx = clamp(Math.round(frac * (t.length - 1)), 2, t.length - 3);
      const px = xx(t[sampleIdx]);
      const basePy = yy(line.y[sampleIdx]);

      for (const dyOffset of [-12, 13, 0, -22, 22]) {
        const py = clamp(basePy + dyOffset, padT + 10, height - padB - 10);
        let minClearance = 1e9;
        for (const b of placedBoxes) {
          const dx = Math.abs(px - b.x) - (boxW + b.w) / 2;
          const dy = Math.abs(py - b.y) - (boxH + b.h) / 2;
          const sep = Math.max(dx, dy);
          if (sep < minClearance) minClearance = sep;
        }
        const score = minClearance - Math.abs(dyOffset) * 0.25;
        if (score > bestScore) {
          bestScore = score;
          bestPos = { x: px, y: py, curveX: px, curveY: basePy };
        }
      }
    }

    if (bestPos) {
      placedBoxes.push({ x: bestPos.x, y: bestPos.y, w: boxW, h: boxH });
      if (Math.abs(bestPos.y - bestPos.curveY) > 6) {
        svg += `<line x1="${bestPos.curveX.toFixed(1)}" y1="${bestPos.curveY.toFixed(1)}" x2="${bestPos.x.toFixed(1)}" y2="${bestPos.y.toFixed(1)}" stroke="${color}" stroke-width="1" stroke-opacity="0.7"/>`;
      }
      svg += `<rect x="${(bestPos.x - boxW / 2).toFixed(1)}" y="${(bestPos.y - boxH / 2).toFixed(1)}" width="${boxW}" height="${boxH}" rx="3.5" fill="#ffffff" fill-opacity="0.93" stroke="${color}" stroke-width="1.2"/>`;
      svg += `<text x="${bestPos.x.toFixed(1)}" y="${(bestPos.y + 4).toFixed(1)}" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" font-weight="bold" fill="${color}">${esc(line.shortBase)}${line.shortSub ? `<tspan dy="3" font-size="9.5">${esc(line.shortSub)}</tspan>` : ''}</text>`;
    }
  });

  svg += `</svg>`;
  return svg;
}

function renderChartCard(lines, t, options = {}) {
  const svg = buildLineChartSVG(t, lines, options);
  const legendHTML = lines.map((line, idx) => {
    const color = line.color || LINE_COLORS[idx % LINE_COLORS.length];
    const dash = line.dash ?? LINE_DASHES[idx % LINE_DASHES.length];
    return `<div class="legend-item"><span class="legend-line" style="border-color:${color};${dash ? 'border-top-style:dashed' : ''}"></span><span>${line.legendHTML}</span></div>`;
  }).join('');
  return `<div class="chart-card">${options.titleHTML ? `<h3>${options.titleHTML}</h3>` : ''}${svg}<div class="chart-legend">${legendHTML}</div></div>`;
}

/* === ЛЕПЕСТКОВЫЕ ДИАГРАММЫ: ШКАЛА ДО 1, ПОДПИСИ X₁..X₁₅, КРАСНЫЕ ЗОНЫ === */
function buildSingleRadarSVG(values, limits, { size = 310, titleText = '' } = {}) {
  const n = 15;
  const cx = size / 2;
  const cy = size / 2 + (titleText ? 10 : 2);
  const radius = size * 0.345;

  const xy = (i, rNorm) => {
    const angle = (i * 2 * Math.PI) / n;
    const rr = clamp(rNorm, 0, 1) * radius;
    return [cx + rr * Math.sin(angle), cy - rr * Math.cos(angle)];
  };

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="Лепестковая диаграмма характеристик X1–X15">`;
  svg += `<rect width="${size}" height="${size}" fill="#ffffff"/>`;

  if (titleText) {
    svg += `<text x="${cx}" y="20" text-anchor="middle" font-family="Arial, sans-serif" font-size="14" font-weight="bold" fill="#1e293b">${esc(titleText)}</text>`;
  }

  // Кольца шкалы 0.2, 0.4, 0.6, 0.8, 1.0 (строго до 1!)
  for (let ring = 1; ring <= 5; ring++) {
    const level = ring * 0.2;
    const pts = Array.from({ length: n }, (_, i) => xy(i, level).map(v => v.toFixed(1)).join(',')).join(' ');
    svg += `<polygon points="${pts}" fill="none" stroke="${ring === 5 ? '#94a3b8' : '#dde3ea'}" stroke-width="${ring === 5 ? '1.3' : '1'}"/>`;
  }

  // Оси и подписи X₁ … X₁₅ с нижним индексом
  for (let i = 0; i < n; i++) {
    const [ex, ey] = xy(i, 1);
    const angle = (i * 2 * Math.PI) / n;
    const lx = cx + radius * 1.19 * Math.sin(angle);
    const ly = cy - radius * 1.19 * Math.cos(angle);
    svg += `<line x1="${cx}" y1="${cy}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" stroke="#cbd5e1" stroke-width="1"/>`;
    svg += `<text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="middle" font-family="Arial, sans-serif" font-size="12.5" font-weight="bold" fill="#1e293b">X<tspan dy="3" font-size="9.5">${i + 1}</tspan></text>`;
  }

  // КРАСНАЯ ЗОНА ДОПУСТИМЫХ ЗНАЧЕНИЙ Xᵢ*
  const limitPts = limits.map((lim, i) => xy(i, lim).map(v => v.toFixed(1)).join(',')).join(' ');
  svg += `<polygon points="${limitPts}" fill="rgba(220, 38, 38, 0.16)" stroke="#dc2626" stroke-width="2.2"/>`;
  limits.forEach((lim, i) => {
    const [px, py] = xy(i, lim);
    svg += `<rect x="${(px - 2.6).toFixed(1)}" y="${(py - 2.6).toFixed(1)}" width="5.2" height="5.2" fill="#dc2626"/>`;
  });

  // СИНИЙ КОНТУР РАСЧЁТНЫХ ЗНАЧЕНИЙ Xᵢ(t)
  const valPts = values.map((val, i) => xy(i, val).map(v => v.toFixed(1)).join(',')).join(' ');
  svg += `<polygon points="${valPts}" fill="rgba(29, 78, 216, 0.13)" stroke="#1d4ed8" stroke-width="2.3"/>`;
  values.forEach((val, i) => {
    const [px, py] = xy(i, val);
    const exceeded = val > limits[i] + 1e-6;
    if (exceeded) {
      svg += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="4.3" fill="#b91c1c" stroke="#ffffff" stroke-width="1.4"/>`;
    } else {
      svg += `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3.4" fill="#1d4ed8"/>`;
    }
  });

  // Деления радиальной шкалы 0 … 1 поверх линий
  for (let ring = 0; ring <= 5; ring++) {
    const level = ring * 0.2;
    const py = cy - level * radius;
    svg += `<text x="${cx - 5}" y="${(py + 3.5).toFixed(1)}" text-anchor="end" font-family="Arial, sans-serif" font-size="10.5" font-weight="bold" fill="#334155" stroke="#ffffff" stroke-width="2.5" paint-order="stroke">${fmt(level, 1)}</text>`;
  }

  svg += `</svg>`;
  return svg;
}

function renderRadarsGrid(snapshots, limits) {
  return snapshots.map(snap => {
    const exceedCount = snap.values.filter((v, i) => v > limits[i] + 1e-6).length;
    const subText = exceedCount === 0
      ? 'Все характеристики в допустимой зоне'
      : `Выше допустимого порога: ${exceedCount} из 15`;
    return `
      <div class="radar-card">
        <strong>t = ${fmt(snap.t, 2)}</strong>
        <div class="radar-sub">${esc(subText)}</div>
        ${buildSingleRadarSVG(snap.values, limits)}
      </div>
    `;
  }).join('');
}

/* === ОТОБРАЖЕНИЕ ВСЕХ РЕЗУЛЬТАТОВ === */
function renderAllResults() {
  if (!currentResult) return;
  const r = currentResult;
  const limits = r.parameters.limits;

  // 1. Графики траекторий X₁(t)…X₁₅(t)
  const makeLines = indices => indices.map(i => ({
    shortBase: 'X',
    shortSub: String(i + 1),
    color: LINE_COLORS[i],
    dash: LINE_DASHES[i],
    y: r.series[i],
    legendHTML: `<strong>X<sub>${i + 1}</sub></strong> — ${esc(SHORT_LABELS[i])}`,
  }));

  if (chartMode === 'all') {
    $('#trajectories-container').innerHTML = renderChartCard(
      makeLines([...Array(15).keys()]),
      r.t,
      { width: 1080, height: 430, yLabel: 'Значения характеристик X₁–X₁₅ (0…1)', xLabel: 'Время t' }
    );
  } else {
    const groups = [
      { title: 'Группа 1: Характеристики X<sub>1</sub>–X<sub>5</sub>', idx: [0, 1, 2, 3, 4] },
      { title: 'Группа 2: Характеристики X<sub>6</sub>–X<sub>10</sub>', idx: [5, 6, 7, 8, 9] },
      { title: 'Группа 3: Характеристики X<sub>11</sub>–X<sub>15</sub>', idx: [10, 11, 12, 13, 14] },
    ];
    $('#trajectories-container').innerHTML = groups.map(g => renderChartCard(
      makeLines(g.idx),
      r.t,
      { width: 1040, height: 320, titleHTML: g.title, yLabel: 'Значение (0…1)', xLabel: 'Время t' }
    )).join('');
  }

  // 2. График возмущений E₁(t)…E₅(t)
  const pertLines = PERT_LABELS.map((lbl, m) => ({
    shortBase: 'E',
    shortSub: String(m + 1),
    color: LINE_COLORS[m],
    dash: LINE_DASHES[m],
    y: r.forcing[m],
    legendHTML: `<strong>E<sub>${m + 1}</sub>(t)</strong> — ${esc(lbl)}`,
  }));
  $('#perturbations-chart').innerHTML = renderChartCard(
    pertLines,
    r.t,
    { width: 1080, height: 300, yLabel: 'Возмущения E₁–E₅ (0…1)', xLabel: 'Время t' }
  );

  // 3. Лепестковые диаграммы
  $('#radars-container').innerHTML = renderRadarsGrid(r.snapshots, limits);

  // 4. Сводная таблица начальных условий, допустимых значений и результатов
  const endValues = r.snapshots[r.snapshots.length - 1].values;
  const endExceed = endValues.filter((v, i) => v > limits[i] + 1e-6).length;
  $('#summary-meta').innerHTML =
    `Интервал моделирования: <strong>t ∈ [0; ${fmt(r.parameters.duration, 2)}]</strong> · ` +
    `Интегральный критерий отклонения <strong>J(T) = ${fmtFixed(r.criterion[r.criterion.length - 1], 5)}</strong> · ` +
    `Превышений допустимого порога в конечной точке: <strong>${endExceed} из 15</strong>`;

  const timeHeaders = r.snapshots.slice(1).map(s => `<th class="num-col">X<sub>i</sub>(t = ${fmt(s.t, 2)})</th>`).join('');
  const tableRows = SHORT_LABELS.map((lbl, i) => {
    const x0 = r.parameters.initial[i];
    const lim = limits[i];
    const cells = r.snapshots.slice(1).map(s => {
      const val = s.values[i];
      const cls = val > lim + 1e-6 ? 'num-col exceed-cell' : 'num-col';
      return `<td class="${cls}">${fmtFixed(val, 4)}</td>`;
    }).join('');
    const endVal = endValues[i];
    const statusHTML = endVal > lim + 1e-6
      ? `<span class="exceed-cell">Выше порога</span>`
      : `<span class="ok-cell">В норме</span>`;
    return `
      <tr>
        <td><strong>X<sub>${i + 1}</sub></strong> — ${esc(lbl)}</td>
        <td class="num-col"><strong>${fmtFixed(x0, 3)}</strong></td>
        <td class="num-col">${fmtFixed(lim, 3)}</td>
        ${cells}
        <td>${statusHTML}</td>
      </tr>
    `;
  }).join('');

  $('#initial-and-results-table').innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Характеристика системы</th>
          <th class="num-col">Нач. условие X<sub>i</sub>(0)</th>
          <th class="num-col">Допустимое X<sub>i</sub><sup>*</sup></th>
          ${timeHeaders}
          <th>Состояние в конце</th>
        </tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>
  `;

  // Таблица заданных возмущений
  const pertRows = r.parameters.perturbations.map((p, m) => `
    <tr>
      <td><strong>E<sub>${m + 1}</sub>(t)</strong> — ${esc(PERT_LABELS[m])}</td>
      <td>E<sub>${m + 1}</sub>(t) = ${fmt(p.c, 3)} + ${fmt(p.b, 3)}·t + ${fmt(p.a, 3)}·t<sup>2</sup></td>
      <td class="num-col">${fmtFixed(r.forcing[m][0], 3)}</td>
      <td class="num-col">${fmtFixed(r.forcing[m][r.forcing[m].length - 1], 3)}</td>
    </tr>
  `).join('');

  $('#perturbations-summary-table').innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Внешнее возмущение</th>
          <th>Заданная зависимость</th>
          <th class="num-col">E<sub>m</sub>(0)</th>
          <th class="num-col">E<sub>m</sub>(T)</th>
        </tr>
      </thead>
      <tbody>${pertRows}</tbody>
    </table>
  `;
}

/* === ОТОБРАЖЕНИЕ СЕРИИ РАСЧЁТОВ === */
function renderSeries() {
  if (!currentSeries) return;
  const sec = $('#series-section');
  sec.hidden = false;

  const metricIdx = Number($('#series-metric').value) || 0;
  const seriesLines = currentSeries.map((item, idx) => ({
    shortBase: '',
    shortSub: '',
    color: LINE_COLORS[idx],
    dash: LINE_DASHES[idx],
    y: item.result.series[metricIdx],
    legendHTML: `<strong>${esc(item.name)}</strong> (нач. X<sub>${metricIdx + 1}</sub>(0) = ${fmtFixed(item.result.parameters.initial[metricIdx], 3)})`,
  }));

  $('#series-chart').innerHTML = renderChartCard(
    seriesLines,
    currentSeries[0].result.t,
    {
      width: 1080,
      height: 330,
      titleHTML: `Сравнение траекторий: X<sub>${metricIdx + 1}</sub> — ${esc(SHORT_LABELS[metricIdx])}`,
      yLabel: `X${toSub(metricIdx + 1)}(t) (0…1)`,
      xLabel: 'Время t',
    }
  );

  const rowsHTML = currentSeries.map(item => {
    const r = item.result;
    const init = r.parameters.initial;
    const end = r.snapshots[r.snapshots.length - 1].values;
    const lims = r.parameters.limits;
    const exc = end.filter((v, i) => v > lims[i] + 1e-6).length;
    return `
      <tr>
        <td><strong>${esc(item.name)}</strong></td>
        <td class="num-col">${fmtFixed(init[0], 3)} → <strong>${fmtFixed(end[0], 3)}</strong></td>
        <td class="num-col">${fmtFixed(init[1], 3)} → <strong>${fmtFixed(end[1], 3)}</strong></td>
        <td class="num-col">${fmtFixed(init[2], 3)} → <strong>${fmtFixed(end[2], 3)}</strong></td>
        <td class="num-col">${fmtFixed(r.criterion[r.criterion.length - 1], 5)}</td>
        <td class="num-col">${exc} из 15</td>
      </tr>
    `;
  }).join('');

  $('#series-table').innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Набор начальных условий</th>
          <th class="num-col">Погибшие X<sub>1</sub> (0 → T)</th>
          <th class="num-col">Травмированные X<sub>2</sub> (0 → T)</th>
          <th class="num-col">Прямой ущерб X<sub>3</sub> (0 → T)</th>
          <th class="num-col">Критерий J(T)</th>
          <th class="num-col">Превышений в T</th>
        </tr>
      </thead>
      <tbody>${rowsHTML}</tbody>
    </table>
  `;

  $('#series-radars').innerHTML = currentSeries.map(item => `
    <div class="series-block">
      <h3>${esc(item.name)}</h3>
      <div class="radars-grid">${renderRadarsGrid(item.result.snapshots, item.result.parameters.limits)}</div>
    </div>
  `).join('');
}

/* === СЛУЧАЙНЫЕ ЗНАЧЕНИЯ (РАНДОМ) === */
function randRange(min, max, decimals = 3) {
  const factor = 10 ** decimals;
  return Math.round((min + Math.random() * (max - min)) * factor) / factor;
}

function randomizeInputs() {
  const initial = Array.from({ length: 15 }, () => randRange(0.25, 0.95, 3));
  const limits = Array.from({ length: 15 }, () => randRange(0.35, 0.85, 3));
  const perturbations = Array.from({ length: 5 }, () => ({
    a: randRange(0.00, 0.08, 2),
    b: randRange(0.02, 0.20, 2),
    c: randRange(0.10, 0.40, 2),
  }));
  const current = readParameters();
  fillParameters({ ...current, initial, limits, perturbations });
  $('#preset-initial').value = 'custom';
  $('#preset-limits').value = 'custom';
  runCalculation('Случайные начальные условия, допустимые границы и возмущения сгенерированы и рассчитаны.');
}

function randomizeFunctions() {
  for (let k = 1; k <= 78; k++) {
    $(`[data-fn-c0="${k}"]`).value = randRange(0.25, 0.75, 3);
    $(`[data-fn-c1="${k}"]`).value = randRange(0.05, 0.65, 3);
    $(`[data-fn-c2="${k}"]`).value = randRange(-0.35, 0.35, 3);
  }
  updateAllFuncHighlights();
  runCalculation('Случайные коэффициенты для всех 78 функций f₁–f₇₈ сгенерированы и рассчитаны.');
}

function resetFunctionsOnly() {
  for (let k = 1; k <= 78; k++) {
    const base = BASE_FUNCS[k];
    $(`[data-fn-c0="${k}"]`).value = base.c0;
    $(`[data-fn-c1="${k}"]`).value = base.c1;
    $(`[data-fn-c2="${k}"]`).value = base.c2;
  }
  updateAllFuncHighlights();
  runCalculation('Восстановлены исходные коэффициенты функций f₁–f₇₈ из статьи.');
}

/* === ВЫПОЛНЕНИЕ РАСЧЁТА === */
function saveStateToStorage(params) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(params));
  } catch {}
}

function runCalculation(message = '') {
  try {
    $('#error').hidden = true;
    const t0 = performance.now();
    const params = readParameters();
    currentResult = simulateJS(params);
    renderAllResults();
    if (!($('#series-section').hidden)) {
      currentSeries = runSeriesJS(params);
      renderSeries();
    }
    saveStateToStorage(params);
    const ms = Math.max(1, Math.round(performance.now() - t0));
    $('#status').textContent = message || `Расчёт выполнен за ${ms} мс.`;
  } catch (err) {
    $('#error').textContent = err.message || String(err);
    $('#error').hidden = false;
  }
}

/* === ЭКСПОРТ CSV === */
function downloadCSV() {
  if (!currentResult) runCalculation();
  const r = currentResult;
  const headers = [
    't',
    ...SHORT_LABELS.map((_, i) => `X${toSub(i + 1)}`),
    ...SHORT_LABELS.map((_, i) => `X${toSub(i + 1)}_допуст`),
    ...PERT_LABELS.map((_, m) => `E${toSub(m + 1)}`),
    'J',
  ];
  const rows = r.t.map((tVal, k) => [
    tVal,
    ...r.series.map(arr => arr[k].toFixed(6)),
    ...r.parameters.limits.map(v => v.toFixed(4)),
    ...r.forcing.map(arr => arr[k].toFixed(6)),
    r.criterion[k].toFixed(6),
  ]);
  const csvText = '\uFEFF' + [headers, ...rows].map(r => r.join(';')).join('\n');
  triggerDownload(new Blob([csvText], { type: 'text/csv;charset=utf-8' }), 'Расчёт_пожары.csv');
}

function triggerDownload(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

/* === ГЕНЕРАЦИЯ НАСТОЯЩЕГО WORD ОТЧЁТА (.DOCX) С НАЧАЛЬНЫМИ УСЛОВИЯМИ, ГРАФИКАМИ И ЛЕПЕСТКАМИ === */
const CRC_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    tbl[i] = c >>> 0;
  }
  return tbl;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function buildZip(entries) {
  const enc = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const data = entry.data instanceof Uint8Array ? entry.data : enc.encode(entry.data);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8
    lv.setUint16(8, 0, true); // store
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0x5621, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    localParts.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x5621, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length;
  }

  const centralSize = centralParts.reduce((s, a) => s + a.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, eocd], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

async function svgStringToPngBytes(svgString, widthPx, heightPx) {
  const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = widthPx * 2;
    canvas.height = heightPx * 2;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const pngBlob = await new Promise(res => canvas.toBlob(res, 'image/png'));
    return new Uint8Array(await pngBlob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function buildRadarsSheetPng(snapshots, limits) {
  const cols = 3, rows = 2, cellW = 340, cellH = 340;
  const canvas = document.createElement('canvas');
  canvas.width = cols * cellW * 2;
  canvas.height = rows * cellH * 2;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let idx = 0; idx < snapshots.length; idx++) {
    const snap = snapshots[idx];
    const svg = buildSingleRadarSVG(snap.values, limits, { size: 320, titleText: `t = ${fmt(snap.t, 2)}` });
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      ctx.drawImage(img, col * cellW * 2 + 10, row * cellH * 2 + 10, (cellW - 10) * 2, (cellH - 10) * 2);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  // Легенда в 6-й ячейке
  const lx = 2 * cellW * 2 + 40;
  const ly = 1 * cellH * 2 + 120;
  ctx.font = 'bold 28px Arial';
  ctx.fillStyle = '#1e293b';
  ctx.fillText('Обозначения (шкала 0…1):', lx, ly);

  ctx.fillStyle = 'rgba(29, 78, 216, 0.18)';
  ctx.strokeStyle = '#1d4ed8';
  ctx.lineWidth = 4;
  ctx.fillRect(lx, ly + 30, 44, 28);
  ctx.strokeRect(lx, ly + 30, 44, 28);
  ctx.fillStyle = '#1e293b';
  ctx.font = '25px Arial';
  ctx.fillText('Актуальные значения X(t)', lx + 60, ly + 52);

  ctx.fillStyle = 'rgba(220, 38, 38, 0.22)';
  ctx.strokeStyle = '#dc2626';
  ctx.fillRect(lx, ly + 82, 44, 28);
  ctx.strokeRect(lx, ly + 82, 44, 28);
  ctx.fillStyle = '#1e293b';
  ctx.fillText('Красная зона допустимых X*', lx + 60, ly + 104);

  const pngBlob = await new Promise(res => canvas.toBlob(res, 'image/png'));
  return new Uint8Array(await pngBlob.arrayBuffer());
}

const xmlEsc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function wRun(text, { bold = false, sub = false, sup = false, sizeHalfPt = 22 } = {}) {
  let rPr = '';
  if (bold) rPr += '<w:b/><w:bCs/>';
  rPr += `<w:sz w:val="${sizeHalfPt}"/><w:szCs w:val="${sizeHalfPt}"/>`;
  if (sub) rPr += '<w:vertAlign w:val="subscript"/>';
  if (sup) rPr += '<w:vertAlign w:val="superscript"/>';
  return `<w:r><w:rPr>${rPr}</w:rPr><w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r>`;
}

function wVarSub(sym, idx, bold = false, sizeHalfPt = 22) {
  return wRun(sym, { bold, sizeHalfPt }) + wRun(String(idx), { bold, sub: true, sizeHalfPt });
}

function wEquationRuns(i, eq, sizeHalfPt = 19) {
  const fmtE = ids => {
    if (ids.length === 1) return wVarSub('E', ids[0], false, sizeHalfPt) + wRun('(t)', { sizeHalfPt });
    return wRun('(', { sizeHalfPt }) + ids.map(m => wVarSub('E', m, false, sizeHalfPt) + wRun('(t)', { sizeHalfPt })).join(wRun(' + ', { sizeHalfPt })) + wRun(')', { sizeHalfPt });
  };
  const posParts = eq.positive.map(k =>
    wVarSub('f', k, false, sizeHalfPt) + wRun('(', { sizeHalfPt }) + wVarSub('X', BASE_FUNCS[k].input, false, sizeHalfPt) + wRun(')', { sizeHalfPt })
  );
  if (eq.external_positive.length) posParts.push(fmtE(eq.external_positive));
  const posRuns = posParts.length ? posParts.join(wRun(' · ', { sizeHalfPt })) : wRun('0', { sizeHalfPt });

  let negRuns = '';
  if (eq.external_subtract.length) {
    negRuns = fmtE(eq.external_subtract);
  } else if (eq.negative.length) {
    const negParts = eq.negative.map(k =>
      wVarSub('f', k, false, sizeHalfPt) + wRun('(', { sizeHalfPt }) + wVarSub('X', BASE_FUNCS[k].input, false, sizeHalfPt) + wRun(')', { sizeHalfPt })
    );
    if (eq.external_negative.length) negParts.push(fmtE(eq.external_negative));
    negRuns = negParts.join(wRun(' · ', { sizeHalfPt }));
  }

  return (
    wRun('d', { bold: true, sizeHalfPt }) +
    wVarSub('X', i + 1, true, sizeHalfPt) +
    wRun('/dt = ', { bold: true, sizeHalfPt }) +
    posRuns +
    (negRuns ? wRun(' − ', { sizeHalfPt }) + negRuns : '')
  );
}

function wPara(runsXML, { style = '', spaceAfter = 120, align = '' } = {}) {
  let pPr = '';
  if (style) pPr += `<w:pStyle w:val="${style}"/>`;
  pPr += `<w:spacing w:after="${spaceAfter}"/>`;
  if (align) pPr += `<w:jc w:val="${align}"/>`;
  return `<w:p><w:pPr>${pPr}</w:pPr>${runsXML}</w:p>`;
}

function wTable(headerCellsRuns, rowsCellsRuns) {
  const colCount = headerCellsRuns.length;
  const colWidthDxa = Math.floor(9495 / Math.max(1, colCount));
  const tblGrid = `<w:tblGrid>${Array.from({ length: colCount }, () => `<w:gridCol w:w="${colWidthDxa}"/>`).join('')}</w:tblGrid>`;
  const tblPr = `
    <w:tblPr>
      <w:tblW w:w="5000" w:type="pct"/>
      <w:tblBorders>
        <w:top w:val="single" w:sz="6" w:space="0" w:color="94A3B8"/>
        <w:left w:val="single" w:sz="6" w:space="0" w:color="94A3B8"/>
        <w:bottom w:val="single" w:sz="6" w:space="0" w:color="94A3B8"/>
        <w:right w:val="single" w:sz="6" w:space="0" w:color="94A3B8"/>
        <w:insideH w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/>
        <w:insideV w:val="single" w:sz="4" w:space="0" w:color="CBD5E1"/>
      </w:tblBorders>
    </w:tblPr>`;
  const headRow = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${headerCellsRuns.map(
    runs => `<w:tc><w:tcPr><w:tcW w:w="${colWidthDxa}" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="EEF2F6"/></w:tcPr>${wPara(runs, { spaceAfter: 40 })}</w:tc>`
  ).join('')}</w:tr>`;
  const bodyRows = rowsCellsRuns.map(
    row => `<w:tr>${row.map(runs => `<w:tc><w:tcPr><w:tcW w:w="${colWidthDxa}" w:type="dxa"/></w:tcPr>${wPara(runs, { spaceAfter: 40 })}</w:tc>`).join('')}</w:tr>`
  ).join('');
  return `<w:tbl>${tblPr}${tblGrid}${headRow}${bodyRows}</w:tbl>`;
}

function wImagePara(rId, docPrId, name, cxEmu, cyEmu) {
  return `<w:p><w:pPr><w:spacing w:before="80" w:after="80"/><w:jc w:val="center"/></w:pPr><w:r><w:drawing>
    <wp:inline distT="0" distB="0" distL="0" distR="0">
      <wp:extent cx="${cxEmu}" cy="${cyEmu}"/>
      <wp:effectExtent l="0" t="0" r="0" b="0"/>
      <wp:docPr id="${docPrId}" name="${xmlEsc(name)}"/>
      <wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>
      <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
          <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
            <pic:nvPicPr><pic:cNvPr id="${docPrId}" name="${xmlEsc(name)}"/><pic:cNvPicPr/></pic:nvPicPr>
            <pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
            <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cxEmu}" cy="${cyEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
          </pic:pic>
        </a:graphicData>
      </a:graphic>
    </wp:inline>
  </w:drawing></w:r></w:p>`;
}

async function generateDocxReport() {
  if (!currentResult) runCalculation();
  $('#status').textContent = 'Формирование отчёта Word (.docx)…';
  try {
    const r = currentResult;
    const p = r.parameters;

    // Генерируем изображения графиков и лепестков
    const allLines = [...Array(15).keys()].map(i => ({
      shortBase: 'X',
      shortSub: String(i + 1),
      color: LINE_COLORS[i],
      dash: LINE_DASHES[i],
      y: r.series[i],
    }));
    const trajSVG = buildLineChartSVG(r.t, allLines, {
      width: 1000,
      height: 410,
      yLabel: 'Значения характеристик X (0…1)',
      xLabel: 'Время t',
    });
    const pertLines = PERT_LABELS.map((_, m) => ({
      shortBase: 'E',
      shortSub: String(m + 1),
      color: LINE_COLORS[m],
      dash: LINE_DASHES[m],
      y: r.forcing[m],
    }));
    const pertSVG = buildLineChartSVG(r.t, pertLines, {
      width: 1000,
      height: 290,
      yLabel: 'Возмущения E (0…1)',
      xLabel: 'Время t',
    });

    const [trajPng, pertPng, radarsPng] = await Promise.all([
      svgStringToPngBytes(trajSVG, 1000, 410),
      svgStringToPngBytes(pertSVG, 1000, 290),
      buildRadarsSheetPng(r.snapshots, p.limits),
    ]);

    let bodyXML = '';
    bodyXML += wPara(wRun('ОТЧЁТ ПО МОДЕЛИРОВАНИЮ ПОСЛЕДСТВИЙ ПОЖАРА НА ПРОМЫШЛЕННОМ ПРЕДПРИЯТИИ', { bold: true, sizeHalfPt: 28 }), { align: 'center', spaceAfter: 180 });
    bodyXML += wPara(wRun(`Интервал моделирования: t ∈ [0; ${fmt(p.duration, 2)}], метод Рунге–Кутта 4-го порядка, шкала нормированных показателей: от 0 до 1. Интегральный критерий J(T) = ${fmtFixed(r.criterion[r.criterion.length - 1], 5)}.`), { spaceAfter: 180 });

    // РАЗДЕЛ 1: НАЧАЛЬНЫЕ УСЛОВИЯ И ДОПУСТИМЫЕ ЗНАЧЕНИЯ
    bodyXML += wPara(wRun('1. Начальные условия и допустимые (предельные) значения характеристик', { bold: true, sizeHalfPt: 25 }), { spaceAfter: 120 });
    bodyXML += wPara(
      wRun('В таблице 1 приведены начальные условия ') +
      wVarSub('X', 'i') +
      wRun('(0) при t = 0 и допустимые пороговые значения ') +
      wVarSub('X', 'i') +
      wRun('*', { sup: true }) +
      wRun(' (красная зона на лепестковых диаграммах), заданные для текущего расчёта:'),
      { spaceAfter: 100 }
    );

    const initHeader = [
      wRun('Обозначение', { bold: true, sizeHalfPt: 20 }),
      wRun('Наименование характеристики', { bold: true, sizeHalfPt: 20 }),
      wRun('Начальное условие ', { bold: true, sizeHalfPt: 20 }) + wVarSub('X', 'i', true, 20) + wRun('(0)', { bold: true, sizeHalfPt: 20 }),
      wRun('Допустимое значение ', { bold: true, sizeHalfPt: 20 }) + wVarSub('X', 'i', true, 20) + wRun('*', { bold: true, sup: true, sizeHalfPt: 20 }),
    ];
    const initRows = SHORT_LABELS.map((lbl, i) => [
      wVarSub('X', i + 1, true, 20),
      wRun(lbl, { sizeHalfPt: 20 }),
      wRun(fmtFixed(p.initial[i], 3), { bold: true, sizeHalfPt: 20 }),
      wRun(fmtFixed(p.limits[i], 3), { sizeHalfPt: 20 }),
    ]);
    bodyXML += wTable(initHeader, initRows);
    bodyXML += wPara('', { spaceAfter: 160 });

    // РАЗДЕЛ 2: ВОЗМУЩЕНИЯ
    bodyXML += wPara(
      wRun('2. Параметры внешних возмущений ', { bold: true, sizeHalfPt: 25 }) +
      wVarSub('E', 1, true, 25) +
      wRun('(t)–', { bold: true, sizeHalfPt: 25 }) +
      wVarSub('E', 5, true, 25) +
      wRun('(t)', { bold: true, sizeHalfPt: 25 }),
      { spaceAfter: 120 }
    );
    const pertHeader = [
      wRun('Возмущение', { bold: true, sizeHalfPt: 20 }),
      wRun('Наименование фактора', { bold: true, sizeHalfPt: 20 }),
      wRun('Заданная функция от времени t', { bold: true, sizeHalfPt: 20 }),
      wRun('Нач. E(0) → Кон. E(T)', { bold: true, sizeHalfPt: 20 }),
    ];
    const pertRows = p.perturbations.map((spec, m) => [
      wVarSub('E', m + 1, true, 20) + wRun('(t)', { sizeHalfPt: 20 }),
      wRun(PERT_LABELS[m], { sizeHalfPt: 20 }),
      wVarSub('E', m + 1, false, 20) + wRun(`(t) = ${fmt(spec.c, 3)} + ${fmt(spec.b, 3)}·t + ${fmt(spec.a, 3)}·t`, { sizeHalfPt: 20 }) + wRun('2', { sup: true, sizeHalfPt: 20 }),
      wRun(`${fmtFixed(r.forcing[m][0], 3)} → ${fmtFixed(r.forcing[m][r.forcing[m].length - 1], 3)}`, { sizeHalfPt: 20 }),
    ]);
    bodyXML += wTable(pertHeader, pertRows);
    bodyXML += wPara('', { spaceAfter: 160 });

    // РАЗДЕЛ 3: РЕЗУЛЬТАТЫ ЧИСЛЕННОГО РЕШЕНИЯ
    bodyXML += wPara(wRun('3. Результаты численного решения системы уравнений', { bold: true, sizeHalfPt: 25 }), { spaceAfter: 120 });
    const solHeader = [
      wRun('Показатель', { bold: true, sizeHalfPt: 19 }),
      ...r.snapshots.map(s => wRun(`t = ${fmt(s.t, 2)}`, { bold: true, sizeHalfPt: 19 })),
      wRun('Допуст. ', { bold: true, sizeHalfPt: 19 }) + wVarSub('X', 'i', true, 19) + wRun('*', { bold: true, sup: true, sizeHalfPt: 19 }),
    ];
    const solRows = SHORT_LABELS.map((_, i) => [
      wVarSub('X', i + 1, true, 19),
      ...r.snapshots.map(s => wRun(fmtFixed(s.values[i], 4), { sizeHalfPt: 19 })),
      wRun(fmtFixed(p.limits[i], 3), { sizeHalfPt: 19 }),
    ]);
    bodyXML += wTable(solHeader, solRows);
    bodyXML += wPara('', { spaceAfter: 160 });

    // РАЗДЕЛ 4: ГРАФИКИ И ЛЕПЕСТКОВЫЕ ДИАГРАММЫ
    bodyXML += wPara(wRun('4. Графики изменений характеристик и лепестковые диаграммы', { bold: true, sizeHalfPt: 25 }), { spaceAfter: 100 });
    bodyXML += wImagePara('rIdImg1', 10, 'Trajectories', 6000000, 2460000);
    bodyXML += wPara(
      wRun('Рисунок 1 — Траектории нормированных характеристик системы ', { sizeHalfPt: 20 }) +
      wVarSub('X', 1, false, 20) +
      wRun('(t)–', { sizeHalfPt: 20 }) +
      wVarSub('X', 15, false, 20) +
      wRun('(t) (шкала 0…1)', { sizeHalfPt: 20 }),
      { align: 'center', spaceAfter: 140 }
    );

    bodyXML += wImagePara('rIdImg2', 11, 'Perturbations', 6000000, 1740000);
    bodyXML += wPara(
      wRun('Рисунок 2 — График внешних возмущений ', { sizeHalfPt: 20 }) +
      wVarSub('E', 1, false, 20) +
      wRun('(t)–', { sizeHalfPt: 20 }) +
      wVarSub('E', 5, false, 20) +
      wRun('(t) (шкала 0…1)', { sizeHalfPt: 20 }),
      { align: 'center', spaceAfter: 140 }
    );

    bodyXML += wImagePara('rIdImg3', 12, 'Radars', 6000000, 4000000);
    bodyXML += wPara(wRun('Рисунок 3 — Лепестковые диаграммы характеристик системы (синяя линия — актуальные расчётные значения, красная зона — допустимые предельные значения, шкала 0…1)', { sizeHalfPt: 20 }), { align: 'center', spaceAfter: 160 });

    // РАЗДЕЛ 5: СИСТЕМА УРАВНЕНИЙ И ФУНКЦИИ f₁..f₇₈
    bodyXML += wPara(
      wRun('5. Система дифференциальных уравнений и функции ', { bold: true, sizeHalfPt: 25 }) +
      wVarSub('f', 1, true, 25) +
      wRun('(X)–', { bold: true, sizeHalfPt: 25 }) +
      wVarSub('f', 78, true, 25) +
      wRun('(X)', { bold: true, sizeHalfPt: 25 }),
      { spaceAfter: 100 }
    );
    D.equations.forEach((eq, i) => {
      bodyXML += wPara(wEquationRuns(i, eq, 19), { spaceAfter: 50 });
    });
    bodyXML += wPara('', { spaceAfter: 80 });

    const fnHeader = [
      wRun('Функция', { bold: true, sizeHalfPt: 18 }),
      wRun('Зависимость', { bold: true, sizeHalfPt: 18 }),
      wRun('Полиномиальный вид', { bold: true, sizeHalfPt: 18 }),
    ];
    const fnRows = [];
    for (let k = 1; k <= 78; k++) {
      const base = BASE_FUNCS[k];
      const spec = p.functions[k] || base;
      const xIdx = base.input;
      const s1 = spec.c1 >= 0 ? ' + ' : ' − ';
      const s2 = spec.c2 >= 0 ? ' + ' : ' − ';
      fnRows.push([
        wVarSub('f', k, true, 18) + wRun('(', { sizeHalfPt: 18 }) + wVarSub('X', xIdx, false, 18) + wRun(')', { sizeHalfPt: 18 }),
        wVarSub('X', xIdx, false, 18) + wRun(' → ', { sizeHalfPt: 18 }) + wVarSub('X', base.target, false, 18),
        wRun(`${fmt(spec.c0, 6)}${s1}${fmt(Math.abs(spec.c1), 6)}·`, { sizeHalfPt: 18 }) + wVarSub('X', xIdx, false, 18) + wRun(`${s2}${fmt(Math.abs(spec.c2), 6)}·`, { sizeHalfPt: 18 }) + wVarSub('X', xIdx, false, 18) + wRun('2', { sup: true, sizeHalfPt: 18 }),
      ]);
    }
    bodyXML += wTable(fnHeader, fnRows);

    if (currentSeries) {
      bodyXML += wPara('', { spaceAfter: 140 });
      bodyXML += wPara(wRun('6. Сравнение серии начальных состояний', { bold: true, sizeHalfPt: 25 }), { spaceAfter: 100 });
      const serHeader = [
        wRun('Начальные условия', { bold: true, sizeHalfPt: 19 }),
        wVarSub('X', 1, true, 19) + wRun('(0 → T)', { bold: true, sizeHalfPt: 19 }),
        wVarSub('X', 2, true, 19) + wRun('(0 → T)', { bold: true, sizeHalfPt: 19 }),
        wVarSub('X', 3, true, 19) + wRun('(0 → T)', { bold: true, sizeHalfPt: 19 }),
        wRun('J(T)', { bold: true, sizeHalfPt: 19 }),
      ];
      const serRows = currentSeries.map(item => {
        const sr = item.result;
        const end = sr.snapshots[sr.snapshots.length - 1].values;
        return [
          wRun(item.name, { bold: true, sizeHalfPt: 19 }),
          wRun(`${fmtFixed(sr.parameters.initial[0], 3)} → ${fmtFixed(end[0], 3)}`, { sizeHalfPt: 19 }),
          wRun(`${fmtFixed(sr.parameters.initial[1], 3)} → ${fmtFixed(end[1], 3)}`, { sizeHalfPt: 19 }),
          wRun(`${fmtFixed(sr.parameters.initial[2], 3)} → ${fmtFixed(end[2], 3)}`, { sizeHalfPt: 19 }),
          wRun(fmtFixed(sr.criterion[sr.criterion.length - 1], 5), { sizeHalfPt: 19 }),
        ];
      });
      bodyXML += wTable(serHeader, serRows);
    }

    const documentXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
  <w:body>
    ${bodyXML}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1134" w:right="992" w:bottom="1134" w:left="1417"/>
    </w:sectPr>
  </w:body>
</w:document>`;

    const stylesXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="22"/><w:lang w:val="ru-RU"/></w:rPr></w:rPrDefault>
  </w:docDefaults>
</w:styles>`;

    const contentTypesXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

    const rootRelsXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

    const docRelsXML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rIdImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/trajectories.png"/>
  <Relationship Id="rIdImg2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/perturbations.png"/>
  <Relationship Id="rIdImg3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/radars.png"/>
</Relationships>`;

    const docxBlob = buildZip([
      { name: '[Content_Types].xml', data: contentTypesXML },
      { name: '_rels/.rels', data: rootRelsXML },
      { name: 'word/document.xml', data: documentXML },
      { name: 'word/styles.xml', data: stylesXML },
      { name: 'word/_rels/document.xml.rels', data: docRelsXML },
      { name: 'word/media/trajectories.png', data: trajPng },
      { name: 'word/media/perturbations.png', data: pertPng },
      { name: 'word/media/radars.png', data: radarsPng },
    ]);

    triggerDownload(docxBlob, 'Отчёт_моделирование_пожары.docx');
    $('#status').textContent = 'Отчёт Word (.docx) с текущими начальными условиями и графиками сформирован.';
  } catch (err) {
    $('#error').textContent = 'Не удалось сформировать отчёт: ' + (err.message || err);
    $('#error').hidden = false;
  }
}

/* === СОБЫТИЯ И ИНИЦИАЛИЗАЦИЯ === */
async function init() {
  const resp = await fetch('./source_data.json?v=20261113');
  if (!resp.ok) throw new Error('Не удалось загрузить source_data.json');
  D = await resp.json();
  BASE_FUNCS = buildBaseFunctions();

  renderWorkspace();

  const defaults = {
    duration: 1.0,
    initial: D.article_initial.map(v => Number(v.toFixed(4))),
    limits: D.limits[2].map(v => Number(v.toFixed(3))),
    perturbations: structuredClone(DEFAULT_PERTURBATIONS),
    functions: {},
  };

  fillParameters(defaults);

  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && Array.isArray(saved.initial) && saved.initial.length === 15 && Array.isArray(saved.limits) && saved.limits.length === 15) {
      fillParameters(saved);
      $('#preset-initial').value = 'custom';
      $('#preset-limits').value = 'custom';
    }
  } catch {}

  // Переключение наборов начальных условий
  $('#preset-initial').addEventListener('change', () => {
    const val = $('#preset-initial').value;
    if (val === 'custom') return;
    let arr = D.article_initial;
    if (val === 'mean') arr = D.limits[2];
    else if (val.startsWith('year-')) arr = D.normalized[Number(val.slice(5))];
    $$('[data-initial]').forEach((el, i) => { el.value = Number(arr[i].toFixed(4)); });
    runCalculation();
  });

  // Переключение допустимых границ
  $('#preset-limits').addEventListener('change', () => {
    const val = $('#preset-limits').value;
    if (val === 'custom') return;
    const arr = val === 'median' ? D.limits[3] : val === 'last' ? D.limits[1] : D.limits[2];
    $$('[data-limit]').forEach((el, i) => { el.value = Number(arr[i].toFixed(3)); });
    runCalculation();
  });

  // При ручном изменении помечаем пресет как пользовательский и пересчитываем на change
  $$('[data-initial]').forEach(el => el.addEventListener('change', () => {
    $('#preset-initial').value = 'custom';
    runCalculation();
  }));
  $$('[data-limit]').forEach(el => el.addEventListener('change', () => {
    $('#preset-limits').value = 'custom';
    runCalculation();
  }));
  $$('[data-pert-a],[data-pert-b],[data-pert-c],#duration').forEach(el => {
    el.addEventListener('change', () => runCalculation());
  });
  $$('[data-fn-c0],[data-fn-c1],[data-fn-c2]').forEach(el => {
    const k = Number(el.dataset.fnC0 || el.dataset.fnC1 || el.dataset.fnC2);
    el.addEventListener('input', () => updateFuncRowHighlight(k));
    el.addEventListener('change', () => {
      updateFuncRowHighlight(k);
      runCalculation();
    });
  });

  // Кнопки панели управления
  $('#btn-calculate').addEventListener('click', () => {
    runCalculation();
    $('#results-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  $('#btn-random').addEventListener('click', () => randomizeInputs());
  $('#btn-random-funcs').addEventListener('click', () => randomizeFunctions());
  $('#btn-reset-funcs').addEventListener('click', () => resetFunctionsOnly());

  $('#btn-series').addEventListener('click', () => {
    const t0 = performance.now();
    const params = readParameters();
    currentResult = simulateJS(params);
    renderAllResults();
    currentSeries = runSeriesJS(params);
    renderSeries();
    const ms = Math.max(1, Math.round(performance.now() - t0));
    $('#status').textContent = `Серия из 5 наборов начальных условий рассчитана за ${ms} мс.`;
    $('#series-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  $('#series-metric').addEventListener('change', renderSeries);

  $('#btn-reset').addEventListener('click', () => {
    localStorage.removeItem(STORAGE_KEY);
    $('#preset-initial').value = 'article';
    $('#preset-limits').value = 'mean';
    $('#series-section').hidden = true;
    currentSeries = null;
    fillParameters(defaults);
    runCalculation('Восстановлены исходные значения параметров и функций.');
  });

  // Сохранение / загрузка JSON
  $('#btn-save').addEventListener('click', () => {
    const params = readParameters();
    const blob = new Blob([JSON.stringify({ version: 'fire-calc-v1', parameters: params }, null, 2)], { type: 'application/json;charset=utf-8' });
    triggerDownload(blob, 'Параметры_пожары.json');
  });

  $('#btn-load').addEventListener('click', () => $('#file-load').click());
  $('#file-load').addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const p = parsed.parameters || parsed;
      if (!Array.isArray(p.initial) || p.initial.length !== 15) throw new Error('Неподходящий JSON-файл параметров.');
      fillParameters(p);
      $('#preset-initial').value = 'custom';
      $('#preset-limits').value = 'custom';
      runCalculation('Параметры успешно загружены из файла.');
    } catch (err) {
      $('#error').textContent = err.message || 'Ошибка чтения файла.';
      $('#error').hidden = false;
    } finally {
      e.target.value = '';
    }
  });

  // Переключатель вида графиков
  $$('[data-chart-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      chartMode = btn.dataset.chartMode;
      $$('[data-chart-mode]').forEach(b => b.classList.toggle('active', b === btn));
      renderAllResults();
    });
  });

  // Экспорт таблицы в CSV
  $('#download-csv')?.addEventListener('click', downloadCSV);

  // Мгновенный первичный расчёт при открытии страницы
  runCalculation('Готово. Все параметры и 78 функций доступны на одном экране.');
}

init().catch(err => {
  $('#error').textContent = err.message || String(err);
  $('#error').hidden = false;
});
