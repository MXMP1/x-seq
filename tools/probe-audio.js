/**
 * probe-audio.js — предварительный анализ аудиофайлов без зависимостей.
 *
 *   • MP3: длительность считается по кадрам (корректно и для VBR);
 *   • WAV: длительность по чанку data / byteRate;
 *   • для лупов с BPM в имени (techno_128bpm.mp3) показывает, сколько тактов
 *     занимает файл и насколько он «ровный» (хвост реверба и т.п. виден сразу).
 *
 * Запуск: npm run probe   (или: node tools/probe-audio.js)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBpmFromName } from '../engine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIBRARY = path.join(ROOT, 'library');

const SR = {
  3: [44100, 48000, 32000], // MPEG1
  2: [22050, 24000, 16000], // MPEG2
  0: [11025, 12000, 8000],  // MPEG2.5
};
/** Таблицы битрейтов (kbps) по семейству и слою. */
const BR = {
  '1-L1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-L2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-L3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-L1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-L2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-L3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

/** @returns {{duration:number, frames:number}} секунды и число кадров */
function mp3Info(buf) {
  let pos = 0;
  if (buf.length > 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    // ID3v2: пропускаем тег (syncsafe integer в байтах 6..9)
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    pos = 10 + size;
  }
  let duration = 0;
  let frames = 0;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff || (buf[pos + 1] & 0xe0) !== 0xe0) { pos++; continue; }
    const b1 = buf[pos + 1];
    const b2 = buf[pos + 2];
    const verBits = (b1 >> 3) & 0x03;
    const layerBits = (b1 >> 1) & 0x03;
    const brIdx = (b2 >> 4) & 0x0f;
    const srIdx = (b2 >> 2) & 0x03;
    const pad = (b2 >> 1) & 0x01;
    if (verBits === 1 || layerBits === 0 || brIdx === 0 || brIdx === 15 || srIdx === 3) { pos++; continue; }

    const sr = SR[verBits][srIdx];
    const family = verBits === 3 ? 1 : 2;
    const layer = 4 - layerBits; // 1..3
    const br = BR[`${family}-L${layer}`][brIdx] * 1000;
    const spf = layer === 1 ? 384 : layer === 2 ? 1152 : family === 1 ? 1152 : 576;
    const frameLen = layer === 1
      ? Math.floor((12 * br / sr + pad) * 4)
      : Math.floor((spf / 8) * (br / sr)) + pad;
    if (frameLen <= 4) { pos++; continue; }

    duration += spf / sr;
    frames++;
    pos += frameLen;
  }
  return { duration, frames };
}

/** @returns {number|null} длительность WAV в секундах */
function wavDuration(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let pos = 12;
  let byteRate = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ' && pos + 8 + 16 <= buf.length) byteRate = buf.readUInt32LE(pos + 8 + 8);
    if (id === 'data') return byteRate ? size / byteRate : null;
    pos += 8 + size + (size % 2);
  }
  return null;
}

/** Рекурсивный обход каталога (возвращает пути к .mp3/.wav). */
function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(mp3|wav)$/i.test(name)) acc.push(p);
  }
  return acc;
}

const files = walk(LIBRARY).sort();
if (!files.length) {
  console.log(`Не нашёл mp3/wav в ${LIBRARY}`);
  process.exit(0);
}

console.log('файл'.padEnd(38), 'длит., с'.padStart(9), 'такт(ов)'.padStart(9), 'ровность'.padStart(18));
console.log('-'.repeat(78));
for (const f of files) {
  const buf = fs.readFileSync(f);
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  let duration = null;
  let extra = '';
  if (/\.mp3$/i.test(f)) {
    const info = mp3Info(buf);
    duration = info.frames ? info.duration : null;
    extra = `${info.frames} кадр.`;
  } else {
    duration = wavDuration(buf);
  }
  if (duration == null) {
    console.log(rel.padEnd(38), '  не распознан'.padStart(9));
    continue;
  }
  const bpm = parseBpmFromName(rel);
  let barsCol = bpm ? `${(duration * bpm / 240).toFixed(2)} @${bpm} BPM` : 'нет BPM в имени';
  let devCol = extra;
  if (bpm) {
    const bars = Math.max(1, Math.round((duration * bpm) / 240));
    const expected = (bars * 240) / bpm;
    const devMs = (duration - expected) * 1000;
    devCol = `≈${bars} такт, откл. ${devMs >= 0 ? '+' : ''}${devMs.toFixed(0)} мс`;
  }
  console.log(rel.padEnd(38), duration.toFixed(3).padStart(9), barsCol.padStart(9), devCol.padStart(18));
}
console.log('\nОтклонение — насколько длина файла больше «круглого» числа тактов (хвосты, паузы).');
console.log('Движок всё равно растянет луп на целые такты через playbackRate.');
