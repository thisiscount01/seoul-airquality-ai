/**
 * app.js — 서울 대기질 AI 예보 대시보드
 *
 * 색상 원칙: 이 파일 내 색상 리터럴 없음.
 * 모든 색상은 CSS [data-grade] 셀렉터 / CSS 커스텀 프로퍼티로만 처리.
 */

'use strict';

/* ── 상수 ──────────────────────────────────────────────────── */
const REFRESH_MS = 5 * 60 * 1000;   // 5분

const GRADE_LABEL = {
  good:           '좋음',
  moderate:       '보통',
  unhealthy:      '나쁨',
  very_unhealthy: '매우나쁨',
};

const GRADE_EMOJI = {
  good:           '😊',
  moderate:       '😐',
  unhealthy:      '😷',
  very_unhealthy: '🚨',
};

const GRADE_ADVICE = {
  good:
    '대기 상태가 매우 좋습니다. 야외 활동을 자유롭게 즐기세요.',
  moderate:
    '대기 상태가 보통입니다. 민감군(노인·어린이·호흡기질환자)은 장시간 야외 활동을 자제하세요.',
  unhealthy:
    '대기 상태가 나쁩니다. 모든 분들이 장시간 야외 활동을 자제하고 외출 시 마스크(KF80 이상)를 착용하세요.',
  very_unhealthy:
    '대기 상태가 매우 나쁩니다. 외출을 최대한 자제하고 불가피한 경우 반드시 KF94 이상 마스크를 착용하세요. 실내 환기도 줄이세요.',
};

/* ── 상태 ──────────────────────────────────────────────────── */
let _data        = null;   // 최신 /api/forecast/all 응답
let _selected    = null;   // 선택된 station ID
let _refreshTimer    = null;
let _countdownTimer  = null;
let _nextRefreshAt   = 0;

/* ── DOM 참조 ───────────────────────────────────────────────── */
const $  = id => document.getElementById(id);
const el = {
  loading:       $('loading'),
  errorBanner:   $('error-banner'),
  errorText:     $('error-text'),
  errorRetry:    $('error-retry'),
  app:           $('app'),
  stationTabs:   $('station-tabs'),
  currentCard:   $('current-card'),
  gradeBlock:    $('grade-block'),
  gradeEmoji:    $('grade-emoji'),
  gradeLabel:    $('grade-label'),
  gradeMeta:     $('grade-meta'),
  pm25Value:     $('pm25-value'),
  pm10Value:     $('pm10-value'),
  healthAdvice:  $('health-advice'),
  adviceText:    $('advice-text'),
  forecastChart: $('forecast-chart'),
  timelineRow:   $('timeline-row'),
  stationsGrid:  $('stations-grid'),
  lastUpdated:   $('last-updated-text'),
  nextRefresh:   $('next-refresh-text'),
};

/* ── 진입점 ─────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  el.errorRetry.addEventListener('click', () => {
    el.errorBanner.hidden = true;
    fetchAndRender();
  });
  fetchAndRender();
});

/* ── 데이터 로드 ─────────────────────────────────────────────── */
async function fetchAndRender() {
  showLoading(true);
  try {
    const res = await fetch('/api/forecast/all');

    if (res.status === 503) {
      throw new Error('AI 모델 훈련 중입니다. 약 10초 후 다시 시도하세요.');
    }
    if (!res.ok) {
      throw new Error(`서버 오류 (HTTP ${res.status})`);
    }

    const json = await res.json();
    if (!json.forecasts || !Array.isArray(json.forecasts)) {
      throw new Error('예상치 못한 응답 형식입니다.');
    }

    _data = json;

    /* 선택 측정소 초기화 또는 유지 */
    const ids = _data.forecasts.map(f => f.station);
    if (!_selected || !ids.includes(_selected)) {
      _selected = ids[0] ?? null;
    }

    render();
    showLoading(false);
    el.errorBanner.hidden = true;
    setLastUpdated(json.fetchedAt);
    scheduleRefresh();

  } catch (err) {
    showLoading(false);
    showError(err.message);
  }
}

/* ── 렌더 ───────────────────────────────────────────────────── */
function render() {
  if (!_data) return;
  renderTabs();
  renderCurrentCard();
  renderStationsGrid();
}

/* 측정소 탭 */
function renderTabs() {
  el.stationTabs.innerHTML = '';
  _data.forecasts.forEach(fc => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'station-tab' + (fc.station === _selected ? ' active' : '');
    btn.textContent = fc.stationName;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(fc.station === _selected));
    btn.addEventListener('click', () => {
      _selected = fc.station;
      renderTabs();
      renderCurrentCard();
    });
    el.stationTabs.appendChild(btn);
  });
}

/* 현재 카드 */
function renderCurrentCard() {
  const fc = _data.forecasts.find(f => f.station === _selected);
  if (!fc || !fc.predictions?.length) return;

  const cur   = fc.predictions[0];
  const grade = cur.grade ?? 'good';

  setGrade(el.currentCard,  grade);
  setGrade(el.gradeBlock,   grade);
  setGrade(el.healthAdvice, grade);

  el.gradeEmoji.textContent    = GRADE_EMOJI[grade]  ?? '–';
  el.gradeLabel.textContent    = GRADE_LABEL[grade]  ?? grade;
  el.gradeMeta.textContent     = `${fc.stationName} · ${formatTime(fc.baseTime)} 기준`;
  el.pm25Value.textContent     = formatNum(cur.pm25);
  el.pm10Value.textContent     = formatNum(cur.pm10);
  el.adviceText.textContent    = GRADE_ADVICE[grade] ?? '';

  renderChart(fc.predictions);
  renderTimeline(fc.predictions);
}

/* 전체 측정소 그리드 */
function renderStationsGrid() {
  el.stationsGrid.innerHTML = '';
  _data.forecasts.forEach(fc => {
    const cur   = fc.predictions?.[0];
    if (!cur) return;

    const grade = cur.grade ?? 'good';

    const card = document.createElement('div');
    card.className = 'station-mini-card';
    card.setAttribute('data-grade', grade);
    card.setAttribute('role', 'listitem');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', `${fc.stationName} — ${GRADE_LABEL[grade]}`);

    const badge = el_('span', 'station-mini-badge', GRADE_LABEL[grade] ?? grade);
    badge.setAttribute('data-grade', grade);

    const name = el_('div', 'station-mini-name', fc.stationName);

    const vals = document.createElement('div');
    vals.className = 'station-mini-values';
    vals.innerHTML =
      `<span>PM<sub>2.5</sub> <strong>${formatNum(cur.pm25)}</strong> μg/m³</span>` +
      `<span>PM<sub>10</sub> <strong>${formatNum(cur.pm10)}</strong> μg/m³</span>`;

    card.append(badge, name, vals);

    card.addEventListener('click', () => {
      _selected = fc.station;
      renderTabs();
      renderCurrentCard();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); card.click(); }
    });

    el.stationsGrid.appendChild(card);
  });
}

/* ── SVG 예보 차트 ──────────────────────────────────────────── */
function renderChart(predictions) {
  /* 레이아웃 */
  const W  = 620, H  = 210;
  const PT = 22,  PB = 50, PL = 42, PR = 16;
  const IW = W - PL - PR;
  const IH = H - PT - PB;

  const n      = predictions.length;
  const maxVal = Math.max(...predictions.flatMap(p => [p.pm25 ?? 0, p.pm10 ?? 0]), 60);
  const scaleY = v => IH - Math.min(1, v / maxVal) * IH;

  const groupW    = IW / n;
  const barW      = Math.min(groupW * 0.32, 22);
  const barGap    = 4;

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('xmlns', NS);
  svg.setAttribute('aria-hidden', 'true');

  /* Y 가이드라인 */
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const frac = i / steps;
    const y    = PT + IH * (1 - frac);
    const val  = Math.round(maxVal * frac);

    const line = svgEl(NS, 'line', {
      x1: PL, x2: PL + IW,
      y1: y,  y2: y,
      class: 'fc-guideline',
    });
    svg.appendChild(line);

    if (i > 0) {
      const txt = svgEl(NS, 'text', {
        x: PL - 5, y: y + 4,
        'text-anchor': 'end',
        class: 'fc-axis-text',
      });
      txt.textContent = val;
      svg.appendChild(txt);
    }
  }

  /* 축 단위 */
  const unitLabel = svgEl(NS, 'text', {
    x: PL - 5, y: PT - 6,
    'text-anchor': 'end',
    class: 'fc-conf-text',
  });
  unitLabel.textContent = 'μg/m³';
  svg.appendChild(unitLabel);

  /* 각 시간대 그룹 */
  predictions.forEach((p, i) => {
    const cx    = PL + i * groupW + groupW / 2;
    const x25   = cx - barW - barGap / 2;
    const x10   = cx + barGap / 2;
    const conf  = clamp(typeof p.confidence === 'number' ? p.confidence : 0.8, 0.25, 1);

    /* ── PM2.5 바 ── */
    const h25 = IH - scaleY(p.pm25 ?? 0);
    const y25 = PT + scaleY(p.pm25 ?? 0);
    const bar25 = svgEl(NS, 'rect', {
      class: 'fc-bar-pm25',
      'data-grade': p.grade ?? 'good',
      x: x25, y: y25,
      width: barW, height: Math.max(h25, 2),
      rx: 3,
      opacity: conf.toFixed(2),
    });
    svg.appendChild(bar25);

    /* PM2.5 수치 */
    if (h25 > 12) {
      const v25 = svgEl(NS, 'text', {
        x: x25 + barW / 2, y: y25 - 3,
        'text-anchor': 'middle',
        class: 'fc-value-text',
      });
      v25.textContent = formatNum(p.pm25);
      svg.appendChild(v25);
    }

    /* ── PM10 바 ── */
    const h10 = IH - scaleY(p.pm10 ?? 0);
    const y10 = PT + scaleY(p.pm10 ?? 0);
    const bar10 = svgEl(NS, 'rect', {
      class: 'fc-bar-pm10',
      x: x10, y: y10,
      width: barW, height: Math.max(h10, 2),
      rx: 3,
      opacity: conf.toFixed(2),
    });
    svg.appendChild(bar10);

    /* PM10 수치 */
    if (h10 > 12) {
      const v10 = svgEl(NS, 'text', {
        x: x10 + barW / 2, y: y10 - 3,
        'text-anchor': 'middle',
        class: 'fc-value-text',
      });
      v10.textContent = formatNum(p.pm10);
      svg.appendChild(v10);
    }

    /* ── 시간 라벨 (X축) ── */
    const timeTxt = svgEl(NS, 'text', {
      x: cx, y: H - PB + 15,
      'text-anchor': 'middle',
      class: 'fc-axis-text',
    });
    timeTxt.textContent = formatHour(p.datetime, i);
    svg.appendChild(timeTxt);

    /* ── 신뢰도 % ── */
    const confTxt = svgEl(NS, 'text', {
      x: cx, y: H - PB + 28,
      'text-anchor': 'middle',
      class: 'fc-conf-text',
    });
    confTxt.textContent = `${Math.round(conf * 100)}%`;
    svg.appendChild(confTxt);
  });

  el.forecastChart.innerHTML = '';
  el.forecastChart.appendChild(svg);
}

/* ── 타임라인 파이프 ─────────────────────────────────────────── */
function renderTimeline(predictions) {
  el.timelineRow.innerHTML = '';
  predictions.forEach((p, i) => {
    const pip = document.createElement('div');
    pip.className = 'timeline-pip';
    pip.setAttribute('data-grade', p.grade ?? '');
    pip.setAttribute('role', 'listitem');
    pip.title = `${formatHour(p.datetime, i)} — ${GRADE_LABEL[p.grade] ?? p.grade} (신뢰도 ${Math.round((p.confidence ?? .8) * 100)}%)`;
    el.timelineRow.appendChild(pip);
  });
}

/* ── 자동 갱신 ───────────────────────────────────────────────── */
function scheduleRefresh() {
  clearInterval(_refreshTimer);
  clearInterval(_countdownTimer);

  _nextRefreshAt = Date.now() + REFRESH_MS;
  tickCountdown();

  _countdownTimer = setInterval(tickCountdown, 1000);
  _refreshTimer   = setInterval(() => {
    clearInterval(_countdownTimer);
    fetchAndRender();
  }, REFRESH_MS);
}

function tickCountdown() {
  const sec = Math.max(0, Math.round((_nextRefreshAt - Date.now()) / 1000));
  const m   = Math.floor(sec / 60);
  const s   = sec % 60;
  if (el.nextRefresh) {
    el.nextRefresh.textContent = `${m}:${String(s).padStart(2, '0')}`;
  }
}

/* ── UI 헬퍼 ─────────────────────────────────────────────────── */
function showLoading(on) {
  if (on) {
    el.loading.classList.remove('hidden');
  } else {
    el.loading.classList.add('hidden');
    el.app.hidden = false;
  }
}

function showError(msg) {
  el.errorText.textContent = msg || '알 수 없는 오류가 발생했습니다.';
  el.errorBanner.hidden = false;
}

function setGrade(domEl, grade) {
  domEl.setAttribute('data-grade', grade ?? '');
}

function setLastUpdated(isoStr) {
  try {
    const d  = new Date(isoStr);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    el.lastUpdated.textContent = `${hh}:${mm} 갱신됨`;
  } catch {
    el.lastUpdated.textContent = '방금 갱신됨';
  }
}

/* ── 유틸 ───────────────────────────────────────────────────── */
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function formatNum(v) {
  if (v == null) return '–';
  const n = Number(v);
  return isNaN(n) ? '–' : (Number.isInteger(n) ? String(n) : n.toFixed(1));
}

function formatHour(datetime, fallbackIdx) {
  try {
    if (datetime) {
      const d = new Date(datetime);
      if (!isNaN(d.getTime())) return `${d.getHours()}시`;
    }
  } catch { /* ignore */ }
  return `+${(fallbackIdx ?? 0) + 1}h`;
}

function formatTime(isoStr) {
  try {
    const d  = new Date(isoStr);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  } catch {
    return '–';
  }
}

/**
 * el_(tag, className, text) — 간단한 요소 생성 헬퍼
 */
function el_(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls)  e.className   = cls;
  if (text != null) e.textContent = text;
  return e;
}

/**
 * svgEl(ns, tag, attrs) — SVG 요소 생성 헬퍼
 */
function svgEl(ns, tag, attrs) {
  const e = document.createElementNS(ns, tag);
  for (const [k, v] of Object.entries(attrs)) {
    e.setAttribute(k, v);
  }
  return e;
}
