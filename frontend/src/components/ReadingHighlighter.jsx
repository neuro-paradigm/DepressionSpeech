import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { advancePointer, normalizeWord, spokenTokens } from '../utils/voiceMatch';

const WORD_SPLIT = /\s+/;

function splitWords(text = '') {
  return String(text).split(WORD_SPLIT).filter(Boolean);
}

/**
 * Voice-driven read-along guide.
 *
 * The prompt's words are wrapped in tracked spans and a highlight moves
 * word-by-word so the reader always knows what comes next. The pointer is
 * driven by real speech when available:
 *
 * - FINAL recognition results lock the pointer monotonically — revisions of
 *   partial results can never drag it backwards.
 * - INTERIM results only preview ahead, giving instant feedback while the
 *   engine settles on what was said.
 * - A look-ahead window tolerates dropped/mangled words; fuzzy matching
 *   tolerates accents and mispronunciations.
 *
 * Manual controls remain as fallbacks (tap any word / Space / arrow keys),
 * plus an optional timer-driven "Auto" mode for browsers without speech
 * recognition. Remount (or change `restartKey`) to rewind.
 */
export function KaraokeReader({
  lines,
  playing = false,
  defaultWpm = 140,
  compact = false,
  speech = null,
  voiceSupported = false,
}) {
  const [wpm, setWpm] = useState(defaultWpm);
  const [cursor, setCursor] = useState(0);
  const [autoFollow, setAutoFollow] = useState(false);
  const [paused, setPaused] = useState(false);
  const [voiceSynced, setVoiceSynced] = useState(false);
  const userTookControlRef = useRef(false);

  // Pointer locked by final (committed) speech — monotonic, never rewinds.
  const lockedRef = useRef(0);
  // How many spoken-final tokens have already been consumed.
  const consumedFinalRef = useRef(0);
  const scrollRef = useRef(null);

  const structuredLines = useMemo(() => {
    const baseLines = (lines || []).map((line, index) => ({
      ...line,
      id: line.id ?? `line-${index}`,
      words: splitWords(line.text),
    }));
    const wordCounts = baseLines.map((line) => line.words.length);
    return baseLines.map((line, index) => ({
      ...line,
      startIndex: wordCounts.slice(0, index).reduce((sum, count) => sum + count, 0),
    }));
  }, [lines]);

  const targets = useMemo(
    () => structuredLines.flatMap((line) => line.words.map((word) => normalizeWord(word))),
    [structuredLines],
  );
  const wordTotal = targets.length;

  const finished = wordTotal > 0 && cursor >= wordTotal;
  const voiceDriving = Boolean(playing && voiceSupported && voiceSynced && speech && !finished);
  const autoRunning = playing && autoFollow && !paused && !finished && !voiceDriving;

  // Auto-advance while recording (unless voice is driving or paused).
  useEffect(() => {
    if (!autoRunning || cursor >= wordTotal) return undefined;
    const intervalMs = Math.max(120, Math.round((60 / Math.max(wpm, 40)) * 1000));
    const timer = setTimeout(() => {
      setCursor((current) => Math.min(current + 1, wordTotal));
    }, intervalMs);
    return () => clearTimeout(timer);
  }, [autoRunning, wpm, wordTotal, cursor]);

  // When a recording starts, engage auto-follow unless the user already chose
  // to step manually for this prompt.
  useEffect(() => {
    if (playing && !userTookControlRef.current) {
      setAutoFollow(true);
      setPaused(false);
    }
  }, [playing]);

  // Voice tracking: match the live transcript against the prompt words.
  // Finalized speech advances the locked pointer; interim speech previews.
  useEffect(() => {
    if (!playing || !speech || !wordTotal) return undefined;
    const frame = requestAnimationFrame(() => {
      const locked = Math.min(lockedRef.current, wordTotal);

      const finals = spokenTokens(speech.final || '');
      const freshFinals = finals.slice(Math.min(consumedFinalRef.current, finals.length));
      consumedFinalRef.current = finals.length;

      const afterFinals = advancePointer(freshFinals, locked, targets);
      const interimPosition = advancePointer(spokenTokens(speech.interim || ''), afterFinals, targets);

      lockedRef.current = afterFinals;
      setVoiceSynced(afterFinals > locked || interimPosition > afterFinals || afterFinals > 0);
      setCursor(Math.min(Math.max(afterFinals, interimPosition), wordTotal));
    });
    return () => cancelAnimationFrame(frame);
  }, [speech, playing, wordTotal, targets]);

  // Keep the active word comfortably in view without yanking the whole page.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const active = container.querySelector(`[data-kw="${cursor}"]`);
    if (!active) return;
    const top = active.offsetTop;
    const bottom = top + active.offsetHeight;
    if (top < container.scrollTop + 24 || bottom > container.scrollTop + container.clientHeight - 24) {
      container.scrollTo({ top: Math.max(0, top - container.clientHeight / 2.5), behavior: 'smooth' });
    }
  }, [cursor]);

  // Manual stepping repositions the locked pointer too, so voice matching
  // continues from wherever the reader jumps to.
  const step = useCallback((delta) => {
    userTookControlRef.current = true;
    setAutoFollow(false);
    lockedRef.current = Math.min(wordTotal, Math.max(0, lockedRef.current + delta));
    setCursor(lockedRef.current);
  }, [wordTotal]);

  // Keyboard read-along: Space/→ forward, ← back. Ignored while typing.
  useEffect(() => {
    function onKeyDown(event) {
      const target = event.target;
      if (target instanceof HTMLElement
        && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) {
        return;
      }
      if (event.key === ' ' || event.key === 'ArrowRight') {
        event.preventDefault();
        step(1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        step(-1);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [step]);

  function jumpTo(index) {
    userTookControlRef.current = true;
    setAutoFollow(false);
    lockedRef.current = index;
    setCursor(index);
  }

  function enableAuto() {
    userTookControlRef.current = true;
    setPaused(false);
    setAutoFollow(true);
  }

  function restart() {
    userTookControlRef.current = false;
    lockedRef.current = 0;
    // Skip every final token already spoken so far, otherwise restarting
    // mid-recording would replay the whole transcript at once.
    consumedFinalRef.current = speech ? spokenTokens(speech.final || '').length : 0;
    setVoiceSynced(false);
    setPaused(false);
    setCursor(0);
  }

  const progress = wordTotal ? Math.min(100, Math.round((cursor / wordTotal) * 100)) : 0;

  return (
    <div className={`karaoke ${compact ? 'karaoke-compact' : ''}`}>
      <div className="karaoke-lines" ref={scrollRef}>
        {structuredLines.map((line) => (
          <div className="karaoke-line" key={line.id}>
            {line.label && (
              <span className={`karaoke-label${line.tone ? ` tone-${line.tone}` : ''}`}>{line.label}</span>
            )}
            <p className="karaoke-text">
              {line.words.map((word, wordIndex) => {
                const index = line.startIndex + wordIndex;
                const state =
                  index < cursor ? 'past'
                    : index === cursor ? 'active'
                      : 'ahead';
                return (
                  <span
                    key={wordIndex}
                    data-kw={index}
                    className={`karaoke-word ${state}`}
                    onClick={() => jumpTo(index)}
                  >
                    {word}
                  </span>
                );
              })}
            </p>
          </div>
        ))}
      </div>

      <p className="karaoke-hint no-print">
        {voiceDriving
          ? 'Following your voice — keep reading.'
          : voiceSupported && playing
            ? 'Listening… read aloud and the guide follows your voice. You can also click words or press Space.'
            : 'Click any word — or press Space / → — to move the highlight at your own pace.'}
      </p>

      <div className="karaoke-controls no-print">
        <span className={`karaoke-status${voiceDriving ? ' on' : ''}`}>
          {voiceDriving ? '● Voice-synced' : voiceSupported && playing ? '◌ Listening…' : 'Tap-along'}
        </span>
        <button
          type="button"
          className={`secondary karaoke-play${autoRunning ? ' playing' : ''}`}
          onClick={() => (autoRunning ? setPaused(true) : enableAuto())}
          disabled={!wordTotal || voiceDriving}
          title={autoRunning ? 'Pause automatic highlighting' : 'Highlight words automatically'}
        >
          {autoRunning ? '❚❚ Pause auto' : '▶ Auto'}
        </button>
        <button type="button" className="secondary karaoke-restart" onClick={restart} disabled={!wordTotal} title="Back to the first word">
          ↺ Restart
        </button>
        <label className="karaoke-speed">
          <span>Auto speed</span>
          <input
            type="range"
            min="80"
            max="240"
            step="10"
            value={wpm}
            onChange={(event) => setWpm(Number(event.target.value))}
          />
          <em>{wpm} wpm</em>
        </label>
        <div className="karaoke-progress" aria-hidden="true">
          <span style={{ width: `${progress}%` }} />
        </div>
        <span className="karaoke-percent">{progress}%</span>
      </div>
    </div>
  );
}
