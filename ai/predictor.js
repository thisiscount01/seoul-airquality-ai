'use strict';
/**
 * predictor.js
 * 추론 래퍼 — trainer 모델로 PM2.5/PM10 1-6h 예측 + 신뢰도 + 등급 반환.
 *
 * 반환 형식 (확정된 인터페이스):
 * {
 *   station: "111123",
 *   baseTime: ISO8601,
 *   predictions: [{ hour, datetime, pm25, pm10, grade, confidence }, ...×6],
 *   modelVersion: "1.0.0",
 *   fetchedAt: ISO8601,
 *   _inferenceMs: number
 * }
 */

const trainer = require('./trainer');

const MODEL_VERSION = '1.0.0';

// ── 등급 기준 (확정: PM2.5 < 15 / < 35 / < 75 / 75+) ─────────────────────
function getGrade(pm25) {
  if (pm25 < 15) return 'good';
  if (pm25 < 35) return 'moderate';
  if (pm25 < 75) return 'unhealthy';
  return 'very_unhealthy';
}

/**
 * 신뢰도 산출:
 *   confidence(h) = 1 / (1 + horizonMAE[h] / 18)
 *   → MAE=0: 1.0 / MAE=18: 0.5 / MAE=36: 0.33
 *   UX 범위 [0.25, 0.97]로 스케일링
 */
function calcConfidence(mae) {
  const raw = 1 / (1 + mae / 18);
  const scaled = 0.25 + raw * 0.72;
  return Math.round(scaled * 100) / 100;
}

/**
 * predict(stationId, recentReadings) → prediction object
 *
 * @param {string} stationId   - 에어코리아 측정소 코드 (예: "111123")
 * @param {Array}  recentReadings - 최근 24개 이상의 reading 배열 (newest last)
 *   각 항목: { pm25: number, hour?: number, dayOfWeek?: number }
 * @returns {object} 예측 결과
 */
function predict(stationId, recentReadings) {
  const t0 = Date.now();

  if (!trainer.isTrained()) {
    throw new Error('[Predictor] 모델 미훈련. trainer.train() 먼저 호출 필요.');
  }

  const net = trainer.getModel(stationId);
  if (!net) {
    throw new Error(`[Predictor] 측정소 ${stationId} 모델 없음`);
  }

  if (!Array.isArray(recentReadings) || recentReadings.length < trainer.WINDOW) {
    throw new Error(
      `[Predictor] readings 부족: 최소 ${trainer.WINDOW}개 필요, ${recentReadings.length}개 수신`
    );
  }

  // 최근 24h 슬라이스
  const last24  = recentReadings.slice(-trainer.WINDOW);
  const latest  = last24[last24.length - 1];
  const nowDate = new Date();

  const hour = (latest.hour !== undefined && latest.hour !== null)
    ? latest.hour
    : nowDate.getHours();
  const dow = (latest.dayOfWeek !== undefined && latest.dayOfWeek !== null)
    ? latest.dayOfWeek
    : nowDate.getDay();

  // 입력 벡터 (28차원)
  const input = [
    ...last24.map(r => trainer.normalize(r.pm25)),
    Math.sin(2 * Math.PI * hour  / 24),
    Math.cos(2 * Math.PI * hour  / 24),
    Math.sin(2 * Math.PI * dow   /  7),
    Math.cos(2 * Math.PI * dow   /  7),
  ];

  const rawOutput   = net.run(input);
  const horizonMAE  = trainer.getHorizonMAE(stationId);
  const baseDateMs  = nowDate.getTime();
  const baseTime    = nowDate.toISOString();

  const predictions = Array.from({ length: trainer.HORIZONS }, (_, i) => {
    const pm25raw = trainer.denormalize(rawOutput[i]);
    const pm25    = Math.max(1, Math.round(pm25raw * 10) / 10);
    const pm10    = Math.max(2, Math.round(pm25 * 1.8 * 10) / 10); // PM2.5 × 1.8 추정
    const dt      = new Date(baseDateMs + (i + 1) * 3_600_000).toISOString();

    return {
      hour       : i + 1,
      datetime   : dt,
      pm25,
      pm10,
      grade      : getGrade(pm25),
      confidence : calcConfidence(horizonMAE[i]),
    };
  });

  const inferenceMs = Date.now() - t0;

  return {
    station      : stationId,
    baseTime,
    predictions,
    modelVersion : MODEL_VERSION,
    fetchedAt    : new Date().toISOString(),
    _inferenceMs : inferenceMs,
  };
}

module.exports = { predict, getGrade };
