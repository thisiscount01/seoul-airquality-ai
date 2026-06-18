'use strict';
/**
 * data-service.js
 * 실시간 대기질 데이터 fetch + 24h 메모리 캐시 + sample-data fallback.
 *
 * AQICN 무료 demo 토큰 사용:
 *   https://api.waqi.info/feed/{station}/?token=demo
 *
 * 응답 파싱 → { pm25, pm10, time, grade } 정규화
 * fetch 실패 시 sample-data 최신값으로 자동 fallback.
 * 5분 자동 갱신(startAutoRefresh 호출 시).
 */

const fetch = require('node-fetch');
const { stations, readings: sampleReadings } = require('./sample-data');

// ── AQICN endpoint 매핑 ───────────────────────────────────────────────────────
// demo 토큰은 공개 도시명 또는 station ID(@xxx)로 접근 가능
const AQICN_ENDPOINTS = {
  '111123': 'https://api.waqi.info/feed/seoul/?token=demo',         // 종로구 → 서울 대표
  '111261': 'https://api.waqi.info/feed/@3799/?token=demo',         // 강남구 → Seoul(US Embassy)
  '111171': 'https://api.waqi.info/feed/@4163/?token=demo',         // 은평구 → Dobong
};
const FETCH_TIMEOUT_MS = 6000;
const CACHE_TTL_MS     = 5 * 60 * 1000;  // 5분

// ── 등급 ─────────────────────────────────────────────────────────────────────
function getGrade(pm25) {
  if (pm25 < 15) return 'good';
  if (pm25 < 35) return 'moderate';
  if (pm25 < 75) return 'unhealthy';
  return 'very_unhealthy';
}

// ── 인메모리 캐시 (stationId → { readings: [], lastFetch: epoch }) ──────────
const cache = new Map();

// ── AQICN API 단일 호출 ───────────────────────────────────────────────────────
async function fetchLiveReading(stationId) {
  const url = AQICN_ENDPOINTS[stationId];
  if (!url) return null;

  try {
    const res = await fetch(url, { timeout: FETCH_TIMEOUT_MS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();
    if (json.status !== 'ok') throw new Error(`AQICN status=${json.status}`);

    const d    = json.data;
    const iaqi = d.iaqi || {};

    const pm25Raw = iaqi.pm25 ? Number(iaqi.pm25.v) : null;
    if (pm25Raw === null || isNaN(pm25Raw)) {
      throw new Error('PM2.5 데이터 없음');
    }

    const pm10Raw  = iaqi.pm10 ? Number(iaqi.pm10.v) : pm25Raw * 1.8;
    const timeStr  = (d.time && d.time.iso) ? d.time.iso : new Date().toISOString();
    const ts       = new Date(timeStr);

    return {
      stationId,
      timestamp  : ts.toISOString(),
      pm25       : Math.max(1, parseFloat(pm25Raw.toFixed(1))),
      pm10       : Math.max(2, parseFloat(pm10Raw.toFixed(1))),
      hour       : ts.getHours(),
      dayOfWeek  : ts.getDay(),
      grade      : getGrade(pm25Raw),
      source     : 'live',
    };
  } catch (err) {
    console.warn(`[DataService] ${stationId} API 실패 (${err.message}) → fallback`);
    return null;
  }
}

// ── sample-data에서 최근 N개 추출 ────────────────────────────────────────────
function getSampleReadings(stationId, count) {
  return sampleReadings
    .filter(r => r.stationId === stationId)
    .slice(-count)
    .map(r => ({
      stationId  : r.stationId,
      timestamp  : r.timestamp,
      pm25       : r.pm25,
      pm10       : r.pm10,
      hour       : r.hour,
      dayOfWeek  : r.dayOfWeek,
      grade      : getGrade(r.pm25),
      source     : 'sample',
    }));
}

// ── 캐시 갱신 (24h 슬라이딩 윈도우 유지) ─────────────────────────────────────
async function refreshCache(stationId) {
  const live   = await fetchLiveReading(stationId);
  const now    = Date.now();
  const prev   = cache.has(stationId)
    ? cache.get(stationId).readings
    : getSampleReadings(stationId, 23);

  let readings;
  if (live) {
    // 최신 live 값을 슬라이딩 윈도우 끝에 추가, 최대 24개 유지
    readings = [...prev.slice(-23), live];
  } else {
    // 완전 fallback: sample-data로 채움 (다음 TTL 전에 재시도)
    readings = getSampleReadings(stationId, 24);
  }

  cache.set(stationId, { readings, lastFetch: now });
  return readings;
}

// ── 공개 API: getReadings ─────────────────────────────────────────────────────
/**
 * 측정소의 최근 24h reading 배열 반환 (newest last).
 * 캐시 TTL 초과 시 자동 갱신.
 */
async function getReadings(stationId) {
  const cached = cache.get(stationId);
  const now    = Date.now();

  if (!cached || now - cached.lastFetch > CACHE_TTL_MS) {
    return await refreshCache(stationId);
  }
  return cached.readings;
}

// ── 공개 API: getCurrentReading ───────────────────────────────────────────────
async function getCurrentReading(stationId) {
  const readings = await getReadings(stationId);
  return readings[readings.length - 1] || null;
}

// ── 공개 API: getAllStationsCurrentData ──────────────────────────────────────
async function getAllStationsCurrentData() {
  return Promise.all(
    stations.map(async s => {
      const current = await getCurrentReading(s.id);
      return { ...s, current };
    })
  );
}

// ── 5분 자동 갱신 ────────────────────────────────────────────────────────────
function startAutoRefresh() {
  const tick = async () => {
    for (const s of stations) {
      try {
        await refreshCache(s.id);
      } catch (e) {
        console.error(`[DataService] 자동갱신 오류 ${s.id}:`, e.message);
      }
    }
  };

  setInterval(tick, CACHE_TTL_MS);
  console.log('[DataService] 5분 자동갱신 시작');
}

// ── 초기 캐시 워밍 (import 시 sample-data로 즉시 채움) ─────────────────────
for (const s of stations) {
  const readings = getSampleReadings(s.id, 24);
  cache.set(s.id, { readings, lastFetch: 0 }); // lastFetch=0 → 첫 getReadings 시 즉시 live 시도
}

module.exports = {
  getReadings,
  getCurrentReading,
  getAllStationsCurrentData,
  startAutoRefresh,
  getGrade,
  stations,
};
