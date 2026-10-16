/**
 * headless-test.js — проверка ядра без браузера (виртуальные часы и таймеры).
 *
 * Подменяем: AudioContext (currentTime двигаем вручную), setTimeout (копим в
 * «таймерной карте» и «срабатываем» по виртуальному времени), MIDI-выход
 * (записываем отправленные байты с точным временем).
 *
 * Секции:
 *   A. Сетка шага: дрейф за 10 минут, ровность проходов лупа.
 *   B. Ноты: парность noteOn/noteOff, gate, velocity.
 *   C. Смена BPM: применяется на границе шага, луп пересчитывает скорость.
 *   D. Стоп: all-notes-off, отмена очередей, фейд лупа, повторный стоп.
 *   E. Визуальная очередь: порядок шагов и запаздывание подсветки.
 *
 * Запуск: npm test
 */
import { SequencerEngine, parseBpmFromName, MidiReceiver, noteLabel, parseMidiFile, buildPatternFromMidi, encodeMidiFile } from '../engine.js';

/* ==================== фиктивный Web Audio ==================== */

class FakeParam {
  constructor(v) { this.value = v; }
  setTargetAtTime(v) { this.value = v; }
}
class FakeGain {
  constructor() { this.gain = new FakeParam(1); }
  connect() { return arguments[0]; }
  disconnect() {}
}
class FakeSource {
  constructor() {
    this.buffer = null;
    this.playbackRate = new FakeParam(1);
    this.onended = null;
    this.startTime = null;
    this.stopTime = null;
  }
  connect() { return arguments[0]; }
  disconnect() {}
  start(t) { this.startTime = t; }
  stop(t) { this.stopTime = t; }
}
class FakeAudioContext {
  constructor(sources) {
    this.currentTime = 0;
    this.state = 'running';
    this.sampleRate = 48000;
    this.baseLatency = 0.01;
    this.outputLatency = 0.03;
    this.destination = {};
    this._sources = sources;
  }
  createGain() { return new FakeGain(); }
  createBufferSource() { const s = new FakeSource(); this._sources.push(s); return s; }
  resume() { this.state = 'running'; return Promise.resolve(); }
}

/* ==================== «испытательный стенд» ==================== */

function makeHarness({ bpm = 120 } = {}) {
  const sources = [];
  const ctx = new FakeAudioContext(sources);
  const timers = new Map(); // id → { fn, ms, ctxNow, id }
  let nextTimerId = 1;

  const sent = []; // история MIDI-сообщений
  const backend = {
    name: 'fake-midi',
    sendNow(bytes) { sent.push({ bytes: [...bytes], ctxTime: ctx.currentTime }); },
    sendScheduled(bytes) { throw new Error('timestamp-режим в тестах не используется'); },
  };

  const engine = new SequencerEngine({
    audioContext: ctx,
    bpm,
    timerApi: { setInterval: () => 1, clearInterval: () => {} }, // шедулер двигаем вручную
    raf: null,
    setTimer: (fn, ms) => {
      const id = nextTimerId++;
      timers.set(id, { fn, ms, ctxNow: ctx.currentTime, id });
      return id;
    },
    clearTimer: (id) => { timers.delete(id); },
    perfNow: () => ctx.currentTime * 1000,
  });

  // Фиктивный буфер лупа: 2.0 с = ровно 1 такт при 120 BPM
  engine.loop.url = 'fake_120bpm.wav';
  engine.loop.buffer = { duration: 2.0, sampleRate: 48000 };
  engine.loop.sourceBpm = 120;
  engine.loop.bars = 1;
  engine.midi.connect(backend);

  const h = {
    ctx, engine, backend, sources, timers, sent,

    /** «Сработать» таймерам, чьё время уже наступило. */
    fireDue(until) {
      const due = [...timers.values()]
        .filter((t) => t.ctxNow + t.ms / 1000 <= until + 1e-9)
        .sort((a, b) => (a.ctxNow + a.ms / 1000) - (b.ctxNow + b.ms / 1000) || a.id - b.id);
      for (const t of due) {
        timers.delete(t.id);
        const at = t.ctxNow + t.ms / 1000;
        // «Телепорт» ровно в момент срабатывания: как настоящий setTimeout,
        // сработавший вовремя. Отправленные сообщения получают точное время.
        const saved = ctx.currentTime;
        ctx.currentTime = at;
        t.fn();
        ctx.currentTime = saved;
      }
      return due;
    },

    /** Сдвинуть виртуальное время на seconds кусочками по slice (как setInterval 25 мс). */
    advance(seconds, slice = 0.025) {
      const end = ctx.currentTime + seconds;
      while (ctx.currentTime < end - 1e-9) {
        ctx.currentTime = Math.min(end, ctx.currentTime + slice);
        engine.tick();
        h.fireDue(ctx.currentTime);
      }
    },
  };
  return h;
}

/* ==================== отчётность ==================== */

let totalFails = 0;
const fmtMs = (s) => (s * 1000).toFixed(3);

function section(name, body) {
  console.log(`\n=== ${name} ===`);
  let fails = 0;
  const check = (cond, label) => {
    if (!cond) { fails++; console.log(`  ✗ ${label}`); }
    return cond;
  };
  return body(check).then(() => {
    console.log(`  ${name.split('.')[0]}: ${fails ? 'FAIL' : 'PASS'}`);
    totalFails += fails;
  });
}

/* ==================== A. сетка и дрейф ==================== */

await section('A. Сетка: 10 минут при 120 BPM', async (check) => {
  const h = makeHarness({ bpm: 120 });
  await h.engine.initAudio();
  h.engine.matrix[0][0] = 100;
  h.engine.start();

  const times = [];
  const SLICE = 0.025;
  const runSec = 600;
  for (let i = 0; i < Math.round(runSec / SLICE); i++) {
    h.advance(SLICE);
    const ev = h.engine.consumeDueSteps(h.ctx.currentTime);
    if (ev) times.push(ev.time);
  }

  const stepDur = 60 / 120 / 4;
  let minD = Infinity, maxD = -Infinity, maxDev = 0;
  for (let k = 1; k < times.length; k++) {
    const d = times[k] - times[k - 1];
    minD = Math.min(minD, d); maxD = Math.max(maxD, d);
  }
  for (let k = 0; k < times.length; k++) {
    maxDev = Math.max(maxDev, Math.abs(times[k] - (times[0] + k * stepDur)));
  }
  const expectedSteps = Math.floor((runSec - 0.08) / stepDur) + 1;
  console.log(`  событий шага: ${times.length} (ожидалось ${expectedSteps})`);
  console.log(`  интервал: ${fmtMs(minD)}..${fmtMs(maxD)} мс (должен быть ${fmtMs(stepDur)})`);
  console.log(`  макс. отклонение от идеальной прямой: ${(maxDev * 1000).toExponential(2)} мс`);
  check(times.length === expectedSteps, `количество шагов ${times.length} ≠ ${expectedSteps}`);
  check(Math.abs(minD - stepDur) < 1e-9 && Math.abs(maxD - stepDur) < 1e-9, 'интервал шага ≠ stepDuration');
  check(maxDev < 1e-6, 'дрейф сетки за 10 минут');

  const starts = h.sources.map((s) => s.startTime).filter((v) => v != null).sort((a, b) => a - b);
  let lmin = Infinity, lmax = -Infinity;
  for (let k = 1; k < starts.length; k++) {
    const d = starts[k] - starts[k - 1];
    lmin = Math.min(lmin, d); lmax = Math.max(lmax, d);
  }
  const rates = [...new Set(h.sources.map((s) => +s.playbackRate.value.toFixed(6)))];
  console.log(`  проходов лупа: ${starts.length}, интервал ${fmtMs(lmin)}..${fmtMs(lmax)} мс (такт = 2000.000), rate: ${rates.join(', ')}`);
  check(starts.length >= 299 && starts.length <= 301, 'количество проходов лупа');
  check(Math.abs(lmin - 2.0) < 1e-9 && Math.abs(lmax - 2.0) < 1e-9, 'проходы лупа не по границам тактов');
  check(rates.length === 1 && Math.abs(rates[0] - 1) < 1e-9, 'playbackRate при 120 BPM ≠ 1');
});

/* ==================== B. ноты и gate ==================== */

await section('B. Ноты: парность noteOn/noteOff, gate, velocity', async (check) => {
  const h = makeHarness({ bpm: 120 });
  await h.engine.initAudio();
  h.engine.matrix[0][0] = 100;
  h.engine.matrix[1][4] = 90;
  h.engine.matrix[2][8] = 110;
  h.engine.matrix[3][12] = 100;
  h.engine.start();
  h.advance(8.0);

  const noteMsgs = h.sent.filter((m) => (m.bytes[0] & 0xf0) === 0x90 || (m.bytes[0] & 0xf0) === 0x80);
  const ons = noteMsgs.filter((m) => (m.bytes[0] & 0xf0) === 0x90);
  const offs = noteMsgs.filter((m) => (m.bytes[0] & 0xf0) === 0x80);
  const cc = h.sent.filter((m) => (m.bytes[0] & 0xf0) === 0xb0);
  console.log(`  за 8 с: noteOn ${ons.length}, noteOff ${offs.length} (ожидалось 16/16), CC ${cc.length} (только стартовый CC123)`);
  check(ons.length === 16 && offs.length === 16, 'количество нотных сообщений');

  let maxGateErr = 0;
  let pairErr = 0;
  for (let i = 0; i < ons.length; i++) {
    maxGateErr = Math.max(maxGateErr, Math.abs((offs[i].ctxTime - ons[i].ctxTime) * 1000 - 62.5));
    if (ons[i].bytes[1] !== offs[i].bytes[1]) pairErr++;
  }
  console.log(`  макс. ошибка длительности ноты (gate 62.5 мс): ${(maxGateErr * 1000).toExponential(2)} мкс; несовпавших пар: ${pairErr}`);
  check(maxGateErr < 1e-6, 'длительность ноты ≠ gate');
  check(pairErr === 0, 'номера нот в парах on/off не совпадают');

  // Порядок: каждому noteOff предшествует noteOn той же ноты, «залипших» нет
  const sounding = new Set();
  let orderOk = true;
  for (const m of [...noteMsgs].sort((a, b) => a.ctxTime - b.ctxTime)) {
    const st = m.bytes[0] & 0xf0;
    if (st === 0x90) sounding.add(m.bytes[1]);
    else if (!sounding.delete(m.bytes[1])) orderOk = false;
  }
  check(orderOk && sounding.size === 0, 'нарушен порядок on→off или остались звучащие ноты');

  const vels = ons.map((m) => m.bytes[2]).sort((a, b) => a - b);
  console.log(`  velocity (по возрастанию): ${JSON.stringify(vels)}`);
  // строки: 100, 90, 110, 100 → за 4 цикла отсортированно: 90×4, 100×8, 110×4
  check(JSON.stringify(vels) === JSON.stringify([90, 90, 90, 90, 100, 100, 100, 100, 100, 100, 100, 100, 110, 110, 110, 110]), 'velocity не из матрицы');
});

/* ==================== C. смена BPM ==================== */

await section('C. Смена BPM: граница шага и пересчёт лупа', async (check) => {
  const h = makeHarness({ bpm: 120 });
  await h.engine.initAudio();
  h.engine.start();
  const times = [];
  h.engine.onStepTrigger = (step, abs, time) => times.push(time);

  const run = (seconds) => {
    const n = Math.round(seconds / 0.025);
    for (let i = 0; i < n; i++) { h.advance(0.025); h.engine.consumeDueSteps(h.ctx.currentTime); }
  };

  run(4.0);
  const beforeCount = times.length;
  h.engine.setBpm(90);
  run(4.0);

  const oldD = 0.125;
  const newD = 60 / 90 / 4;
  const durs = [];
  for (let k = 1; k < times.length; k++) durs.push(times[k] - times[k - 1]);
  const switchIdx = durs.findIndex((d) => Math.abs(d - newD) < 1e-9);
  const beforeClean = durs.slice(0, switchIdx).every((d) => Math.abs(d - oldD) < 1e-9);
  const afterClean = durs.slice(switchIdx).every((d) => Math.abs(d - newD) < 1e-9);
  console.log(`  шагов до/после смены: ${beforeCount}/${times.length - beforeCount}; новая длительность с шага №${switchIdx + 1}`);
  console.log(`  интервалы 125 мс до смены: ${beforeClean ? 'ровно' : 'НЕРОВНО'}; ${fmtMs(newD)} мс после: ${afterClean ? 'ровно' : 'НЕРОВНО'}`);
  check(beforeClean && afterClean, 'граница смены темпа не ровная');

  const starts = h.sources.map((s) => s.startTime).filter((v) => v != null).sort((a, b) => a - b);
  const lastLoopDur = starts[starts.length - 1] - starts[starts.length - 2];
  const rates = [...new Set(h.sources.map((s) => +s.playbackRate.value.toFixed(6)))].sort((a, b) => a - b);
  console.log(`  проходы лупа: последний интервал ${lastLoopDur.toFixed(6)} с (ожидалось ${(8 / 3).toFixed(6)} = такт @90); rate: ${rates.join(', ')}`);
  check(Math.abs(lastLoopDur - 8 / 3) < 1e-6, 'луп после смены темпа не пересчитан');
  check(rates.includes(1) && rates.some((r) => Math.abs(r - 4 / 3) < 1e-6), 'playbackRate не обновился под 90 BPM');
});

/* ==================== D. стоп ==================== */

await section('D. Стоп: all-notes-off, отмена очередей, фейд лупа', async (check) => {
  const h = makeHarness({ bpm: 120 });
  await h.engine.initAudio();
  h.engine.start();
  h.advance(0.5);
  h.engine.matrix[0][8] = 100; // шаг 8 → время 1.08: on ≈ 1.105, off ≈ 1.1675
  h.advance(0.63); // стоп в 1.13 — нота звучит, её noteOff ещё в таймерах

  const sounding = h.engine.midi.soundingNotes;
  const pendingBefore = h.timers.size;
  const before = h.sent.length;
  h.engine.stop();
  const after = h.sent.slice(before);

  console.log(`  в момент стопа: звучит нот ${JSON.stringify(sounding)}, в таймерах ${pendingBefore}`);
  console.log(`  при стопе дослано: ${after.map((m) => `[${m.bytes.join(',')}]`).join(' ')}`);
  check(sounding.includes(60), 'нота 60 не звучала в момент стопа (тест некорректен)');
  check(after.some((m) => m.bytes[0] === 0x80 && m.bytes[1] === 60), 'нет явного noteOff звучащей ноты');
  check(after.some((m) => m.bytes[0] === 0xb0 && m.bytes[1] === 123), 'нет CC123 all-notes-off');
  check(h.timers.size === 0, 'остались запланированные отправки');

  const sentAtStop = h.sent.length;
  h.advance(1.0);
  check(h.sent.length === sentAtStop, 'после стопа ушли новые сообщения');
  check(h.engine._loopSources.size === 0, 'проходы лупа не очищены');
  const stopped = h.sources.filter((s) => s.stopTime != null);
  console.log(`  остановлено проходов лупа: ${stopped.length} (фейд + stop, без щелчка)`);
  check(stopped.length > 0, 'источники лупа не остановлены');
  h.engine.stop(); // повторный стоп не должен падать и слать лишнее
  check(h.sent.length === sentAtStop, 'повторный stop() отправил лишнее');
});

/* ==================== E. визуальная очередь ==================== */

await section('E. Визуальная очередь: порядок и запаздывание', async (check) => {
  const h = makeHarness({ bpm: 120 });
  await h.engine.initAudio();
  const events = [];
  h.engine.onStepTrigger = (step, abs, time) => events.push({ step, abs, time, at: h.ctx.currentTime });
  h.engine.start();
  for (let i = 0; i < 160; i++) { h.advance(0.025); h.engine.consumeDueSteps(h.ctx.currentTime); }

  let orderOk = true;
  let latenessMax = -Infinity;
  for (let i = 0; i < events.length; i++) {
    if (events[i].abs !== i) orderOk = false;
    latenessMax = Math.max(latenessMax, events[i].at - events[i].time);
  }
  console.log(`  событий: ${events.length} (ожидалось 32) — цикл ${events.slice(0, 17).map((e) => e.step + 1).join(',')}...`);
  console.log(`  запаздывание подсветки ≤ ${fmtMs(latenessMax)} мс (обработка раз в 25 мс)`);
  check(events.length === 32, `количество событий ${events.length} ≠ 32`);
  check(orderOk, 'шаги идут с пропусками/дублями');
  check(latenessMax <= 0.025 + 1e-9, 'запаздывание подсветки больше шага обработки');
});

/* ==================== прикладные проверки помощников ==================== */

await section('F. Утилиты', async (check) => {
  const cases = [
    ['techno_128bpm.mp3', 128],
    ['dnb_160bpm.mp3', 160],
    ['loop_90BPM.wav', 90],
    ['kick.mp3', null],
  ];
  for (const [name, want] of cases) {
    check(parseBpmFromName(name) === want, `parseBpmFromName('${name}') ≠ ${want}`);
  }
  console.log(`  parseBpmFromName: ${cases.map(([n, w]) => `${n}→${w}`).join(', ')}`);
});

/* ==================== G. MIDI-вход: парсер и подписки ==================== */

await section('G. MidiReceiver: парсинг статусов, CC-подписки, отписка', async (check) => {
  const r = new MidiReceiver();

  // --- 1. Все типы статусов ---
  const any = [];
  r.onAny((m) => any.push(m));

  r.feed([0x90, 60, 100], 1000);   // NoteOn  ch1
  r.feed([0x80, 60, 0], 1001);      // NoteOff ch1
  r.feed([0x91, 62, 0], 1002);      // NoteOn vel=0 → трактуем как NoteOff ch2
  r.feed([0xb0, 74, 63], 1003);     // CC#74 = 63 ch1
  r.feed([0xb1, 1, 127], 1004);     // CC#1 = 127 ch2
  r.feed([0xc0, 5], 1005);          // ProgramChange #5 ch1
  r.feed([0xe0, 0, 64], 1006);      // PitchBend: (64<<7)|0 = 8192 (центр)
  r.feed([0xf0, 0x7e, 0x7f, 0x09, 0x01, 0xf7], 1007); // SysEx GM On
  r.feed([0xa0, 60, 90], 1008);     // Poly Aftertouch
  r.feed([0xd0, 100], 1009);        // Channel Aftertouch

  const types = any.map((m) => m.type);
  console.log(`  типы: ${types.join(', ')}`);
  check(types[0] === 'noteOn' && any[0].note === 60 && any[0].velocity === 100, 'NoteOn распознан неверно');
  check(types[1] === 'noteOff' && any[1].note === 60, 'NoteOff распознан неверно');
  check(types[2] === 'noteOff' && any[2].velocity === 0 && any[2].channel === 1, 'NoteOn vel=0 не стал NoteOff');
  check(types[3] === 'cc' && any[3].controller === 74 && any[3].value === 63 && any[3].channel === 0, 'CC#74 распознан неверно');
  check(types[4] === 'cc' && any[4].channel === 1, 'канал CC не 2');
  check(types[5] === 'pc' && any[5].program === 5, 'ProgramChange распознан неверно');
  check(types[6] === 'pitchBend' && any[6].value === 8192, `PitchBend: ожидалось 8192, получено ${any[6].value}`);
  check(types[7] === 'sysex', 'SysEx не распознан');
  check(types[8] === 'polyAftertouch' && types[9] === 'channelAftertouch', 'Aftertouch не распознан');
  check(any.length === 10, `ожидалось 10 сообщений, получено ${any.length}`);

  // --- 2. Состояние CC (последние значения) ---
  const st = r.ccState;
  console.log(`  ccState: ${JSON.stringify(st)}`);
  check(st[74] === 63 && st[1] === 127, 'ccState хранит неверные значения');

  // --- 3. Подписка на конкретный CC ---
  const cc74 = [];
  const unsub74 = r.onCCNumber(74, (m) => cc74.push(m.value));
  r.feed([0xb0, 74, 10]);
  r.feed([0xb0, 74, 20]);
  r.feed([0xb0, 1, 30]);    // другой CC — не должен попасть
  check(cc74.length === 2 && cc74[0] === 10 && cc74[1] === 20, 'onCCNumber(74) сработал неверно');

  // --- 4. Отписка ---
  unsub74();
  r.feed([0xb0, 74, 99]);
  check(cc74.length === 2, 'отписка не сработала');

  // --- 5. Ошибка в обработчике не ломает приёмник ---
  const r2 = new MidiReceiver();
  const seen = [];
  r2.onAny(() => { throw new Error('boom'); });
  r2.onAny((m) => seen.push(m.type));
  r2.feed([0xb0, 5, 6]);
  r2.feed([0x90, 60, 100]);
  check(seen.length === 2, 'падающий обработчик заблокировал остальные');
  check(r2.messageCount === 2, 'messageCount не увеличился');

  // --- 6. Пустые/короткие сообщения не падают ---
  const r3 = new MidiReceiver();
  check(r3.feed([]) === null, 'пустой массив должен вернуть null');
  check(r3.feed(null) === null, 'null должен вернуть null');
  const shortMsg = r3.feed([0xc0, 3]);
  check(shortMsg && shortMsg.type === 'pc' && shortMsg.program === 3, 'PC из 2 байт не распознан');

  // --- 7. Подключение к фиктивному бэкенду ---
  const listeners = new Set();
  const fakeBackend = {
    input: { name: 'fake-in' },
    subscribeInput(h) { listeners.add(h); return true; },
    unsubscribeInput(h) { listeners.delete(h); },
  };
  const r4 = new MidiReceiver();
  const got = [];
  r4.onAny((m) => got.push(m));
  const ok = r4.connect(fakeBackend);
  check(ok === true && listeners.size === 1, 'connect() не подписался на бэкенд');
  // Эмулируем браузерное MIDIMessageEvent
  const ev = { data: new Uint8Array([0xb0, 20, 42]), timeStamp: 12345 };
  [...listeners][0](ev);
  check(got.length === 1 && got[0].type === 'cc' && got[0].controller === 20 && got[0].value === 42,
    'событие от бэкенда не дошло до приёмника');
  r4.disconnect();
  check(listeners.size === 0, 'disconnect() не отписался');
});

/* ==================== H. Секвенсор v2: swing, банки, шаги, драмы, serialize ==================== */

await section('H. Секвенсор v2: swing, банки, resize, драмы, serialize/restore', async (check) => {
  // --- 1. noteLabel ---
  check(noteLabel(60) === 'C4' && noteLabel(61) === 'C#4' && noteLabel(0) === 'C-1' && noteLabel(127) === 'G9',
    `noteLabel: ${noteLabel(60)},${noteLabel(61)},${noteLabel(0)},${noteLabel(127)}`);

  // --- 2. setSteps: данные сохраняются при расширении и обрезке ---
  {
    const h = makeHarness();
    h.engine.matrix[0][3] = 100;
    h.engine.drumMatrix[0][5] = 90;
    h.engine.setSteps(32);
    check(h.engine.matrix[0][3] === 100 && h.engine.drumMatrix[0][5] === 90, 'resize 16→32 потерял данные');
    check(h.engine.matrix[0].length === 32, 'resize 16→32 не расширил');
    h.engine.matrix[0][20] = 70;
    h.engine.setSteps(16);
    check(h.engine.matrix[0][3] === 100 && h.engine.matrix[0][20] === undefined, 'resize 32→16 не обрезал');
    check(h.engine.setSteps(24) === 16, 'setSteps(24) должен остаться 16');
  }

  // --- 3. Банки: переключение, изоляция, копирование ---
  {
    const h = makeHarness();
    h.engine.matrix[0][0] = 100;
    h.engine.selectBank(1);
    check(h.engine.matrix[0][0] === 0, 'банк 1 должен быть пустым');
    h.engine.matrix[1][2] = 80;
    h.engine.selectBank(0);
    check(h.engine.matrix[0][0] === 100 && h.engine.matrix[1][2] === 0, 'возврат в банк 0 не восстановил паттерн');
    h.engine.copyBank(0, 3);
    h.engine.selectBank(3);
    check(h.engine.matrix[0][0] === 100, 'copyBank(0→3) не скопировал');
    // правка банка 3 не трогает банк 0
    h.engine.matrix[0][0] = 0;
    h.engine.selectBank(0);
    check(h.engine.matrix[0][0] === 100, 'правка банка 3 затронула банк 0');
  }

  // --- 4. Swing: нечётные шаги сдвинуты, чётные и старт лупа — нет ---
  {
    const h = makeHarness({ bpm: 120 });
    h.engine.setSwing(0.25);
    const times = [];
    h.engine.onStepTrigger = (step, abs, time) => times.push(time);
    await h.engine.initAudio();
    h.engine.start();
    for (let i = 0; i < 80; i++) { h.advance(0.025); h.engine.consumeDueSteps(h.ctx.currentTime); }
    const stepDur = 0.125;
    const start = times[0];
    let ok = true;
    for (let k = 0; k < times.length; k++) {
      const want = start + k * stepDur + (k % 2 === 1 ? 0.25 * stepDur : 0);
      if (Math.abs(times[k] - want) > 1e-9) ok = false;
    }
    console.log(`  swing 25%: первый шаг ${times[0].toFixed(4)}, второй ${(times[1] - times[0]).toFixed(4)} с (ожид. ${stepDur} и ${stepDur * 1.25})`);
    check(ok, 'swing сдвинул шаги неверно');
    check(Math.abs((times[1] - times[0]) - stepDur * 1.25) < 1e-9, 'нечётный интервал ≠ stepDur·1.25');
    check(Math.abs((times[2] - times[1]) - stepDur * 0.75) < 1e-9, 'чётный интервал ≠ stepDur·0.75');
  }

  // --- 5. Драмы: хит стартует в своё время, choke глушит предыдущий ---
  {
    const h = makeHarness({ bpm: 120 });
    await h.engine.initAudio();
    const kickBuf = { duration: 0.2, sampleRate: 48000, _tag: 'kick' };
    const chhBuf = { duration: 0.1, sampleRate: 48000, _tag: 'chh' };
    const ohhBuf = { duration: 0.3, sampleRate: 48000, _tag: 'ohh' };
    h.engine.setDrumSample('kick', kickBuf);
    h.engine.setDrumSample('chh', chhBuf);
    h.engine.setDrumSample('ohh', ohhBuf);
    h.engine.drumMatrix[0][0] = 100; // kick step 0
    h.engine.drumMatrix[2][0] = 90;  // closed hat step 0
    h.engine.drumMatrix[3][4] = 90;  // open hat step 4 → должен заглушить closed hat
    h.engine.start();
    h.advance(1.0);

    const drumSrcs = h.sources.filter((s) => s.buffer && s.buffer._tag);
    const kick = drumSrcs.find((s) => s.buffer._tag === 'kick');
    const chh = drumSrcs.find((s) => s.buffer._tag === 'chh');
    const ohh = drumSrcs.find((s) => s.buffer._tag === 'ohh');
    check(!!kick && Math.abs(kick.startTime - 0.08) < 1e-9, `kick startTime ${kick?.startTime} ≠ 0.08`);
    check(!!chh && !!ohh, 'не все драм-хиты запланированы');
    check(chh.stopTime != null, 'open hat не заглушил closed hat (choke не сработал)');
    check(ohh.stopTime == null, 'open hat остановлен сам собой');
    console.log(`  драм-источников: ${drumSrcs.length}; choke: chh.stop=${chh?.stopTime?.toFixed(3)}`);

    // mute строки драмов
    h.engine.stop();
    h.engine.setDrumRowMuted(0, true);
    const before = h.sources.length;
    h.engine.start();
    h.advance(0.5);
    const newKicks = h.sources.slice(before).filter((s) => s.buffer?._tag === 'kick');
    check(newKicks.length === 0, 'mute драм-строки не сработал');
  }

  // --- 6. serialize / restore: круговой проход ---
  {
    const h = makeHarness({ bpm: 120 });
    h.engine.setBpm(132);
    h.engine.setSteps(32);
    h.engine.setSwing(0.3);
    h.engine.setDrumVolume(0.6);
    h.engine.addRow(62);
    h.engine.matrix[0][1] = 111;
    h.engine.drumMatrix[1][7] = 99;
    h.engine.setRowMuted(2, true);
    h.engine.selectBank(2);
    h.engine.matrix[0][0] = 77;
    const data = h.engine.serialize();

    const h2 = makeHarness({ bpm: 120 });
    const ok = h2.engine.restore(data);
    check(ok === true, 'restore вернул false');
    check(h2.engine.bpm === 132 && h2.engine.steps === 32, 'restore: bpm/steps');
    check(Math.abs(h2.engine.swing - 0.3) < 1e-9, 'restore: swing');
    check(Math.abs(h2.engine.drumVolume - 0.6) < 1e-9, 'restore: drumVolume');
    check(h2.engine.rows.length === 5 && h2.engine.rows[4].note === 62, 'restore: rows');
    check(h2.engine.rows[2].muted === true, 'restore: mute строки');
    check(h2.engine.bankIndex === 2 && h2.engine.matrix[0][0] === 77, 'restore: текущий банк');
    h2.engine.selectBank(0);
    check(h2.engine.matrix[0][1] === 111 && h2.engine.drumMatrix[1][7] === 99, 'restore: банк 0');
    check(h2.engine.restore({ v: 1 }) === false, 'restore старой версии должен вернуть false');
  }
});

/* ==================== I. MIDI-файлы и запись с клавиш ==================== */

await section('I. MIDI-файлы (.mid) и запись с внешнего входа', async (check) => {
  // --- 1. Кодировщик → парсер: круговой проход ---
  const rows = [{ note: 60, label: 'C4' }, { note: 64, label: 'E4' }];
  const matrix = [
    [100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 90, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  ];
  const bytes = encodeMidiFile({ bpm: 120, rows, matrix, steps: 16, gateRatio: 0.5 });
  check(bytes[0] === 0x4d && bytes[1] === 0x54 && bytes[2] === 0x68 && bytes[3] === 0x64, 'нет сигнатуры MThd');
  const parsed = parseMidiFile(bytes);
  check(parsed.format === 0 && parsed.tpq === 480, 'заголовок: format/tpq');
  check(parsed.usPerBeat === 500000, `темп из bpm=120: ${parsed.usPerBeat}`);
  check(parsed.notes.length === 2, `нот в файле: ${parsed.notes.length} (ожидали 2)`);
  const n0 = parsed.notes.find((n) => n.note === 60);
  const n1 = parsed.notes.find((n) => n.note === 64);
  check(n0 && n0.tick === 0 && n0.vel === 100 && n0.endTick === 60, 'нота C4: tick/vel/gate');
  check(n1 && n1.tick === 480 && n1.vel === 90, 'нота E4: tick 480 (шаг 4), vel 90');

  // --- 2. buildPatternFromMidi: раскладка по сетке, квантизация, усечение ---
  const pat = buildPatternFromMidi({
    tpq: 480,
    notes: [
      { tick: 0, endTick: 240, note: 60, vel: 100 },
      { tick: 250, endTick: 480, note: 62, vel: 90 }, // округлится к шагу 2
      { tick: 65 * 120, endTick: 66 * 120, note: 64, vel: 80 }, // за пределами 64 шагов
    ],
  });
  check(pat && pat.steps === 64, `steps=${pat?.steps} (ожидали 64 под ~66 шагов)`);
  check(pat.rows.length === 2 && pat.rows[0].note === 62 && pat.rows[1].note === 60, 'строки: уникальные высоты, сверху высокие');
  check(pat.matrix[0][2] === 90 && pat.matrix[1][0] === 100, 'квантизация: tick 250 → шаг 2');
  check(pat.truncated === 1 && pat.totalSteps === 66, `усечение: truncated=${pat.truncated}, total=${pat.totalSteps}`);
  check(buildPatternFromMidi({ tpq: 480, notes: [] }) === null, 'пустой набор нот должен дать null');

  // --- 3. parseMidiFile: защита от мусора ---
  let threw = false;
  try { parseMidiFile(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])); } catch { threw = true; }
  check(threw, 'файл без MThd должен бросать ошибку');

  // --- 4. importPattern в движок: строки, шаги, банк ---
  {
    const h = makeHarness({ bpm: 120 });
    const imp = h.engine.importPattern({ rows: pat.rows, matrix: pat.matrix, steps: pat.steps });
    check(imp.rows === 2 && imp.steps === 64, 'importPattern: размеры');
    check(h.engine.matrix[0][2] === 90, 'importPattern: данные');
    h.engine.selectBank(3);
    h.engine.selectBank(0);
    check(h.engine.matrix[0][2] === 90, 'importPattern: текущий банк сохранён');
  }

  // --- 5. STEP-запись с фиктивного входа ---
  {
    const h = makeHarness({ bpm: 120 });
    const listeners = new Set();
    const fakeBackend = {
      input: { name: 'fake-in' },
      subscribeInput(fn) { listeners.add(fn); return true; },
      unsubscribeInput(fn) { listeners.delete(fn); },
    };
    check(h.engine.connectMidiInput(fakeBackend) === true, 'connectMidiInput к фиктивному бэкенду');
    check(listeners.size === 1, 'приёмник не подписался на вход');
    const fire = (b) => [...listeners][0]({ data: new Uint8Array(b), timeStamp: 0 });

    const events = [];
    h.engine.onRecordEvent = (ev) => events.push(ev);
    h.engine.setInputMode('off');
    fire([0x90, 60, 100]);
    check(events.length === 0 && h.engine.matrix[0][0] === 0, 'в режиме off ноты не пишутся');

    h.engine.setInputMode('step');
    fire([0x90, 60, 100]); // строка 0 (C4), шаг курсора 0
    check(h.engine.matrix[0][0] === 100, 'STEP: нота не записана в клетку курсора');
    check(h.engine.recordCursor === 1, `STEP: курсор = ${h.engine.recordCursor}`);
    fire([0x90, 60, 80]);
    check(h.engine.matrix[0][1] === 80 && h.engine.recordCursor === 2, 'STEP: второе нажатие сдвинуло курсор');
    fire([0x90, 69, 110]); // A4 — строки нет → создаётся
    const lastEv = events[events.length - 1];
    check(lastEv.row === h.engine.rows.length - 1 && h.engine.rows[lastEv.row].note === 69,
      'STEP: новая нота создала строку');
    check(h.engine.matrix[lastEv.row][lastEv.step] === 110, 'STEP: запись в новую строку');

    // курсор доходит до конца и зацикливается
    h.engine.resetRecordCursor();
    for (let i = 0; i < 16; i++) fire([0x90, 60, 64]);
    check(h.engine.recordCursor === 0, 'STEP: курсор зациклился после 16 шагов');

    // лимит строк: 13 новых нот → 16 строк, дальше skipped
    for (let n = 0; n < 13; n++) fire([0x90, 24 + n, 70]);
    check(h.engine.rows.length === 16, `лимит строк: ${h.engine.rows.length}`);
    const before = events.length;
    fire([0x90, 20, 70]); // уже не влезает (нота 20 не среди 24..36 и 60,69)
    const skipEv = events[events.length - 1];
    check(events.length === before + 1 && skipEv.skipped === true, 'переполнение строк должно дать skipped-событие');

    // --- 6. LIVE-запись: без транспорта пропускаем, на ходу — пишем в текущий шаг ---
    const h2 = makeHarness({ bpm: 120 });
    const listeners2 = new Set();
    h2.engine.connectMidiInput({
      input: { name: 'fake-in-2' },
      subscribeInput(fn) { listeners2.add(fn); return true; },
      unsubscribeInput(fn) { listeners2.delete(fn); },
    });
    const fire2 = (b) => [...listeners2][0]({ data: new Uint8Array(b), timeStamp: 0 });
    const events2 = [];
    h2.engine.onRecordEvent = (ev) => events2.push(ev);
    h2.engine.setInputMode('live');
    fire2([0x90, 60, 100]);
    check(events2[0]?.skipped === true && events2[0].reason === 'нет транспорта', 'LIVE без транспорта: skipped');

    await h2.engine.initAudio();
    h2.engine.start();
    for (let i = 0; i < 20; i++) { h2.advance(0.025); h2.engine.consumeDueSteps(h2.ctx.currentTime); }
    const cur = h2.engine._currentStep;
    check(cur >= 0, 'LIVE: на ходу _currentStep определён');
    fire2([0x90, 60, 111]); // пишем, пока транспорт играет
    check(h2.engine.matrix[0][cur] === 111, `LIVE: нота записана в шаг ${cur}`);
    h2.engine.stop();
  }
});

/* ==================== итог ==================== */

console.log(`\nИТОГ: ${totalFails === 0 ? 'ВСЁ PASS' : `ПРОВАЛОВ: ${totalFails}`}`);
process.exitCode = totalFails ? 1 : 0;
