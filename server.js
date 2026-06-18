'use strict';
/**
 * server.js
 * 공기질 AI 예보 백엔드 — 순수 Node.js HTTP (포트 3000)
 * express 없음: 내장 http + url + fs 만 사용
 */

const http = require('http');
const url  = require('url');
const fs   = require('fs');
const path = require('path');

const trainer       = require('./ai/trainer');
const { predict }   = require('./ai/predictor');
const dataService   = require('./ai/data-service');

const PORT       = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ── 지원 측정소 (확정 목록) ────────────────────────────────────────────────────
const STATIONS = [
  { id: '111123', name: '종로구' },
  { id: '111261', name: '강남구' },
  { id: '111171', name: '은평구' },
];
const VALID_IDS = new Set(STATIONS.map(s => s.id));

// ── 공통 헤더 ─────────────────────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin' : '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── 응답 헬퍼 ─────────────────────────────────────────────────────────────────
function sendJSON(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
  res.end(body);
}

function sendError(res, message, status = 500) {
  sendJSON(res, { error: message }, status);
}

// ── 정적 파일 서빙 (public/) ──────────────────────────────────────────────────
const MIME_MAP = {
  '.html': 'text/html; charset=utf-8',
  '.css' : 'text/css; charset=utf-8',
  '.js'  : 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png' : 'image/png',
  '.jpg' : 'image/jpeg',
  '.svg' : 'image/svg+xml',
  '.ico' : 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(res, reqPath) {
  // 경로 정규화 — directory traversal 방지
  const safe     = path.normalize('/' + reqPath).replace(/\.\./g, '');
  let   filePath = path.join(PUBLIC_DIR, safe || 'index.html');

  // 디렉터리 → index.html
  try {
    if (fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
  } catch (_) { /* 파일 없음 */ }

  // 파일 없으면 SPA fallback: index.html
  if (!fs.existsSync(filePath)) {
    const index = path.join(PUBLIC_DIR, 'index.html');
    if (!fs.existsSync(index)) {
      sendError(res, 'public/index.html 없음 — 프론트엔드 빌드 필요', 404);
      return;
    }
    filePath = index;
  }

  const ext  = path.extname(filePath).toLowerCase();
  const mime = MIME_MAP[ext] || 'application/octet-stream';
  const body = fs.readFileSync(filePath);

  res.writeHead(200, { 'Content-Type': mime, ...CORS });
  res.end(body);
}

// ── 라우터 ────────────────────────────────────────────────────────────────────
async function handleRequest(req, res) {
  const { pathname } = url.parse(req.url, true);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    sendError(res, 'Method Not Allowed', 405);
    return;
  }

  try {
    // ── GET /health ──────────────────────────────────────────────────────────
    if (pathname === '/health') {
      sendJSON(res, { status: 'ok', trained: trainer.isTrained() });
      return;
    }

    // ── GET /api/stations ────────────────────────────────────────────────────
    if (pathname === '/api/stations') {
      sendJSON(res, { stations: STATIONS });
      return;
    }

    // ── GET /api/forecast/all ────────────────────────────────────────────────
    if (pathname === '/api/forecast/all') {
      if (!trainer.isTrained()) {
        sendError(res, '모델 훈련 중입니다. 잠시 후 재시도하세요.', 503);
        return;
      }

      const forecasts = await Promise.all(
        STATIONS.map(async s => {
          const readings = await dataService.getReadings(s.id);
          const result   = predict(s.id, readings);
          return { ...result, stationName: s.name };
        })
      );

      sendJSON(res, {
        forecasts,
        stationCount : forecasts.length,
        fetchedAt    : new Date().toISOString(),
      });
      return;
    }

    // ── GET /api/predict/:stationId ──────────────────────────────────────────
    const predictMatch = pathname.match(/^\/api\/predict\/([^/]+)$/);
    if (predictMatch) {
      const stationId = predictMatch[1];

      if (!VALID_IDS.has(stationId)) {
        sendError(res, `지원하지 않는 측정소: ${stationId}. 유효: ${[...VALID_IDS].join(', ')}`, 400);
        return;
      }
      if (!trainer.isTrained()) {
        sendError(res, '모델 훈련 중입니다. 잠시 후 재시도하세요.', 503);
        return;
      }

      const readings = await dataService.getReadings(stationId);
      const result   = predict(stationId, readings);
      sendJSON(res, result);
      return;
    }

    // ── GET / 및 정적 파일 ────────────────────────────────────────────────────
    const staticPath = pathname === '/' ? 'index.html' : pathname.slice(1);
    serveStatic(res, staticPath);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Server] 요청 오류 [${pathname}]:`, msg);
    sendError(res, msg);
  }
}

// ── 서버 기동 ─────────────────────────────────────────────────────────────────
async function start() {
  console.log('[Server] 초기화 — 3개 측정소 모델 훈련 시작 (5~10초 예상)...');

  try {
    await trainer.train();
  } catch (err) {
    console.error('[Server] 훈련 실패:', err.message);
    process.exit(1);
  }

  // 데이터 서비스 5분 자동 갱신 시작
  dataService.startAutoRefresh();

  const server = http.createServer(handleRequest);

  server.on('error', err => {
    console.error('[Server] 서버 오류:', err.message);
    if (err.code === 'EADDRINUSE') {
      console.error(`[Server] 포트 ${PORT} 이미 사용 중`);
      process.exit(1);
    }
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] ✅ ready — http://localhost:${PORT}`);
    console.log('[Server] 엔드포인트:');
    console.log(`  GET /health`);
    console.log(`  GET /api/stations`);
    console.log(`  GET /api/predict/:stationId`);
    console.log(`  GET /api/forecast/all`);
    console.log(`  GET /  (static: public/)`);
  });
}

start();
