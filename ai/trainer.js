'use strict';
/**
 * trainer.js
 * brain.js NeuralNetwork — 측정소별 PM2.5 1-6h 예측 모델 훈련.
 *
 * 입력(28차원):
 *   - prev24h PM2.5 정규화값 × 24
 *   - sin/cos(hour), sin/cos(dayOfWeek) × 4
 * 출력(6차원):
 *   - hour+1 ~ hour+6 PM2.5 정규화값
 *
 * 성공기준:
 *   - 60초 이내 완료
 *   - hold-out 20% MAE ≤ 15 μg/m³
 */

const brain       = require('./brain-loader');
const { stations, readings: allReadings } = require('./sample-data');

// ── 상수 ─────────────────────────────────────────────────────────────────────
const PM25_MAX  = 150;  // 정규화 상한
const WINDOW    = 24;   // 슬라이딩 윈도우 크기 (h)
const HORIZONS  = 6;    // 예측 시간 수

const normalize   = v => Math.min(1, Math.max(0, v / PM25_MAX));
const denormalize = v => v * PM25_MAX;

// ── 슬라이딩 윈도우 샘플 생성 ────────────────────────────────────────────────
function buildSamples(stationReadings) {
  const n       = stationReadings.length;
  const samples = [];

  for (let i = WINDOW; i < n - HORIZONS; i++) {
    const window  = stationReadings.slice(i - WINDOW, i);
    const targets = stationReadings.slice(i, i + HORIZONS);

    const ref  = stationReadings[i];
    const hour = ref.hour;
    const dow  = ref.dayOfWeek;

    const input = [
      ...window.map(r => normalize(r.pm25)),
      Math.sin(2 * Math.PI * hour   / 24),
      Math.cos(2 * Math.PI * hour   / 24),
      Math.sin(2 * Math.PI * dow    /  7),
      Math.cos(2 * Math.PI * dow    /  7),
    ];

    const output = targets.map(r => normalize(r.pm25));

    samples.push({ input, output });
  }

  return samples;
}

// ── 평가: 전체 MAE ──────────────────────────────────────────────────────────
function computeMAE(net, samples) {
  let total = 0, count = 0;
  for (const s of samples) {
    const pred = net.run(s.input);
    for (let h = 0; h < HORIZONS; h++) {
      total += Math.abs(denormalize(s.output[h]) - denormalize(pred[h]));
      count++;
    }
  }
  return count > 0 ? total / count : 999;
}

// ── 평가: 시간별 MAE (신뢰도 산출용) ────────────────────────────────────────
function computeHorizonMAE(net, samples) {
  const totals = new Array(HORIZONS).fill(0);
  for (const s of samples) {
    const pred = net.run(s.input);
    for (let h = 0; h < HORIZONS; h++) {
      totals[h] += Math.abs(denormalize(s.output[h]) - denormalize(pred[h]));
    }
  }
  return totals.map(t => t / samples.length);
}

// ── 상태 저장소 ───────────────────────────────────────────────────────────────
const state = {
  models     : new Map(),  // stationId → brain.NeuralNetwork
  horizonMAE : new Map(),  // stationId → number[6]
  trained    : false,
};

// ── 훈련 메인 ────────────────────────────────────────────────────────────────
async function train() {
  console.log(`[Trainer] 시작: ${stations.length}개 측정소`);
  const t0 = Date.now();

  for (const station of stations) {
    const stationReadings = allReadings.filter(r => r.stationId === station.id);
    const samples         = buildSamples(stationReadings);

    // 80:20 split (시간 순서 유지)
    const splitIdx = Math.floor(samples.length * 0.8);
    const trainSet = samples.slice(0, splitIdx);
    const holdSet  = samples.slice(splitIdx);

    console.log(
      `[Trainer] ${station.name}(${station.id}): ` +
      `train=${trainSet.length}, hold=${holdSet.length}`
    );

    const net = new brain.NeuralNetwork({
      hiddenLayers : [32, 16],
      activation   : 'sigmoid',
      learningRate : 0.05,
      momentum     : 0.1,
    });

    const result = net.train(trainSet, {
      iterations  : 500,
      errorThresh : 0.003,
      log         : false,
      logPeriod   : 100,
    });

    const mae  = computeMAE(net, holdSet);
    const hMAE = computeHorizonMAE(net, holdSet);

    state.models.set(station.id, net);
    state.horizonMAE.set(station.id, hMAE);

    const maeStatus = mae <= 15 ? '✓' : '✗';
    console.log(
      `[Trainer] ${station.name}: ` +
      `iter=${result.iterations}, err=${result.error.toFixed(4)}, ` +
      `MAE=${mae.toFixed(2)} μg/m³ ${maeStatus} ` +
      `[${hMAE.map(m => m.toFixed(1)).join(', ')}]`
    );
  }

  state.trained = true;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[Trainer] 완료: ${elapsed}s`);
  return state;
}

function getModel(stationId)     { return state.models.get(stationId)     || null; }
function getHorizonMAE(stationId){ return state.horizonMAE.get(stationId) || new Array(HORIZONS).fill(15); }
function isTrained()             { return state.trained; }

module.exports = {
  train,
  getModel,
  getHorizonMAE,
  isTrained,
  normalize,
  denormalize,
  PM25_MAX,
  WINDOW,
  HORIZONS,
};
