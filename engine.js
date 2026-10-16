/**
 * engine.js — ядро секвенсора (vanilla ES-module, ноль зависимостей).
 *
 * Идея (паттерн «A Tale of Two Clocks»): один look-ahead шедулер крутится на
 * setInterval(25 мс) и заранее (на 100 мс вперёд) раскладывает события по
 * времени аудио-часов (AudioContext.currentTime):
 *   1) сэмпл-события Web Audio (старт прохода лупа) — сэмпл-точно;
 *   2) MIDI-события (noteOn/noteOff для FM-1) — через очередь отправки,
 *      которая учитывает калибровочное смещение (midiOffsetMs);
 *   3) визуальные события (подсветка шага) — через rAF-очередь.
 *
 * Два времени, которые тут живут:
 *   • audioTime  — секунды AudioContext.currentTime (мастер-клок, им живёт музыка);
 *   • perfMs     — миллисекунды performance.now() (в этой шкале работает
 *                  необязательный timestamp в MIDIOutput.send()).
 * Системный setInterval НИКОГДА не используется как источник времени —
 * только как «будильник», который спрашивает: «что сыграть в ближайшие 100 мс?».
 *
 * Ключевые допущения:
 *   • 4/4, шаг сетки = 1/16 (stepDuration = 60 / bpm / 4);
 *   • луп — файл, в имени которого указан «родной» BPM (techno_128bpm.mp3).
 *     Число тактов в лупе определяется по длительности, дальше луп подгоняется
 *     playbackRate'ом, чтобы всегда ложиться ровно на границу такта;
 *   • MIDI-канал по умолчанию 1 (нулевой индекс в байтах статуса 0x90/0x80).
 *
 * Модуль не трогает DOM/window напрямую (кроме безопасных проверок typeof),
 * поэтому его можно гонять в Node с фиктивным AudioContext — см. tools/headless-test.js.
 */

/** Ноты по умолчанию: 4 строки piano roll. C4=60, E4=64, G4=67, B4=71. */
export const DEFAULT_ROWS = [
  { note: 60, label: 'C4' },
  { note: 64, label: 'E4' },
  { note: 67, label: 'G4' },
  { note: 71, label: 'B4' },
];

/**
 * Драмы-ваншоты из library/instruments. Играют через Web Audio по той же
 * сетке, что и ноты FM-1. choke — группа взаимного глушения: новый хит
 * гасит предыдущие в той же группе (открытый хэт срезает закрытый).
 */
export const DEFAULT_DRUM_ROWS = [
  { id: 'kick', label: 'Kick', url: 'library/instruments/kick.mp3' },
  { id: 'snare', label: 'Snare', url: 'library/instruments/snare.mp3' },
  { id: 'chh', label: 'Hat закр.', url: 'library/instruments/closed_hihat.mp3', choke: 'hats' },
  { id: 'ohh', label: 'Hat откр.', url: 'library/instruments/opened_hihat.mp3', choke: 'hats' },
  { id: 'cym', label: 'Cymbal', url: 'library/instruments/cymbal.mp3' },
  { id: 'clk', label: 'Click', url: 'library/instruments/click.mp3' },
];

/** Цикл velocity по долгому нажатию на включённую клетку. */
export const VELOCITY_CYCLE = [64, 100, 127];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** 60 → 'C4', 61 → 'C#4'. @param {number} note */
export function noteLabel(note) {
  const n = clamp(Math.round(Number(note)) || 0, 0, 127);
  return NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);
}

/** Расширить/обрезать строку матрицы до n столбцов с сохранением данных. */
function resizeRow(arr, n) {
  const out = new Array(n).fill(0);
  for (let i = 0; i < Math.min(n, arr.length); i++) out[i] = arr[i];
  return out;
}

/* ============================ MIDI-файлы (.mid) ============================ */

/** Чтение variable-length quantity. @returns {[value, newPos]} */
function readVLQ(b, p) {
  let v = 0;
  for (;;) {
    const x = b[p++];
    v = (v << 7) | (x & 0x7f);
    if (!(x & 0x80)) return [v, p];
  }
}

/** Запись VLQ в массив байтов. */
function pushVLQ(arr, v) {
  const bytes = [v & 0x7f];
  v >>= 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  for (const x of bytes) arr.push(x);
}

/**
 * Минимальный парсер Standard MIDI File (format 0/1, PPQ-тайминг).
 * Все треки сливаются в один список нот с абсолютными тиками; берётся первый
 * темп-событие (или дефолт 500000 мкс/долю). SMPTE-тайминг не поддерживается.
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {{format:number, tpq:number, usPerBeat:number, notes:{tick:number,endTick:number,note:number,vel:number}[]}}
 */
export function parseMidiFile(data) {
  const b = data instanceof Uint8Array ? data : new Uint8Array(data);
  const tag = (off, n) => String.fromCharCode(...b.slice(off, off + n));
  if (b.length < 14 || tag(0, 4) !== 'MThd') throw new Error('это не MIDI-файл (нет «MThd»)');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const format = dv.getUint16(8);
  const ntrks = dv.getUint16(10);
  const division = dv.getUint16(12);
  if (division & 0x8000) throw new Error('SMPTE-тайминг в .mid не поддерживается (нужен PPQ)');

  const notes = [];
  let usPerBeat = 500000;
  let pos = 14;
  for (let t = 0; t < ntrks && pos + 8 <= b.length; t++) {
    if (tag(pos, 4) !== 'MTrk') break;
    const len = dv.getUint32(pos + 4);
    let p = pos + 8;
    const end = Math.min(b.length, p + len);
    let tick = 0;
    let running = 0;
    const held = new Map(); // (ch·128+note) → {tick, vel}
    const closeHeld = (key, atTick) => {
      const h = held.get(key);
      if (!h) return;
      notes.push({ tick: h.tick, endTick: atTick, note: key % 128, vel: h.vel });
      held.delete(key);
    };
    while (p < end) {
      let dt; [dt, p] = readVLQ(b, p);
      tick += dt;
      let status = b[p];
      if (status & 0x80) { running = status; p++; } else status = running;
      const type = status & 0xf0;
      const ch = status & 0x0f;
      if (type === 0x90 || type === 0x80) {
        const note = b[p++] & 0x7f;
        const vel = b[p++] & 0x7f;
        const key = ch * 128 + note;
        if (type === 0x90 && vel > 0) {
          closeHeld(key, tick); // повторный note-on той же ноты = сначала off
          held.set(key, { tick, vel });
        } else {
          closeHeld(key, tick);
        }
      } else if (type === 0xa0 || type === 0xb0 || type === 0xe0) p += 2;
      else if (type === 0xc0 || type === 0xd0) p += 1;
      else if (status === 0xff) {
        const meta = b[p++];
        let ln; [ln, p] = readVLQ(b, p);
        if (meta === 0x51 && ln === 3) usPerBeat = (b[p] << 16) | (b[p + 1] << 8) | b[p + 2];
        p += ln;
      } else if (status === 0xf0 || status === 0xf7) {
        let ln; [ln, p] = readVLQ(b, p);
        p += ln;
      } else p++;
    }
    for (const [key, h] of held) notes.push({ tick: h.tick, endTick: tick, note: key % 128, vel: h.vel });
    pos = end;
  }
  notes.sort((x, y) => x.tick - y.tick || x.note - y.note);
  return { format, tpq: division, usPerBeat, notes };
}

/**
 * Раскладка распарсенных нот по нашей сетке: шаг = 1/16 (tpq/4 тиков),
 * квантизация округлением, строки = уникальные высоты (сверху — высокие).
 * Всё, что не влезло в 64 шага или свыше 16 строк, считается усечённым.
 * @returns {{steps:number, rows:{note:number,label:string}[], matrix:number[][], truncated:number, totalSteps:number}|null}
 */
export function buildPatternFromMidi(parsed, { maxRows = 16 } = {}) {
  const { tpq, notes } = parsed;
  if (!notes?.length || !tpq) return null;
  const stepTicks = tpq / 4;
  const lastEnd = notes.reduce((m, n) => Math.max(m, n.endTick ?? n.tick), 0);
  const totalSteps = Math.max(1, Math.ceil(lastEnd / stepTicks));
  const steps = totalSteps <= 16 ? 16 : totalSteps <= 32 ? 32 : 64;
  // Строки строим только из нот, попавших в сетку: усечённые не должны
  // создавать пустые строки.
  const quantized = notes.map((n) => ({ n, s: Math.round(n.tick / stepTicks) }));
  const pitches = [...new Set(quantized.filter((q) => q.s < steps).map((q) => q.n.note))].sort((a, b) => b - a);
  const rows = pitches.slice(0, maxRows).map((note) => ({ note, label: noteLabel(note), muted: false }));
  const rowIndex = new Map(rows.map((r, i) => [r.note, i]));
  const matrix = rows.map(() => new Array(steps).fill(0));
  let truncated = 0;
  for (const { n, s } of quantized) {
    const ri = rowIndex.get(n.note);
    if (ri === undefined || s >= steps) { truncated++; continue; }
    matrix[ri][s] = Math.max(matrix[ri][s], n.vel);
  }
  return { steps, rows, matrix, truncated, totalSteps };
}

/**
 * Кодировщик .mid (format 0, PPQ 480) из нашей матрицы: каждая включённая
 * клетка = noteOn на своём шаге + noteOff через gateRatio шагов.
 * @returns {Uint8Array} байты файла
 */
export function encodeMidiFile({ bpm, rows, matrix, steps, gateRatio = 0.5 }) {
  const tpq = 480;
  const stepTicks = tpq / 4;
  const gateTicks = Math.max(1, Math.round(stepTicks * gateRatio));
  const usPerBeat = clamp(Math.round(60000000 / (bpm || 120)), 8333, 1500000);

  const events = [
    { tick: 0, bytes: [0xff, 0x51, 0x03, (usPerBeat >> 16) & 0xff, (usPerBeat >> 8) & 0xff, usPerBeat & 0xff] },
    { tick: 0, bytes: [0xff, 0x58, 0x04, 4, 2, 24, 8] }, // 4/4
  ];
  for (let r = 0; r < rows.length; r++) {
    for (let s = 0; s < steps; s++) {
      const vel = matrix[r]?.[s];
      if (!vel) continue;
      const note = rows[r].note & 0x7f;
      const tick = s * stepTicks;
      events.push({ tick, bytes: [0x90, note, clamp(vel, 1, 127)] });
      events.push({ tick: tick + gateTicks, bytes: [0x80, note, 0] });
    }
  }
  events.sort((a, b) => a.tick - b.tick);

  const track = [];
  let last = 0;
  for (const ev of events) {
    pushVLQ(track, ev.tick - last);
    last = ev.tick;
    for (const x of ev.bytes) track.push(x);
  }
  pushVLQ(track, 0);
  track.push(0xff, 0x2f, 0x00);

  const out = new Uint8Array(14 + 8 + track.length);
  const dv = new DataView(out.buffer);
  // MThd
  out.set([0x4d, 0x54, 0x68, 0x64], 0);
  dv.setUint32(4, 6);
  dv.setUint16(8, 0);   // format 0
  dv.setUint16(10, 1);  // один трек
  dv.setUint16(12, tpq);
  // MTrk
  out.set([0x4d, 0x54, 0x72, 0x6b], 14);
  dv.setUint32(18, track.length);
  out.set(track, 22);
  return out;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Достаёт BPM из имени файла: 'techno_128bpm.mp3' → 128, 'loop.wav' → null.
 * @param {string} name
 * @returns {number|null}
 */
export function parseBpmFromName(name) {
  const m = /(\d{2,3})\s*bpm/i.exec(String(name));
  return m ? Number(m[1]) : null;
}

/* ============================== MIDI ============================== */

/**
 * Бэкенд поверх Web MIDI API (USB-C подключение FM-1).
 * Задача: найти выход и вход «FM-1» (или первые доступные) и уметь
 * отправлять байты наружу и принимать входящие.
 * Интерфейс такой же, каким будет у BLE-бэкенда (Web Bluetooth) в следующем этапе:
 *   { name, sendNow(bytes), sendScheduled(bytes, perfMs), selectPort(id),
 *     subscribeInput(handler), unsubscribeInput(handler), selectInputPort(id) }
 */
export class WebMidiBackend {
  /** @returns {boolean} есть ли Web MIDI в этом браузере */
  static isSupported() {
    return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
  }

  /**
   * Запрашивает доступ и выбирает выход и (если есть) вход.
   * ВАЖНО: вызывать из обработчика жеста пользователя (клик по кнопке) —
   * Chrome требует user gesture.
   * @param {{ preferredName?: string }} [options]
   */
  static async connect(options = {}) {
    if (!this.isSupported()) {
      throw new Error('Web MIDI API недоступен. Нужен Chrome 152+ и открытие по http://localhost');
    }
    const access = await navigator.requestMIDIAccess();
    const outputs = [...access.outputs.values()];
    const inputs = [...access.inputs.values()];
    if (!outputs.length && !inputs.length) {
      throw new Error('MIDI-порты не найдены. Подключите FM-1 кабелем USB-C и разрешите доступ в диалоге Chrome.');
    }
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const wanted = norm(options.preferredName ?? 'fm-1');
    const output = outputs.find((p) => norm(p.name).includes(wanted)) ?? outputs[0] ?? null;
    const input = inputs.find((p) => norm(p.name).includes(wanted)) ?? inputs[0] ?? null;
    return new WebMidiBackend(access, output, input);
  }

  constructor(access, output, input = null) {
    this.access = access;
    this.output = output;
    this.input = input;
  }

  get name() {
    return this.output?.name ?? this.input?.name ?? 'MIDI';
  }

  /** Пользуемся ли мы встроенным планировщиком браузера (timestamp). */
  get supportsTimestamp() {
    return true;
  }

  /** Отправить немедленно (тест-нота, all-notes-off, режим «своя очередь»). */
  sendNow(bytes) {
    if (!this.output) throw new Error('MIDI-выход не выбран');
    this.output.send(bytes);
  }

  /** Отправить в момент perfMs (шкала performance.now()). Экспериментальный режим. */
  sendScheduled(bytes, perfMs) {
    if (!this.output) throw new Error('MIDI-выход не выбран');
    this.output.send(bytes, perfMs);
  }

  /** Переключить выход по id (для выпадающего списка в UI). */
  selectPort(id) {
    const out = this.access.outputs.get(id);
    if (out) this.output = out;
    return this.output;
  }

  /** Список всех выходов для UI. */
  listPorts() {
    return [...this.access.outputs.values()].map((p) => ({ id: p.id, name: p.name }));
  }

  /* ---------- вход ---------- */

  /**
   * Подписать обработчик на сообщения входа.
   * @param {(ev: {data: Uint8Array, timeStamp: number}) => void} handler
   * @returns {boolean} удалось ли подписаться (false, если входа нет)
   */
  subscribeInput(handler) {
    if (!this.input || typeof this.input.addEventListener !== 'function') return false;
    this.input.addEventListener('midimessage', handler);
    return true;
  }

  unsubscribeInput(handler) {
    if (!this.input || typeof this.input.removeEventListener !== 'function') return;
    this.input.removeEventListener('midimessage', handler);
  }

  /** Переключить вход по id. Старые подписки сбрасываются вызывающим кодом. */
  selectInputPort(id) {
    const inp = this.access.inputs.get(id);
    if (inp) this.input = inp;
    return this.input;
  }

  /** Список всех входов для UI. */
  listInputs() {
    return [...this.access.inputs.values()].map((p) => ({ id: p.id, name: p.name }));
  }
}

/* ============================== MIDI-вход ============================== */

/**
 * Приёмник MIDI-сообщений (ноты/CC/PC/PitchBend/SysEx) от внешнего устройства.
 *
 * Зачем: FM-1 подключён по USB-C двусторонне — не только принимает ноты, но и
 * шлёт наружу сообщения от своих ручек и кнопок. Мы их разбираем и раздаём
 * подписчикам. Ничего «умного» тут нет — чистый парсер статус-байтов,
 * который легко тестировать без железа (метод feed()).
 *
 * Форма нормализованного сообщения (аргумент подписчиков):
 *   { type, channel, bytes, timestamp,
 *     // для cc/noteOn/noteOff: note|controller, value|velocity
 *     // для pc: program
 *     // для pitchBend: value (0..16383)
 *   }
 */
export class MidiReceiver {
  constructor() {
    this.backend = null;
    this._subs = {
      any: new Set(),
      cc: new Set(),        // (msg) => void, любой CC
      ccByNumber: new Map(),// cc# → Set<(msg) => void>
      noteOn: new Set(),
      noteOff: new Set(),
      pc: new Set(),
      pitchBend: new Set(),
      sysex: new Set(),
    };
    this._ccState = new Map();   // cc# → последнее значение (для «лампочек» в UI)
    this._messageCount = 0;
    this._lastEvent = null;
    // Привязанный обработчик — чтобы отписаться тем же референсом.
    this._onMidiEvent = (ev) => {
      const data = ev?.data ? [...ev.data] : [];
      this.feed(data, ev?.timeStamp);
    };
  }

  /**
   * Подключиться к бэкенду (подписка на его вход).
   * @returns {boolean} true, если вход есть и подписка удалась
   */
  connect(backend) {
    this.disconnect();
    this.backend = backend ?? null;
    if (!this.backend || typeof this.backend.subscribeInput !== 'function') return false;
    return this.backend.subscribeInput(this._onMidiEvent);
  }

  disconnect() {
    if (this.backend && typeof this.backend.unsubscribeInput === 'function') {
      try { this.backend.unsubscribeInput(this._onMidiEvent); } catch { /* уже отписан */ }
    }
    this.backend = null;
  }

  get connected() { return !!this.backend; }

  /* ---------- подписки ---------- */

  /** На любое входящее сообщение (нормализованное). @returns {() => void} отписаться */
  onAny(fn) { this._subs.any.add(fn); return () => this._subs.any.delete(fn); }
  /** На любой CC. */
  onCC(fn) { this._subs.cc.add(fn); return () => this._subs.cc.delete(fn); }
  /** На конкретный CC по номеру (0..127). */
  onCCNumber(cc, fn) {
    const key = cc & 0x7f;
    if (!this._subs.ccByNumber.has(key)) this._subs.ccByNumber.set(key, new Set());
    this._subs.ccByNumber.get(key).add(fn);
    return () => this._subs.ccByNumber.get(key)?.delete(fn);
  }
  onNoteOn(fn) { this._subs.noteOn.add(fn); return () => this._subs.noteOn.delete(fn); }
  onNoteOff(fn) { this._subs.noteOff.add(fn); return () => this._subs.noteOff.delete(fn); }
  onPC(fn) { this._subs.pc.add(fn); return () => this._subs.pc.delete(fn); }
  onPitchBend(fn) { this._subs.pitchBend.add(fn); return () => this._subs.pitchBend.delete(fn); }
  onSysEx(fn) { this._subs.sysex.add(fn); return () => this._subs.sysex.delete(fn); }

  /** Снять все подписки (используется при переключении порта, чтобы не дублировать). */
  clearSubscriptions() {
    for (const key of ['any', 'cc', 'noteOn', 'noteOff', 'pc', 'pitchBend', 'sysex']) {
      this._subs[key].clear();
    }
    this._subs.ccByNumber.clear();
  }

  /* ---------- парсинг ---------- */

  /**
   * Скормить сырые байты (массив чисел) — точка входа из браузера и из тестов.
   * @param {number[]} bytes
   * @param {number} [timestamp] DOMHighResTimeStamp из MIDIMessageEvent
   * @returns {object|null} нормализованное сообщение или null, если пустое
   */
  feed(bytes, timestamp = 0) {
    if (!bytes || !bytes.length) return null;
    const msg = this._parse(bytes, timestamp);
    if (!msg) return null;
    this._messageCount++;
    this._lastEvent = msg;
    if (msg.type === 'cc') this._ccState.set(msg.controller, msg.value);
    // Раздаём подписчикам в порядке: конкретный CC → все CC → any
    if (msg.type === 'cc') {
      const set = this._subs.ccByNumber.get(msg.controller);
      if (set) for (const fn of set) this._safe(fn, msg);
      for (const fn of this._subs.cc) this._safe(fn, msg);
    } else if (msg.type === 'noteOn') {
      for (const fn of this._subs.noteOn) this._safe(fn, msg);
    } else if (msg.type === 'noteOff') {
      for (const fn of this._subs.noteOff) this._safe(fn, msg);
    } else if (msg.type === 'pc') {
      for (const fn of this._subs.pc) this._safe(fn, msg);
    } else if (msg.type === 'pitchBend') {
      for (const fn of this._subs.pitchBend) this._safe(fn, msg);
    } else if (msg.type === 'sysex') {
      for (const fn of this._subs.sysex) this._safe(fn, msg);
    }
    for (const fn of this._subs.any) this._safe(fn, msg);
    return msg;
  }

  _safe(fn, msg) {
    try { fn(msg); } catch (e) {
      // Подписчик не должен ломать приёмник — пишем в консоль и живём дальше.
      if (typeof console !== 'undefined') console.warn('MidiReceiver handler error', e);
    }
  }

  _parse(bytes, timestamp) {
    const status = bytes[0];
    const base = {
      bytes: [...bytes],
      timestamp,
      channel: status & 0x0f,
    };
    // SysEx: 0xF0 ... 0xF7 (или обрезанное 0xF0 без 0xF7 — тоже считаем)
    if (status === 0xf0 || status === 0xf7) {
      return { ...base, type: 'sysex', data: bytes.slice(1, status === 0xf7 ? bytes.length : -1) };
    }
    switch (status & 0xf0) {
      case 0x80: // Note Off
        return { ...base, type: 'noteOff', note: bytes[1], velocity: bytes[2] ?? 0 };
      case 0x90: // Note On (velocity=0 трактуем как Note Off — стандартная практика)
        if ((bytes[2] ?? 0) === 0) return { ...base, type: 'noteOff', note: bytes[1], velocity: 0 };
        return { ...base, type: 'noteOn', note: bytes[1], velocity: bytes[2] };
      case 0xa0: // Poly Aftertouch
        return { ...base, type: 'polyAftertouch', note: bytes[1], value: bytes[2] };
      case 0xb0: // Control Change
        return { ...base, type: 'cc', controller: bytes[1], value: bytes[2] };
      case 0xc0: // Program Change
        return { ...base, type: 'pc', program: bytes[1] };
      case 0xd0: // Channel Aftertouch
        return { ...base, type: 'channelAftertouch', value: bytes[1] };
      case 0xe0: // Pitch Bend (14 бит, LSB + MSB)
        return { ...base, type: 'pitchBend', value: ((bytes[2] ?? 0) << 7) | (bytes[1] ?? 0) };
      default:
        return { ...base, type: 'system', status };
    }
  }

  /* ---------- состояние ---------- */

  /** Текущие значения всех CC, которые мы видели хотя бы раз. */
  get ccState() {
    return Object.fromEntries(this._ccState);
  }

  get messageCount() { return this._messageCount; }
  get lastEvent() { return this._lastEvent; }
}

/**
 * Очередь отправки MIDI-байтов из времени аудио-часов.
 *
 * Как работает: шедулер передаёт сюда пару (байты, audioTime). Мы вычитаем
 * уже прошедшее время и превращаем в задержку setTimeout'а, добавляя
 * калибровочное смещение:
 *
 *   задержка_мс = (audioTime − ctx.currentTime) · 1000 + offsetMs
 *
 * offsetMs — «ручка калибровки» на слух: + = MIDI звучит позже, − = раньше.
 * Мотивация знака: звук из динамика телефона выходит с задержкой outputLatency
 * (~20–40 мс на Android), а USB-MIDI почти мгновенный — поэтому ноты FM-1
 * обычно надо именно ЗАДЕРЖИВАТЬ относительно сетки, чтобы оба источника
 * совпали на слух.
 *
 * Почему не доверяем параметру timestamp в output.send(): на разных платформах
 * он исторически работает по-разному (включая баг «сообщение не отправляется»),
 * поэтому по умолчанию планируем сами. Режим useTimestamp включается флажком
 * в UI — для экспериментов на конкретном устройстве.
 */
export class MidiSender {
  /** @param {{ getContext?: Function, setTimer?: Function, clearTimer?: Function, perfNow?: Function }} [options] */
  constructor(options = {}) {
    this.getContext = options.getContext ?? (() => null);
    // Таймеры инжектируются — чтобы headless-тест мог подменить их виртуальными
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((id) => clearTimeout(id));
    this.perfNow = options.perfNow ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));

    this.backend = null;
    this.channel = 0; // 0 = канал 1 (байты 0x90/0x80)
    this.offsetMs = 25;
    this.useTimestamp = false;

    this._timers = new Set(); // запланированные отправки
    this._sounding = new Set(); // ноты, для которых noteOn отправлен, а noteOff — ещё нет
    this._sentCount = 0; // счётчик отправленных сообщений (для дебаг-панели)
  }

  /** Подключить выход. Перед сменой выхода гасим возможные залипшие ноты. */
  connect(backend) {
    this.allNotesOff();
    this.backend = backend ?? null;
  }

  get connected() {
    return !!this.backend;
  }

  get pendingCount() {
    return this._timers.size;
  }

  get soundingNotes() {
    return [...this._sounding];
  }

  get sentCount() {
    return this._sentCount;
  }

  /** Мгновенная отправка (тест-нота из UI). Возвращает false, если выхода нет. */
  sendImmediate(bytes) {
    if (!this.backend) return false;
    this._sendNow(bytes);
    return true;
  }

  /**
   * Запланировать пачку байтов на момент audioTime.
   * @param {number[]} bytes  например [0x90, 60, 100]
   * @param {number} audioTime  время в шкале AudioContext.currentTime
   */
  scheduleBytes(bytes, audioTime) {
    if (!this.backend) return;
    const ctx = this.getContext();
    if (!ctx) return;

    if (this.useTimestamp && typeof this.backend.sendScheduled === 'function') {
      // Экспериментальная ветка: отдаём время браузерному планировщику MIDI.
      // Учёт «звучащих» нот делаем сразу, т.к. колбэка о факте отправки нет.
      const perfMs = this.perfNow() + (audioTime - ctx.currentTime) * 1000 + this.offsetMs;
      this._trackBytes(bytes);
      this._sentCount++;
      this.backend.sendScheduled(bytes, perfMs);
      return;
    }

    const delayMs = (audioTime - ctx.currentTime) * 1000 + this.offsetMs;
    if (delayMs <= 0) {
      // Время уже наступило (задержка/скисший шедулер) — отправляем сейчас.
      this._sendNow(bytes);
      return;
    }
    const id = this.setTimer(() => {
      this._timers.delete(id);
      this._sendNow(bytes);
    }, delayMs);
    this._timers.add(id);
  }

  /** Запланировать noteOn. @param {number} velocity 1..127 */
  scheduleNoteOn(note, velocity, audioTime) {
    this.scheduleBytes([0x90 | this.channel, note & 0x7f, clamp(Math.round(velocity), 1, 127)], audioTime);
  }

  /** Запланировать noteOff. */
  scheduleNoteOff(note, audioTime) {
    this.scheduleBytes([0x80 | this.channel, note & 0x7f, 0], audioTime);
  }

  /** Отменить все запланированные, но ещё не отправленные сообщения. */
  cancelPending() {
    for (const id of this._timers) this.clearTimer(id);
    this._timers.clear();
  }

  /**
   * Аварийное «все ноты выкл»: явные noteOff для всего, что звучит, плюс
   * CC123 (All Notes Off) на случай, если что-то успело залипнуть в синте.
   * Вызывается на стопе, старте и смене MIDI-выхода.
   * @returns {number} сколько явных noteOff отправлено
   */
  allNotesOff() {
    this.cancelPending();
    if (!this.backend) {
      this._sounding.clear();
      return 0;
    }
    let sent = 0;
    for (const note of this._sounding) {
      this._rawSend([0x80 | this.channel, note & 0x7f, 0]);
      sent++;
    }
    this._rawSend([0xb0 | this.channel, 123, 0]); // CC123 All Notes Off
    this._sounding.clear();
    return sent;
  }

  /** Отправка «сейчас» с обновлением состояния звучащих нот. */
  _sendNow(bytes) {
    this._trackBytes(bytes);
    this._rawSend(bytes);
  }

  _rawSend(bytes) {
    this._sentCount++;
    this.backend?.sendNow(bytes);
  }

  /** Ведём учёт «звучащих» нот, чтобы стоп не оставлял залипших клавиш. */
  _trackBytes(bytes) {
    const status = bytes[0] & 0xf0;
    const note = bytes[1];
    if (status === 0x90 && bytes[2] > 0) this._sounding.add(note);
    else if (status === 0x80 || (status === 0x90 && bytes[2] === 0)) this._sounding.delete(note);
  }
}

/* ============================ ЯДРО ============================ */

/** Пауза между нажатием Play и первым шагом — запас шедулеру. */
const START_DELAY_SEC = 0.08;

export class SequencerEngine {
  /**
   * @param {{
   *   audioContext?: AudioContext,   // можно передать готовый (для тестов)
   *   rows?: {note:number,label:string}[],
   *   steps?: number, bpm?: number,
   *   lookaheadSec?: number, tickMs?: number,
   *   gateRatio?: number, velocity?: number,
   *   midiOffsetMs?: number,
   *   timerApi?: {setInterval:Function, clearInterval:Function},
   *   raf?: Function|null,          // подмена requestAnimationFrame (для тестов)
   *   setTimer?: Function, clearTimer?: Function, // для MidiSender (тесты)
   *   perfNow?: Function
   * }} [options]
   */
  constructor(options = {}) {
    this.rows = options.rows ?? DEFAULT_ROWS.map((r) => ({ ...r, muted: false }));
    this.steps = options.steps ?? 16;
    this.bpm = clamp(options.bpm ?? 120, 40, 240);
    this.swing = clamp(options.swing ?? 0, 0, 0.5); // сдвиг нечётных шагов, в долях шага
    this.lookaheadSec = options.lookaheadSec ?? 0.1;
    this.hiddenLookaheadSec = options.hiddenLookaheadSec ?? 2.5;
    this.tickMs = options.tickMs ?? 25;
    this.gateRatio = options.gateRatio ?? 0.5;
    this.velocity = options.velocity ?? 100;

    /** Матрица паттерна: matrix[row][step] = 0 (выкл) или velocity 1..127. */
    this.matrix = this.rows.map(() => new Array(this.steps).fill(0));

    /** Драмы: отдельная матрица drumMatrix[row][step] = velocity. */
    this.drumRows = options.drumRows ?? DEFAULT_DRUM_ROWS.map((r) => ({ ...r, muted: false, volume: 1 }));
    this.drumMatrix = this.drumRows.map(() => new Array(this.steps).fill(0));
    this.drumVolume = 1;
    this._drumBuffers = new Map(); // id → AudioBuffer
    this._drumSources = new Set(); // играющие хиты {src, gain, choke}
    this._drumChokes = new Map(); // choke-группа → Set играющих хитов

    /** Банки паттернов: banks[i] = снимок матриц или null (пусто). */
    this.bankIndex = 0;
    this.banks = Array.from({ length: 8 }, () => null);

    // Запись с клавиш FM-1 (стоковая прошивка шлёт только NoteOn/NoteOff).
    this.inputMode = 'off'; // 'off' | 'live' | 'step'
    this.onRecordEvent = null; // ({mode, step, row, note, velocity, skipped}) => void
    this._inputSubscribed = false;
    this._recordCursor = 0; // курсор STEP-записи (шаг)
    this._currentStep = -1; // последний воспроизведённый шаг (для LIVE)

    this.audioContext = options.audioContext ?? null;
    this.loopGain = null;
    this.drumGain = null;
    this.loop = { url: null, buffer: null, sourceBpm: null, bars: 1, volume: 1 };
    this._loopCache = new Map();

    /** Колбэк для UI: срабатывает, когда время шага наступило. */
    this.onStepTrigger = null;
    /** Колбэк стопа для UI (снять подсветку). Аргумент — сколько noteOff дослано. */
    this.onTransportStop = null;

    this.isPlaying = false;
    this.midi = new MidiSender({
      getContext: () => this.audioContext,
      setTimer: options.setTimer,
      clearTimer: options.clearTimer,
      perfNow: options.perfNow,
    });
    this.midi.channel = options.midiChannel ?? 0;
    this.midi.offsetMs = options.midiOffsetMs ?? 25;
    /** Приёмник MIDI-входа (ручки/кнопки FM-1 как контроллёр). */
    this.midiIn = new MidiReceiver();

    this._timerApi = options.timerApi ?? {
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (id) => clearInterval(id),
    };
    this._raf = options.raf !== undefined
      ? options.raf
      : (typeof requestAnimationFrame === 'function' ? (cb) => requestAnimationFrame(cb) : null);

    this._intervalId = 0;
    this._nextStepTime = 0; // время следующего НЕзапланированного шага
    this._lastStepTime = null; // время последнего запланированного шага
    this._absStep = 0; // абсолютный счётчик шагов (не сбрасывается на тактах)
    this._uiQueue = []; // {step, absStep, time} для подсветки
    this._loopSources = new Set(); // {src, gain} играющих проходов лупа
    this._ticks = 0;

    this._bindVisibility();
  }

  /* ---------- производные музыкальные величины ---------- */

  /** Длительность шага (1/16 при 4/4) в секундах. */
  get stepDuration() {
    return 60 / this.bpm / 4;
  }

  /** Длительность такта (4/4) в секундах. */
  get barDuration() {
    return (60 / this.bpm) * 4;
  }

  /* ---------- аудио ---------- */

  /**
   * Создать/разбудить AudioContext и мастер-гейн лупа.
   * Вызывать из жеста пользователя (клик Play).
   */
  async initAudio() {
    if (!this.audioContext) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) throw new Error('Web Audio API недоступен в этом браузере');
      this.audioContext = new AC({ latencyHint: 'interactive' });
    }
    if (this.audioContext.state !== 'running') await this.audioContext.resume();
    if (!this.loopGain) {
      this.loopGain = this.audioContext.createGain();
      this.loopGain.gain.value = this.loop.volume;
      this.loopGain.connect(this.audioContext.destination);
    }
    if (!this.drumGain) {
      this.drumGain = this.audioContext.createGain();
      this.drumGain.gain.value = this.drumVolume;
      this.drumGain.connect(this.audioContext.destination);
    }
    return this.audioContext;
  }

  /**
   * Загрузить и раскодировать файл лупа. Буферы кэшируются по URL.
   * Число тактов лупа вычисляется из его длительности и «родного» BPM из имени файла:
   *   bars = round(duration_sec · sourceBpm / 240)
   * (240 = 4 доли · 60 сек). Если BPM в имени нет — считаем луп однотактовым.
   */
  async loadLoopFromUrl(url) {
    const cached = this._loopCache.get(url);
    if (cached) {
      this._setLoopBuffer(url, cached);
      return cached;
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Не удалось загрузить ${url}: HTTP ${res.status}`);
    const arr = await res.arrayBuffer();
    const buffer = await this.audioContext.decodeAudioData(arr);
    this._loopCache.set(url, buffer);
    this._setLoopBuffer(url, buffer);
    return buffer;
  }

  /** Подставить готовый AudioBuffer (в тестах — фиктивный). */
  setLoopBuffer(url, buffer) {
    this._setLoopBuffer(url, buffer);
  }

  _setLoopBuffer(url, buffer) {
    this.loop.url = url;
    this.loop.buffer = buffer;
    const srcBpm = parseBpmFromName(url);
    this.loop.sourceBpm = srcBpm;
    this.loop.bars = srcBpm ? Math.max(1, Math.round((buffer.duration * srcBpm) / 240)) : 1;
  }

  /** Громкость лупа (0..1) с плавным применением, чтобы не щёлкало. */
  setLoopVolume(v) {
    this.loop.volume = clamp(Number(v) || 0, 0, 1);
    if (this.loopGain && this.audioContext) {
      this.loopGain.gain.setTargetAtTime(this.loop.volume, this.audioContext.currentTime, 0.01);
    }
  }

  /* ---------- драм-сэмплы ---------- */

  /**
   * Загрузить и раскодировать все ваншоты из drumRows. Отсутствие файла не
   * фатально: строка просто молчит, в консоль уходит предупреждение.
   * @returns {Promise<string[]>} id загруженных сэмплов
   */
  async loadDrumSamples() {
    if (!this.audioContext) throw new Error('Сначала вызовите initAudio()');
    const ids = await Promise.all(this.drumRows.map(async (row) => {
      if (this._drumBuffers.has(row.id)) return row.id;
      try {
        const res = await fetch(row.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = await this.audioContext.decodeAudioData(await res.arrayBuffer());
        this._drumBuffers.set(row.id, buffer);
        return row.id;
      } catch (e) {
        if (typeof console !== 'undefined') console.warn(`драм-сэмпл ${row.url}: ${e.message}`);
        return null;
      }
    }));
    return ids.filter(Boolean);
  }

  /** Подставить готовый буфер (в тестах — фиктивный). */
  setDrumSample(id, buffer) {
    this._drumBuffers.set(id, buffer);
  }

  /** Общая громкость драмов (0..1). */
  setDrumVolume(v) {
    this.drumVolume = clamp(Number(v) || 0, 0, 1);
    if (this.drumGain && this.audioContext) {
      this.drumGain.gain.setTargetAtTime(this.drumVolume, this.audioContext.currentTime, 0.01);
    }
  }

  /* ---------- транспорт ---------- */

  setBpm(bpm) {
    const v = clamp(Number(bpm) || 120, 40, 240);
    this.bpm = v;
    // Если играем — новое значение применяется со следующего (ещё не запланированного)
    // шага: пересчитываем его время от последнего запланированного.
    if (this.isPlaying && this._lastStepTime !== null) {
      this._nextStepTime = this._lastStepTime + this.stepDuration;
    }
  }

  /** Swing: 0 = ровно, 0.5 = максимальный сдвиг нечётных шагов. */
  setSwing(v) {
    this.swing = clamp(Number(v) || 0, 0, 0.5);
  }

  /** Длина паттерна: 16, 32 или 64 шага. Данные сохраняются по мере возможности. */
  setSteps(n) {
    const v = [16, 32, 64].includes(Number(n)) ? Number(n) : this.steps;
    if (v === this.steps) return this.steps;
    this.steps = v;
    this.matrix = this.matrix.map((row) => resizeRow(row, v));
    this.drumMatrix = this.drumMatrix.map((row) => resizeRow(row, v));
    return this.steps;
  }

  /* ---------- строки (динамические) ---------- */

  /** Добавить нотную строку. @returns {number} индекс новой строки */
  addRow(note, label) {
    const n = clamp(Math.round(Number(note)) || 60, 0, 127);
    this.rows.push({ note: n, label: label ?? noteLabel(n), muted: false });
    this.matrix.push(new Array(this.steps).fill(0));
    return this.rows.length - 1;
  }

  /** Удалить нотную строку вместе с её данными. */
  removeRow(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.rows.length) return false;
    this.rows.splice(index, 1);
    this.matrix.splice(index, 1);
    return true;
  }

  setRowMuted(index, muted) {
    if (this.rows[index]) this.rows[index].muted = !!muted;
  }

  setDrumRowMuted(index, muted) {
    if (this.drumRows[index]) this.drumRows[index].muted = !!muted;
  }

  setDrumRowVolume(index, v) {
    if (this.drumRows[index]) this.drumRows[index].volume = clamp(Number(v) || 0, 0, 1);
  }

  /* ---------- банки паттернов ---------- */

  /** Снимок текущих матриц (глубокая копия). */
  _snapshot() {
    return {
      matrix: this.matrix.map((r) => [...r]),
      drumMatrix: this.drumMatrix.map((r) => [...r]),
    };
  }

  _applySnapshot(snap) {
    if (!snap) return;
    this.matrix = snap.matrix.map((r) => resizeRow(r, this.steps));
    this.drumMatrix = snap.drumMatrix.map((r) => resizeRow(r, this.steps));
  }

  /** Переключить банк: текущий сохраняется в старый индекс, новый загружается. */
  selectBank(i) {
    const idx = clamp(Math.floor(Number(i)) || 0, 0, this.banks.length - 1);
    if (idx === this.bankIndex) return idx;
    this.banks[this.bankIndex] = this._snapshot();
    this.bankIndex = idx;
    const saved = this.banks[idx];
    if (saved) this._applySnapshot(saved);
    else this.clearPattern();
    return idx;
  }

  /** Скопировать содержимое банка from в банк to (не переключаясь). */
  copyBank(from, to) {
    const f = clamp(Math.floor(Number(from)) || 0, 0, this.banks.length - 1);
    const t = clamp(Math.floor(Number(to)) || 0, 0, this.banks.length - 1);
    const src = f === this.bankIndex ? this._snapshot() : this.banks[f];
    this.banks[t] = src
      ? { matrix: src.matrix.map((r) => [...r]), drumMatrix: src.drumMatrix.map((r) => [...r]) }
      : null;
    return t;
  }

  /**
   * Заменить нотные строки и матрицу результатом импорта (.mid).
   * Drum-дорожки не трогаем. Текущий слот банка синхронизируется со снимком.
   * @returns {{rows:number, steps:number}}
   */
  importPattern({ rows, matrix, steps }) {
    if (steps) this.setSteps(steps);
    this.rows = rows.map((r) => ({ note: r.note, label: r.label ?? noteLabel(r.note), muted: false }));
    this.matrix = this.rows.map((_, r) => resizeRow(matrix?.[r] || [], this.steps));
    this.banks[this.bankIndex] = this._snapshot();
    return { rows: this.rows.length, steps: this.steps };
  }

  setMidiOffset(ms) {
    this.midi.offsetMs = clamp(Number(ms) || 0, -200, 200);
  }

  /** Переключить MIDI-выход по id (из выпадающего списка портов). */
  selectMidiPort(id) {
    const out = this.midi.backend?.selectPort?.(id) ?? null;
    return out;
  }

  /**
   * Подключить приёмник к MIDI-входу того же бэкенда (или к отдельному).
   * Подписки сохраняются — они живут в MidiReceiver, а не в порту.
   * @returns {boolean} есть ли вход и удалась ли подписка
   */
  connectMidiInput(backend) {
    const ok = this.midiIn.connect(backend);
    // Одна сквозная подписка на ноты — для записи в сетку. Подписки живут
    // в MidiReceiver, а не в порту, поэтому при смене порта не дублируются.
    if (ok && !this._inputSubscribed) {
      this._inputSubscribed = true;
      this.midiIn.onNoteOn((m) => this._handleIncomingNote(m));
    }
    return ok;
  }

  /**
   * Режим записи с внешнего входа (клавиши FM-1):
   * 'off' — не пишем; 'step' — нажатие пишет ноту в клетку курсора и сдвигает
   * курсор на шаг; 'live' — пишет в текущий шаг играющего транспорта (овердаб).
   */
  setInputMode(mode) {
    this.inputMode = ['off', 'live', 'step'].includes(mode) ? mode : 'off';
    return this.inputMode;
  }

  get recordCursor() { return this._recordCursor; }

  /** Вернуть курсор STEP-записи в начало. */
  resetRecordCursor() { this._recordCursor = 0; }

  /** Нота с внешнего входа → запись в сетку (если режим включён). */
  _handleIncomingNote(m) {
    if (this.inputMode === 'off') return;
    let step;
    if (this.inputMode === 'live') {
      if (!this.isPlaying || this._currentStep < 0) {
        this._emitRecord({ skipped: true, reason: 'нет транспорта', note: m.note });
        return;
      }
      step = this._currentStep;
    } else {
      step = this._recordCursor % this.steps;
    }
    let row = this.rows.findIndex((r) => r.note === m.note);
    if (row < 0) {
      if (this.rows.length >= 16) {
        this._emitRecord({ skipped: true, reason: 'строки заполнены (16)', note: m.note });
        return;
      }
      row = this.addRow(m.note);
    }
    const velocity = clamp(m.velocity, 1, 127);
    this.matrix[row][step] = velocity;
    if (this.inputMode === 'step') {
      this._recordCursor = (this._recordCursor + 1) % this.steps;
    }
    this._emitRecord({ step, row, note: m.note, velocity });
  }

  _emitRecord(extra) {
    if (typeof this.onRecordEvent === 'function') {
      try { this.onRecordEvent({ mode: this.inputMode, cursor: this._recordCursor, ...extra }); }
      catch (err) { console.warn('[engine] onRecordEvent error:', err); }
    }
  }

  /** Переключить MIDI-вход по id; переподписываем приёмник на новый порт. */
  selectMidiInputPort(id) {
    const backend = this.midiIn.backend;
    const inp = backend?.selectInputPort?.(id) ?? null;
    if (inp) this.midiIn.connect(backend);
    return inp;
  }

  /** Включить/выключить клетку матрицы. @returns {number} новая velocity (0 = выкл) */
  toggleCell(row, step) {
    const cur = this.matrix[row]?.[step];
    const vel = cur > 0 ? 0 : this.velocity;
    this.matrix[row][step] = vel;
    return vel;
  }

  /** Задать velocity конкретной клетки (0 = выкл). */
  setCellVelocity(row, step, vel) {
    if (!this.matrix[row]) return 0;
    const v = clamp(Math.round(Number(vel)) || 0, 0, 127);
    this.matrix[row][step] = v;
    return v;
  }

  /** Включить/выключить клетку драм-матрицы. */
  toggleDrumCell(row, step) {
    const cur = this.drumMatrix[row]?.[step];
    const vel = cur > 0 ? 0 : this.velocity;
    this.drumMatrix[row][step] = vel;
    return vel;
  }

  /** Задать velocity клетки драмов. */
  setDrumCellVelocity(row, step, vel) {
    if (!this.drumMatrix[row]) return 0;
    const v = clamp(Math.round(Number(vel)) || 0, 0, 127);
    this.drumMatrix[row][step] = v;
    return v;
  }

  /** Очистить паттерн (ноты и драмы текущего банка). */
  clearPattern() {
    for (const row of this.matrix) row.fill(0);
    for (const row of this.drumMatrix) row.fill(0);
  }

  start() {
    if (this.isPlaying) return;
    if (!this.audioContext) throw new Error('Сначала вызовите initAudio()');
    this.midi.allNotesOff(); // страховка от нот, залипших с прошлого прогона
    this._absStep = 0;
    this._lastStepTime = null;
    this._uiQueue.length = 0;
    this._nextStepTime = this.audioContext.currentTime + START_DELAY_SEC;
    this.isPlaying = true;
    this._intervalId = this._timerApi.setInterval(() => this.tick(), this.tickMs);
    this.tick(); // не ждём первых 25 мс
    this._startUiLoop();
  }

  stop() {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    if (this._intervalId) {
      this._timerApi.clearInterval(this._intervalId);
      this._intervalId = 0;
    }
    const releasedNotes = this.midi.allNotesOff();
    this._uiQueue.length = 0;
    this._stopLoopSources();
    this._stopDrumSources();
    if (this.onTransportStop) this.onTransportStop(releasedNotes);
  }

  /* ---------- шедулер ---------- */

  /**
   * «Будильник» (каждые tickMs). Планирует всё, что попадает в окно
   * [сейчас; сейчас + lookahead]. Время шагов живёт в счётчике _nextStepTime
   * и не зависит от дрожания таймера — поэтому сетка не плывёт.
   */
  tick() {
    if (!this.isPlaying || !this.audioContext) return;
    this._ticks++;
    const ctx = this.audioContext;
    const horizon = ctx.currentTime + this._effectiveLookahead();
    while (this._nextStepTime < horizon) {
      this._scheduleStep(this._absStep, this._nextStepTime);
      this._lastStepTime = this._nextStepTime;
      this._nextStepTime += this.stepDuration;
      this._absStep++;
    }
    // Если вкладка была в фоне и rAF не крутился — выкидываем протухшие
    // визуальные события (звук и MIDI от этого не страдают).
    const q = this._uiQueue;
    while (q.length && q[0].time < ctx.currentTime - 0.5) q.shift();
  }

  /**
   * Пока вкладка видима — окно 100 мс. В фоне браузер троттлит setInterval
   * до ~1 раза в секунду, поэтому окно расширяем, чтобы музыка не рвалась.
   */
  _effectiveLookahead() {
    const hidden = typeof document !== 'undefined' && document.hidden;
    return hidden ? this.hiddenLookaheadSec : this.lookaheadSec;
  }

  /**
   * Разложить события шага: подсветка → MIDI-ноты → старт прохода лупа.
   * @param {number} absStep абсолютный номер шага (растёт бесконечно)
   * @param {number} time    аудио-время этого шага
   */
  _scheduleStep(absStep, time) {
    const step = absStep % this.steps;
    // Swing: нечётные шаги уезжают вправо на swing·stepDuration.
    // Границы тактов (чётные шаги, старт лупа) не трогаем — сетка целая.
    const t = time + (step % 2 === 1 ? this.swing * this.stepDuration : 0);

    // 1) Визуальная очередь (её разбирает rAF или тест)
    this._uiQueue.push({ step, absStep, time: t });

    // 2) Ноты FM-1: noteOn на границе шага, noteOff — через gate
    for (let r = 0; r < this.rows.length; r++) {
      const vel = this.matrix[r][step];
      if (!vel || this.rows[r].muted) continue;
      const note = this.rows[r].note;
      this.midi.scheduleNoteOn(note, vel, t);
      this.midi.scheduleNoteOff(note, t + this.stepDuration * this.gateRatio);
    }

    // 3) Драмы: ваншоты из library/instruments по тем же аудио-часам
    for (let r = 0; r < this.drumRows.length; r++) {
      const vel = this.drumMatrix[r][step];
      if (!vel || this.drumRows[r].muted) continue;
      this._scheduleDrumHit(r, vel, t);
    }

    // 4) Луп: новый проход стартует на границе своего периода (своё число тактов).
    //    Перезапуск «бесшовный», потому что мы планируем его заранее, а не
    //    полагаемся на source.loop — так смена BPM аккуратно применяется на границе.
    if (this.loop.buffer && this.loopGain && absStep % (this.steps * this.loop.bars) === 0) {
      this._scheduleLoopPass(time);
    }
  }

  /**
   * Запланировать один драм-хит на аудио-время t. Источник создаётся заранее
   * (look-ahead) и стартует sample-точно; choke-группа гасит предыдущие хиты.
   */
  _scheduleDrumHit(rowIdx, vel, t) {
    const row = this.drumRows[rowIdx];
    const buffer = this._drumBuffers.get(row.id);
    if (!buffer || !this.audioContext || !this.drumGain) return;
    const ctx = this.audioContext;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = (row.volume ?? 1) * clamp(vel, 1, 127) / 127;
    src.connect(gain).connect(this.drumGain);

    const entry = { src, gain, choke: row.choke ?? null };
    this._drumSources.add(entry);
    if (entry.choke) {
      let group = this._drumChokes.get(entry.choke);
      if (!group) { group = new Set(); this._drumChokes.set(entry.choke, group); }
      for (const prev of group) this._fadeStopDrum(prev);
      group.clear();
      group.add(entry);
    }
    src.onended = () => {
      this._drumSources.delete(entry);
      if (entry.choke) this._drumChokes.get(entry.choke)?.delete(entry);
      try { src.disconnect(); gain.disconnect(); } catch { /* браузер мог уже отключить */ }
    };
    src.start(t);
  }

  /** Микро-фейд и стоп одного драм-хита (choke / стоп транспорта). */
  _fadeStopDrum(entry) {
    const now = this.audioContext?.currentTime ?? 0;
    try { entry.gain.gain.setTargetAtTime(0, now, 0.008); } catch { /* ok */ }
    try { entry.src.stop(now + 0.03); } catch { /* уже остановлен */ }
  }

  /** Погасить все играющие драм-хиты (стоп транспорта). */
  _stopDrumSources() {
    if (!this._drumSources.size) return;
    for (const entry of this._drumSources) this._fadeStopDrum(entry);
    this._drumSources.clear();
    this._drumChokes.clear();
  }

  /** Запланировать один проход лупа, растянутый точно на loop.bars тактов. */
  _scheduleLoopPass(time) {
    const ctx = this.audioContext;
    const src = ctx.createBufferSource();
    src.buffer = this.loop.buffer;

    // «Родной» луп пересчитываем в текущий темп: например 1 такт @128 BPM,
    // сыгранный при 120 BPM, получит playbackRate = 1.875 / 2.0 … см. формулу:
    const span = this.barDuration * this.loop.bars; // сколько секунд должен занять проход
    src.playbackRate.value = clamp(span / this.loop.buffer.duration, 0.25, 4);

    const gain = ctx.createGain();
    gain.gain.value = 1; // громкость управляется общим loopGain
    src.connect(gain).connect(this.loopGain);

    const entry = { src, gain };
    this._loopSources.add(entry);
    src.onended = () => {
      this._loopSources.delete(entry);
      try { src.disconnect(); gain.disconnect(); } catch { /* браузер мог уже отключить */ }
    };
    src.start(time);
  }

  /** Погасить текущие проходы лупа с микро-фейдом (без щелчка на стопе). */
  _stopLoopSources() {
    if (!this._loopSources.size) return;
    const now = this.audioContext?.currentTime ?? 0;
    for (const { src, gain } of this._loopSources) {
      try { gain.gain.setTargetAtTime(0, now, 0.012); } catch { /* ok */ }
      try { src.stop(now + 0.06); } catch { /* уже остановлен */ }
    }
    this._loopSources.clear();
  }

  /* ---------- визуальная очередь ---------- */

  _startUiLoop() {
    if (!this._raf) return;
    const uiTick = () => {
      if (!this.isPlaying) return; // цепочка умирает на стопе, при старте запустится снова
      this.consumeDueSteps(this.audioContext.currentTime);
      this._raf(uiTick);
    };
    this._raf(uiTick);
  }

  /**
   * Отдать UI все шаги, чьё время уже наступило. Вызывается из rAF (браузер)
   * или вручную (тест). Для каждого срабатывает onStepTrigger(step, absStep, time).
   * @returns {{step:number, absStep:number, time:number}|null} последнее событие
   */
  consumeDueSteps(now) {
    let latest = null;
    while (this._uiQueue.length && this._uiQueue[0].time <= now) {
      const ev = this._uiQueue.shift();
      latest = ev;
      this._currentStep = ev.step; // для LIVE-записи: пишем в последний сыгранный шаг
      if (this.onStepTrigger) this.onStepTrigger(ev.step, ev.absStep, ev.time);
    }
    return latest;
  }

  /* ---------- служебное ---------- */

  /**
   * Снимок всего состояния секвенсора для сохранения (localStorage).
   * Банки сохраняются все; текущий банк кладётся и в banks[bankIndex].
   */
  serialize() {
    const banks = this.banks.map((b, i) => (b ?? (i === this.bankIndex ? this._snapshot() : null)));
    return {
      v: 2,
      bpm: this.bpm,
      steps: this.steps,
      swing: this.swing,
      drumVolume: this.drumVolume,
      loopUrl: this.loop.url,
      rows: this.rows.map((r) => ({ note: r.note, label: r.label, muted: !!r.muted })),
      drumRows: this.drumRows.map((r) => ({ id: r.id, muted: !!r.muted, volume: r.volume })),
      bankIndex: this.bankIndex,
      banks,
    };
  }

  /**
   * Восстановить состояние из объекта, полученного serialize().
   * @returns {boolean} true, если данные подошли
   */
  restore(data) {
    if (!data || data.v !== 2) return false;
    this.setSteps(data.steps);
    this.setBpm(data.bpm);
    this.setSwing(data.swing);
    this.setDrumVolume(data.drumVolume ?? 1);
    if (typeof data.loopUrl === 'string') this.loop.url = data.loopUrl;
    if (Array.isArray(data.rows) && data.rows.length) {
      this.rows = data.rows.map((r) => ({
        note: clamp(Math.round(Number(r.note)) || 60, 0, 127),
        label: r.label ?? noteLabel(r.note),
        muted: !!r.muted,
      }));
    }
    if (Array.isArray(data.drumRows)) {
      for (const saved of data.drumRows) {
        const row = this.drumRows.find((r) => r.id === saved.id);
        if (row) { row.muted = !!saved.muted; row.volume = clamp(Number(saved.volume ?? 1), 0, 1); }
      }
    }
    if (Array.isArray(data.banks)) {
      this.banks = Array.from({ length: 8 }, (_, i) => {
        const b = data.banks[i];
        if (!b || !Array.isArray(b.matrix) || !Array.isArray(b.drumMatrix)) return null;
        return {
          matrix: b.matrix.map((r) => resizeRow(r, this.steps)),
          drumMatrix: b.drumMatrix.map((r) => resizeRow(r, this.steps)),
        };
      });
    }
    this.bankIndex = clamp(Math.floor(Number(data.bankIndex)) || 0, 0, this.banks.length - 1);
    // Матрицы строк должны соответствовать rows по длине: пересобираем из банка.
    const saved = this.banks[this.bankIndex];
    if (saved && saved.matrix.length === this.rows.length && saved.drumMatrix.length === this.drumRows.length) {
      this._applySnapshot(saved);
    } else {
      this.matrix = this.rows.map(() => new Array(this.steps).fill(0));
      this.drumMatrix = this.drumRows.map(() => new Array(this.steps).fill(0));
    }
    return true;
  }

  /** Возврат вкладки из фона: если играем — будим аудио-контекст. */
  _bindVisibility() {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.isPlaying && this.audioContext?.state !== 'running') {
        this.audioContext?.resume?.().catch(() => {});
      }
    });
  }

  /** Снимок состояния для дебаг-панели. */
  getDebugInfo() {
    const ctx = this.audioContext;
    const buffer = this.loop.buffer;
    return {
      isPlaying: this.isPlaying,
      bpm: this.bpm,
      steps: this.steps,
      absStep: this._absStep,
      ticks: this._ticks,
      scheduledUiEvents: this._uiQueue.length,
      lookaheadMs: this._effectiveLookahead() * 1000,
      ctx: ctx
        ? {
            state: ctx.state,
            sampleRate: ctx.sampleRate,
            baseLatencyMs: Number.isFinite(ctx.baseLatency) ? ctx.baseLatency * 1000 : null,
            outputLatencyMs: Number.isFinite(ctx.outputLatency) ? ctx.outputLatency * 1000 : null,
          }
        : null,
      midi: {
        connected: this.midi.connected,
        backendName: this.midi.backend?.name ?? null,
        sentCount: this.midi.sentCount,
        pendingSends: this.midi.pendingCount,
        soundingNotes: this.midi.soundingNotes,
        offsetMs: this.midi.offsetMs,
        useTimestamp: this.midi.useTimestamp,
      },
      midiIn: {
        connected: this.midiIn.connected,
        portName: this.midiIn.backend?.input?.name ?? null,
        messageCount: this.midiIn.messageCount,
        ccSeen: Object.keys(this.midiIn.ccState).map(Number),
        lastEvent: this.midiIn.lastEvent,
      },
      drums: {
        loaded: this._drumBuffers.size,
        total: this.drumRows.length,
        volume: this.drumVolume,
        active: this._drumSources.size,
      },
      bank: this.bankIndex,
      swing: this.swing,
      loop: {
        loaded: !!buffer,
        fileName: this.loop.url ? this.loop.url.split('/').pop() : null,
        durationSec: buffer ? buffer.duration : null,
        sourceBpm: this.loop.sourceBpm,
        bars: this.loop.bars,
        effectiveRate: buffer ? (this.barDuration * this.loop.bars) / buffer.duration : null,
      },
    };
  }
}
