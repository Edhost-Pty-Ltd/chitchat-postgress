// ─── useVoicePlayer Hook (Web) ────────────────────────────────────────────────
// Matches the native expo-audio hook's public API exactly so VoiceMessageBubble
// and VoiceNotePlayer work identically on web.
// Uses the HTML5 <audio> element — no extra dependencies.

import { useState, useRef, useCallback, useEffect } from 'react';

export type PlaybackRate = 1 | 1.5 | 2;
export const PLAYBACK_RATES: PlaybackRate[] = [1, 1.5, 2];

export interface PlaybackState {
  activeMessageId: string | null;
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'error';
  positionMs: number;
  durationMs: number;
  error: string | null;
  playbackRate: PlaybackRate;
}

export interface UseVoicePlayerReturn {
  state: PlaybackState;
  play: (voiceUrl: string, messageId: string, durationMs: number) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: () => Promise<void>;
  seek: (positionMs: number) => Promise<void>;
  setPlaybackRate: (rate: PlaybackRate) => void;
  cyclePlaybackRate: () => void;
}

const INITIAL_STATE: PlaybackState = {
  activeMessageId: null,
  status: 'idle',
  positionMs: 0,
  durationMs: 0,
  error: null,
  playbackRate: 1,
};

const LOADING_TIMEOUT_MS = 15_000;
const TICK_MS = 80; // progress update interval

export function useVoicePlayer(): UseVoicePlayerReturn {
  const [state, setState] = useState<PlaybackState>(INITIAL_STATE);

  const audioRef         = useRef<HTMLAudioElement | null>(null);
  const tickRef          = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef       = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeIdRef      = useRef<string | null>(null);
  const playbackRateRef  = useRef<PlaybackRate>(1);
  // Incremented every time play() is called; each Audio element captures its
  // own generation so stale event handlers from a previous play session can
  // detect they are outdated and silently ignore their callbacks.
  const generationRef    = useRef<number>(0);

  // ── helpers ─────────────────────────────────────────────────────────────────
  const clearTick = () => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
  };
  const clearTimeout_ = () => {
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
  };

  const startTick = (audio: HTMLAudioElement) => {
    clearTick();
    tickRef.current = setInterval(() => {
      if (!audio.paused) {
        setState((prev) => ({
          ...prev,
          positionMs: Math.round(audio.currentTime * 1000),
        }));
      }
    }, TICK_MS);
  };

  // Tears down the current audio element without touching activeIdRef or state.
  // Bumping generationRef here ensures all pending event callbacks from the
  // old element see themselves as stale.
  const teardown = () => {
    clearTick();
    clearTimeout_();
    generationRef.current += 1; // invalidate all callbacks from the old element
    if (audioRef.current) {
      const old = audioRef.current;
      audioRef.current = null;
      // Strip all handlers BEFORE clearing src so none of them fire during teardown
      old.onloadedmetadata = null;
      old.onplaying        = null;
      old.onpause          = null;
      old.onended          = null;
      old.onerror          = null;
      old.pause();
      old.src = '';
      old.load(); // ensures the browser releases the resource
    }
  };

  // ── play ────────────────────────────────────────────────────────────────────
  const play = useCallback(async (voiceUrl: string, messageId: string, durationMs: number) => {
    // Tear down any existing audio FIRST, then capture the new generation id
    teardown();
    const myGen = generationRef.current; // unique token for this play session
    activeIdRef.current = messageId;

    setState((prev) => ({
      ...prev,
      activeMessageId: messageId,
      status: 'loading',
      positionMs: 0,
      durationMs,
      error: null,
    }));

    // Loading timeout
    timeoutRef.current = setTimeout(() => {
      if (generationRef.current !== myGen) return; // superseded
      teardown();
      activeIdRef.current = null;
      setState((prev) =>
        prev.activeMessageId === messageId
          ? { ...prev, status: 'error', error: 'Voice note unavailable — network timeout' }
          : prev,
      );
    }, LOADING_TIMEOUT_MS);

    try {
      const audio = new Audio(voiceUrl);
      audio.playbackRate = playbackRateRef.current;
      audioRef.current = audio;

      // Wire up events — each handler checks myGen before touching state
      audio.onloadedmetadata = () => {
        if (generationRef.current !== myGen) return;
        clearTimeout_();
        setState((prev) =>
          prev.activeMessageId === messageId
            ? { ...prev, durationMs: Math.round(audio.duration * 1000) || durationMs }
            : prev,
        );
      };

      audio.onplaying = () => {
        if (generationRef.current !== myGen) return;
        clearTimeout_();
        setState((prev) =>
          prev.activeMessageId === messageId
            ? { ...prev, status: 'playing' }
            : prev,
        );
        startTick(audio);
      };

      audio.onpause = () => {
        if (generationRef.current !== myGen) return;
        clearTick();
        setState((prev) =>
          prev.activeMessageId === messageId && prev.status === 'playing'
            ? { ...prev, status: 'paused', positionMs: Math.round(audio.currentTime * 1000) }
            : prev,
        );
      };

      audio.onended = () => {
        if (generationRef.current !== myGen) return;
        clearTick();
        clearTimeout_();
        activeIdRef.current = null;
        setState((prev) =>
          prev.activeMessageId === messageId
            ? { ...prev, status: 'idle', positionMs: 0 }
            : prev,
        );
      };

      audio.onerror = () => {
        if (generationRef.current !== myGen) return;
        clearTick();
        clearTimeout_();
        activeIdRef.current = null;
        setState((prev) =>
          prev.activeMessageId === messageId
            ? { ...prev, status: 'error', error: 'Failed to play voice note' }
            : prev,
        );
      };

      await audio.play();
    } catch (err: any) {
      if (generationRef.current !== myGen) return;
      clearTick();
      clearTimeout_();
      activeIdRef.current = null;
      setState((prev) =>
        prev.activeMessageId === messageId
          ? { ...prev, status: 'error', error: err?.message ?? 'Playback failed' }
          : prev,
      );
    }
  }, []);

  // ── pause ───────────────────────────────────────────────────────────────────
  const pause = useCallback(async () => {
    clearTick();
    audioRef.current?.pause();
    // onpause handler will update the state
  }, []);

  // ── resume ──────────────────────────────────────────────────────────────────
  const resume = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.playbackRate = playbackRateRef.current;
    await audio.play().catch(() => {});
    // onplaying handler will flip status → 'playing' and restart the tick
  }, []);

  // ── stop ────────────────────────────────────────────────────────────────────
  const stop = useCallback(async () => {
    const savedRate = playbackRateRef.current;
    teardown();
    activeIdRef.current = null;
    setState({ ...INITIAL_STATE, playbackRate: savedRate });
  }, []);

  // ── seek ────────────────────────────────────────────────────────────────────
  const seek = useCallback(async (positionMs: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = positionMs / 1000;
    setState((prev) => ({ ...prev, positionMs }));
  }, []);

  // ── playback rate ────────────────────────────────────────────────────────────
  const setPlaybackRate = useCallback((rate: PlaybackRate) => {
    playbackRateRef.current = rate;
    if (audioRef.current) audioRef.current.playbackRate = rate;
    setState((prev) => ({ ...prev, playbackRate: rate }));
  }, []);

  const cyclePlaybackRate = useCallback(() => {
    const idx  = PLAYBACK_RATES.indexOf(playbackRateRef.current);
    const next = PLAYBACK_RATES[(idx + 1) % PLAYBACK_RATES.length];
    setPlaybackRate(next);
  }, [setPlaybackRate]);

  // ── cleanup on unmount ───────────────────────────────────────────────────────
  useEffect(() => () => teardown(), []);

  return { state, play, pause, resume, stop, seek, setPlaybackRate, cyclePlaybackRate };
}
