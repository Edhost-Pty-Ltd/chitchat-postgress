// ─── useVoicePlayer Hook ─────────────────────────────────────────────────────
// Playback for voice notes with speed control (1x / 1.5x / 2x).
// Uses expo-audio (SDK 57).

import { useState, useRef, useEffect, useCallback } from 'react';
import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from 'expo-audio';

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

export function useVoicePlayer(): UseVoicePlayerReturn {
  const [state, setState] = useState<PlaybackState>(INITIAL_STATE);
  const [currentSource, setCurrentSource] = useState<string | null>(null);

  const player = useAudioPlayer(currentSource);
  const playerStatus = useAudioPlayerStatus(player);

  const activeMessageIdRef = useRef<string | null>(null);
  const loadingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasPlayingRef = useRef(false);
  const playbackRateRef = useRef<PlaybackRate>(1);

  const clearLoadingTimeout = () => {
    if (loadingTimeoutRef.current) {
      clearTimeout(loadingTimeoutRef.current);
      loadingTimeoutRef.current = null;
    }
  };

  // ── Apply rate whenever it changes OR player changes ────────────────────
  useEffect(() => {
    if (!player) return;
    try {
      player.setPlaybackRate(playbackRateRef.current, 'high');
    } catch {
      /* player not ready yet — retried when playing starts */
    }
  }, [player, state.playbackRate]);

  // ── Sync player status → React state ────────────────────────────────────
  useEffect(() => {
    if (!activeMessageIdRef.current) return;

    if (playerStatus.error) {
      clearLoadingTimeout();
      wasPlayingRef.current = false;
      setState((prev) => ({
        ...prev,
        status: 'error',
        error: playerStatus.error ?? 'Playback error',
      }));
      return;
    }

    if (playerStatus.didJustFinish) {
      clearLoadingTimeout();
      wasPlayingRef.current = false;
      setState((prev) => ({ ...prev, status: 'idle', positionMs: 0 }));
      return;
    }

    if (playerStatus.playing) {
      clearLoadingTimeout();
      wasPlayingRef.current = true;
      // Re-apply rate — survives player recreation.
      try {
        if (player) player.setPlaybackRate(playbackRateRef.current, 'high');
      } catch {}
      
      setState((prev) => ({
        ...prev,
        status: 'playing',
        positionMs: Math.round(playerStatus.currentTime * 1000),
        durationMs:
          playerStatus.duration > 0
            ? Math.round(playerStatus.duration * 1000)
            : prev.durationMs,
      }));
    } else if (
      playerStatus.isLoaded &&
      wasPlayingRef.current &&
      !playerStatus.isBuffering
    ) {
      wasPlayingRef.current = false;
      setState((prev) =>
        prev.status === 'playing'
          ? {
              ...prev,
              status: 'paused',
              positionMs: Math.round(playerStatus.currentTime * 1000),
            }
          : prev,
      );
    } else if (playerStatus.isLoaded) {
      setState((prev) => ({
        ...prev,
        positionMs: Math.round(playerStatus.currentTime * 1000),
        durationMs:
          playerStatus.duration > 0
            ? Math.round(playerStatus.duration * 1000)
            : prev.durationMs,
      }));
    }
  }, [playerStatus, player]);

  // ── Auto-play when source changes ───────────────────────────────────────
  useEffect(() => {
    if (!currentSource || !player || !activeMessageIdRef.current) return;
    try {
      player.setPlaybackRate(playbackRateRef.current, 'high');
      player.play();
    } catch (err) {
      console.error('[useVoicePlayer] auto-play error:', err);
      clearLoadingTimeout();
      const id = activeMessageIdRef.current;
      activeMessageIdRef.current = null;
      setState((prev) =>
        prev.activeMessageId === id
          ? { ...prev, status: 'error', error: 'Failed to start playback' }
          : prev,
      );
    }
  }, [currentSource, player]);

  useEffect(() => () => clearLoadingTimeout(), []);

  // ── Play ─────────────────────────────────────────────────────────────────
  const play = useCallback(
    async (voiceUrl: string, messageId: string, durationMs: number) => {
      if (currentSource && currentSource !== voiceUrl) {
        try {
          player?.pause();
        } catch {}
      }

      clearLoadingTimeout();
      activeMessageIdRef.current = messageId;

      setState((prev) => ({
        ...prev,
        activeMessageId: messageId,
        status: 'loading',
        positionMs: 0,
        durationMs,
        error: null,
        // keep playbackRate across notes
      }));

      try {
        await setAudioModeAsync({
          playsInSilentMode: true,
          interruptionMode: 'doNotMix',
          allowsRecording: false,  
          allowsBackgroundRecording:true,
          shouldPlayInBackground:true,
        });
      } catch {
        setState((prev) => ({
          ...prev,
          status: 'error',
          error: 'Failed to configure audio mode',
        }));
        return;
      }

      loadingTimeoutRef.current = setTimeout(() => {
        setState((prev) => ({
          ...prev,
          status: 'error',
          error: 'Voice note unavailable — network timeout',
        }));
        activeMessageIdRef.current = null;
      }, LOADING_TIMEOUT_MS);

      try {
        if (currentSource === voiceUrl && player) {
          player.seekTo(0);
          player.setPlaybackRate(playbackRateRef.current, 'high');
          player.play();
          clearLoadingTimeout();
          wasPlayingRef.current = true;
          setState((prev) => ({ ...prev, status: 'playing' }));
        } else {
          setCurrentSource(voiceUrl);
        }
      } catch (error) {
        clearLoadingTimeout();
        activeMessageIdRef.current = null;
        console.error('[useVoicePlayer] play error:', error);
        setState((prev) => ({
          ...prev,
          status: 'error',
          error: 'Failed to load voice note',
        }));
      }
    },
    [currentSource, player],
  );

  // ── Pause / Resume / Stop / Seek ────────────────────────────────────────
  const pause = useCallback(async () => {
    try {
      player?.pause();
      wasPlayingRef.current = false;
      setState((prev) => ({ ...prev, status: 'paused' }));
    } catch (err) {
      console.error('[useVoicePlayer] pause error:', err);
    }
  }, [player]);

  const resume = useCallback(async () => {
    try {
      if (player) {
        player.setPlaybackRate(playbackRateRef.current, 'high');
        player.play();
      }
      wasPlayingRef.current = true;
      setState((prev) => ({ ...prev, status: 'playing' }));
    } catch (err) {
      console.error('[useVoicePlayer] resume error:', err);
    }
  }, [player]);

  const stop = useCallback(async () => {
    try {
      clearLoadingTimeout();
      wasPlayingRef.current = false;
      activeMessageIdRef.current = null;
      if (player && currentSource) {
        player.pause();
        player.seekTo(0);
      }
      setState((prev) => ({ ...INITIAL_STATE, playbackRate: prev.playbackRate }));
    } catch (err) {
      console.error('[useVoicePlayer] stop error:', err);
      setState((prev) => ({ ...INITIAL_STATE, playbackRate: prev.playbackRate }));
    }
  }, [player, currentSource]);

  const seek = useCallback(
    async (positionMs: number) => {
      try {
        if (player && activeMessageIdRef.current) {
          player.seekTo(positionMs / 1000);
          setState((prev) => ({ ...prev, positionMs }));
        }
      } catch (err) {
        console.error('[useVoicePlayer] seek error:', err);
      }
    },
    [player],
  );

  // ── Speed control ───────────────────────────────────────────────────────
  const setPlaybackRate = useCallback(
    (rate: PlaybackRate) => {
      playbackRateRef.current = rate;
      setState((prev) => ({ ...prev, playbackRate: rate }));
      try {
        if (player) player.setPlaybackRate(rate, 'high');
      } catch (err) {
        console.error('[useVoicePlayer] setRate error:', err);
      }
    },
    [player],
  );

  const cyclePlaybackRate = useCallback(() => {
    const idx = PLAYBACK_RATES.indexOf(playbackRateRef.current);
    const next = PLAYBACK_RATES[(idx + 1) % PLAYBACK_RATES.length];
    setPlaybackRate(next);
  }, [setPlaybackRate]);

  return {
    state,
    play,
    pause,
    resume,
    stop,
    seek,
    setPlaybackRate,
    cyclePlaybackRate,
  };
}
