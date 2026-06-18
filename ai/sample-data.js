'use strict';
/**
 * sample-data.js
 * 서울 3개 측정소(종로구·강남구·은평구) 1년(8760h) 시뮬레이션 데이터.
 * 실제 계절성(겨울 高·여름 低), 일변화(오전 8-9시 피크), 황사 이벤트 반영.
 * Mulberry32 PRNG(seed=0xC0FFEE42) 사용 — 재현 가능 결정론적 생성.
 */

// ── PRNG ─────────────────────────────────────────────────────────────────────
function createPRNG(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const prng = createPRNG(0xc0ffee42);

// ── 측정소 정의 ───────────────────────────────────────────────────────────────
const STATIONS = [
  { id: '111123', name: '종로구', pmOffset: 2.5 },   // 도심 교통량 높음
  { id: '111261', name: '강남구', pmOffset: -1.0 },  // 상대적 양호
  { id: '111171', name: '은평구', pmOffset: 3.8 },   // 북한산 기류 정체
];

// ── 월별 PM2.5 기본값 (μg/m³) ─────────────────────────────────────────────────
// 1월~12월 순 — 서울 실측 기반 추정
const MONTHLY_BASE = [46, 43, 36, 29, 24, 14, 11, 12, 19, 25, 34, 43];

// ── 시간대별 배율 (0-23h) ─────────────────────────────────────────────────────
// 출퇴근 러시아워(7-9h, 17-19h) 피크, 심야 최저
function hourMultiplier(h) {
  const morning = 0.40 * Math.exp(-0.5 * Math.pow((h - 8) / 1.8, 2));
  const evening = 0.22 * Math.exp(-0.5 * Math.pow((h - 18) / 2.0, 2));
  const base = 0.72;
  return base + morning + evening;
}

// ── 황사 이벤트 생성 (3-5월 집중) ────────────────────────────────────────────
function generateDustEvents() {
  const events = [];
  const count = 4 + Math.floor(prng() * 4); // 4-7회
  for (let i = 0; i < count; i++) {
    // 3월 1일(h=1416) ~ 5월 31일(h=3624) 범위
    const startH = 1416 + Math.floor(prng() * (3624 - 1416));
    const duration = 24 + Math.floor(prng() * 73);   // 1-4일
    const intensity = 35 + prng() * 60;               // 35-95 μg/m³ 추가
    events.push({ startH, duration, intensity });
  }
  return events;
}

function dustAt(h, events) {
  let extra = 0;
  for (const e of events) {
    if (h >= e.startH && h < e.startH + e.duration) {
      const p = (h - e.startH) / e.duration;
      // 삼각 형태: 0.3 지점 피크, 앞·뒤 선형 감쇠
      const shape = p < 0.3 ? p / 0.3 : (1 - p) / 0.7;
      extra += e.intensity * Math.max(0, shape);
    }
  }
  return extra;
}

// ── Box-Muller 가우시안 노이즈 ────────────────────────────────────────────────
function gaussNoise(sigma) {
  const u1 = Math.max(prng(), 1e-10);
  const u2 = prng();
  return sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ── 등급 계산 ─────────────────────────────────────────────────────────────────
function getGrade(pm25) {
  if (pm25 < 15) return 'good';
  if (pm25 < 35) return 'moderate';
  if (pm25 < 75) return 'unhealthy';
  return 'very_unhealthy';
}

// ── 데이터 생성 ───────────────────────────────────────────────────────────────
function generate() {
  const START_MS = new Date('2025-01-01T00:00:00+09:00').getTime();
  const TOTAL_HOURS = 8760; // 365일
  const dustEvents = generateDustEvents();
  const readings = [];

  for (const station of STATIONS) {
    for (let h = 0; h < TOTAL_HOURS; h++) {
      const ts = new Date(START_MS + h * 3600000);
      const month = ts.getMonth();     // 0-based
      const hour  = ts.getHours();
      const dow   = ts.getDay();       // 0=일

      const monthBase    = MONTHLY_BASE[month];
      const dayMult      = hourMultiplier(hour);
      const weekendFact  = (dow === 0 || dow === 6) ? 0.87 : 1.0;
      const dust         = dustAt(h, dustEvents);
      const noise        = gaussNoise(4.5); // σ≈4.5 μg/m³

      const pm25Raw = monthBase * dayMult * weekendFact + dust + station.pmOffset + noise;
      const pm25    = Math.max(2, parseFloat(pm25Raw.toFixed(1)));

      // PM10: PM2.5 × (1.55 ± 0.2) — 랜덤 가중
      const pm10Ratio = 1.55 + (prng() - 0.5) * 0.4;
      const pm10 = Math.max(4, parseFloat((pm25 * pm10Ratio).toFixed(1)));

      readings.push({
        stationId  : station.id,
        timestamp  : ts.toISOString(),
        pm25,
        pm10,
        hour,
        dayOfWeek  : dow,
        month      : month + 1, // 1-based
        hourIndex  : h,
        grade      : getGrade(pm25),
      });
    }
  }

  return { stations: STATIONS, readings };
}

module.exports = generate();
