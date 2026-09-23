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
 * Задача: найти выход «FM-1» (или первый доступный) и уметь отправлять байты.
 * Интерфейс такой же, каким будет у BLE-бэкенда (Web Bluetooth) в следующем этапе:
 *   { name, sendNow(bytes), sendScheduled(bytes, perfMs), selectPort(id) }
 */
export class WebMidiBackend {
  /** @returns {boolean} есть ли Web MIDI в этом браузере */
  static isSupported() {
    return typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
  }

  /**
   * Запрашивает доступ и выбирает выход. ВАЖНО: вызывать из обработчика
   * жеста пользователя (клик по кнопке) — Chrome требует user gesture.
   * @param {{ preferredName?: string }} [options]
   */
  static async connect(options = {}) {
    if (!this.isSupported()) {
      throw new Error('Web MIDI API недоступен. Нужен Chrome 152+ и открытие по http://localhost');
    }
    const access = await navigator.requestMIDIAccess();
    const outputs = [...access.outputs.values()];
    if (!outputs.length) {
      throw new Error('MIDI-выходы не найдены. Подключите FM-1 кабелем USB-C и разрешите доступ в диалоге Chrome.');
    }
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const wanted = norm(options.preferredName ?? 'fm-1');
    const output = outputs.find((p) => norm(p.name).includes(wanted)) ?? outputs[0];
    return new WebMidiBackend(access, output);
  }

  constructor(access, output) {
    this.access = access;
    this.output = output;
  }

  get name() {
    return this.output?.name ?? 'MIDI';
  }

  /** Пользуемся ли мы встроенным планировщиком браузера (timestamp). */
  get supportsTimestamp() {
    return true;
  }

  /** Отправить немедленно (тест-нота, all-notes-off, режим «своя очередь»). */
  sendNow(bytes) {
    this.output.send(bytes);
  }

  /** Отправить в момент perfMs (шкала performance.now()). Экспериментальный режим. */
  sendScheduled(bytes, perfMs) {
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
    this.rows = options.rows ?? DEFAULT_ROWS.map((r) => ({ ...r }));
    this.steps = options.steps ?? 16;
    this.bpm = clamp(options.bpm ?? 120, 40, 240);
    this.lookaheadSec = options.lookaheadSec ?? 0.1;
    this.hiddenLookaheadSec = options.hiddenLookaheadSec ?? 2.5;
    this.tickMs = options.tickMs ?? 25;
    this.gateRatio = options.gateRatio ?? 0.5;
    this.velocity = options.velocity ?? 100;

    /** Матрица паттерна: matrix[row][step] = 0 (выкл) или velocity 1..127. */
    this.matrix = this.rows.map(() => new Array(this.steps).fill(0));

    this.audioContext = options.audioContext ?? null;
    this.loopGain = null;
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

  setMidiOffset(ms) {
    this.midi.offsetMs = clamp(Number(ms) || 0, -200, 200);
  }

  /** Переключить MIDI-выход по id (из выпадающего списка портов). */
  selectMidiPort(id) {
    const out = this.midi.backend?.selectPort?.(id) ?? null;
    return out;
  }

  /** Включить/выключить клетку матрицы. @returns {number} новая velocity (0 = выкл) */
  toggleCell(row, step) {
    const cur = this.matrix[row]?.[step];
    const vel = cur > 0 ? 0 : this.velocity;
    this.matrix[row][step] = vel;
    return vel;
  }

  /** Очистить паттерн. */
  clearPattern() {
    for (const row of this.matrix) row.fill(0);
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

    // 1) Визуальная очередь (её разбирает rAF или тест)
    this._uiQueue.push({ step, absStep, time });

    // 2) Ноты FM-1: noteOn на границе шага, noteOff — через gate
    for (let r = 0; r < this.rows.length; r++) {
      const vel = this.matrix[r][step];
      if (!vel) continue;
      const note = this.rows[r].note;
      this.midi.scheduleNoteOn(note, vel, time);
      this.midi.scheduleNoteOff(note, time + this.stepDuration * this.gateRatio);
    }

    // 3) Луп: новый проход стартует на границе своего периода (своё число тактов).
    //    Перезапуск «бесшовный», потому что мы планируем его заранее, а не
    //    полагаемся на source.loop — так смена BPM аккуратно применяется на границе.
    if (this.loop.buffer && this.loopGain && absStep % (this.steps * this.loop.bars) === 0) {
      this._scheduleLoopPass(time);
    }
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
      if (this.onStepTrigger) this.onStepTrigger(ev.step, ev.absStep, ev.time);
    }
    return latest;
  }

  /* ---------- служебное ---------- */

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
