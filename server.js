/**
 * server.js — минимальный статический сервер без зависимостей (Termux / локальная отладка).
 *
 * Запуск:   node server.js            → http://localhost:8080
 *           PORT=9000 node server.js  → другой порт
 *
 * ВАЖНО (secure context): открывать страницу нужно по http://localhost:PORT.
 * Только localhost (и https) считаются «безопасным контекстом» — иначе браузер
 * запретит Web MIDI и Web Bluetooth. Если сервер запущен в Termux на самом
 * телефоне — просто откройте http://localhost:8080 в Chrome на этом же телефоне.
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

/** Расширение → MIME-тип (нужны минимум html/js/аудио). */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let filePath = path.normalize(path.join(ROOT, urlPath));

    // Защита от выхода за пределы каталога проекта (../../etc/passwd и т.п.)
    if (!filePath.startsWith(ROOT)) return send(res, 403, 'Forbidden');

    let st = await fsp.stat(filePath).catch(() => null);
    if (st && st.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      st = await fsp.stat(filePath).catch(() => null);
    }
    if (!st || !st.isFile()) {
      console.log(`404 ${req.method} ${urlPath}`);
      return send(res, 404, `Not found: ${urlPath}`);
    }

    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const headers = {
      'Content-Type': type,
      'Cache-Control': 'no-store', // чтобы на телефоне не залипали старые версии js/html
      'Accept-Ranges': 'bytes',
    };

    // Range-запросы (пригодится, если открывать аудио тегом <audio>/<video>)
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      let start = m && m[1] ? Number(m[1]) : 0;
      let end = m && m[2] ? Number(m[2]) : st.size - 1;
      start = Math.max(0, Math.min(start, st.size - 1));
      end = Math.min(end, st.size - 1);
      if (start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(filePath, { start, end }).pipe(res);
    }

    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    console.error(e);
    send(res, 500, 'Internal error');
  }
});

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

server.listen(PORT, HOST, () => {
  console.log('x-sequence: сервер запущен.');
  console.log(`  локально:  http://localhost:${PORT}   ← открывать в Chrome на этом устройстве`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const it of list || []) {
      if (it.family === 'IPv4' && !it.internal) {
        console.log(`  по сети:   http://${it.address}:${PORT}   (тут Web MIDI/Bluetooth не работают без HTTPS)`);
      }
    }
  }
});
