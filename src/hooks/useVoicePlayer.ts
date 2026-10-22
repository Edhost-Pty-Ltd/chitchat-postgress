// ─── useVoicePlayer Hook ──────────────────────────────────────────────────────
// Manages audio playback for voice notes. Single-active-player pattern ensures
// only one voice note plays at a time. Handles audio mode configuration,
// progress tracking, interruption, and cleanup.
//
// Uses expo-audio (SDK 57).

import { useState, useRef, useEffect, useCallback } from 'react';
import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from 'expo-audio';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface PlaybackState {
  activeMessageId: string | null;
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'error';
  positionMs: number;
  durationMs: number;
  error: string | null;
}

export interface UseVoicePlayerReturn {
  state: PlaybackState;
  play: (voiceUrl: string, messageId: string, durationMs: number) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: () => Promise<void>;
  seek: (positionMs: number) => Promise<void>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const INITIAL_STATE: PlaybackState = {
  activeMessageId: null,
  status: 'idle',
  positionMs: 0,
  durationMs: 0,
  error: null,
};

const LOADING_TIMEOUT_MS = 15_000;

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useVoicePlayer(): UseVoicePlayerReturn {
  const [state, setState] = useState<PlaybackState>(INITIAL_STATE);
  const [currentSource, setCurrentSource] = useState<string | null>(null);

  // Player is recreated by expo-audio whenever currentSource changes.
  const player = useAudioPlayer(currentSource);
  const playerStatus = useAudioPlayerStatus(player);

  const activeMessageIdRef = useRef<string | null>(null);
  const loadingTimeoutRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasPlayingRef      = useRef(false);

  // ── Helpers ─────────────────────────────────────────────────────────────

  function clearLoadingTimeout() {
    if (loadingTimeoutRef.current) {
      clearTimeout(loadingTimeoutRef.current);
      loadingTimeoutRef.current = null;
    }
  }

  // ── Sync player status → React state ────────────────────────────────────
  useEffect(() => {
    // Only process status updates when we have an active message.
    if (!activeMessageIdRef.current) return;

    if (playerStatus.error) {
      clearLoadingTimeout();
      setState((prev) => ({
        ...prev,
        status: 'error',
        error: playerStatus.error ?? 'Playback error',
      }));
      wasPlayingRef.current = false;
      return;
    }

    if (playerStatus.didJustFinish) {
      clearLoadingTimeout();
      setState((prev) => ({ ...prev, status: 'idle', positionMs: 0 }));
      wasPlayingRef.current = false;
      return;
    }

    if (playerStatus.playing) {
      // Audio has actually started — this is the authoritative transition to
      // 'playing'. Clear the loading timeout here, not before.
      clearLoadingTimeout();
      wasPlayingRef.current = true;
      setState((prev) => ({
        ...prev,
        status: 'playing',
        positionMs: Math.round(playerStatus.currentTime * 1000),
        durationMs: playerStatus.duration > 0
          ? Math.round(playerStatus.duration * 1000)
          : prev.durationMs,
      }));
    } else if (playerStatus.isLoaded && wasPlayingRef.current && !playerStatus.isBuffering) {
      // Audio was interrupted externally (phone call, headphone unplug, etc.)
      wasPlayingRef.current = false;
      setState((prev) => {
        if (prev.status === 'playing') {
          return {
            ...prev,
            status: 'paused',
            positionMs: Math.round(playerStatus.currentTime * 1000),
          };
        }
        return prev;
      });
    } else if (playerStatus.isLoaded) {
      setState((prev) => ({
        ...prev,
        positionMs: Math.round(playerStatus.currentTime * 1000),
        durationMs: playerStatus.duration > 0
          ? Math.round(playerStatus.duration * 1000)
          : prev.durationMs,
      }));
    }
  }, [playerStatus]);

  // ── Auto-play when source changes ────────────────────────────────────────
  // expo-audio creates a new player instance when currentSource changes.
  // We call play() here (not inside the play() callback) because the new
  // player reference is only available after the re-render triggered by
  // setCurrentSource().
  useEffect(() => {
    if (!currentSource || !player || !activeMessageIdRef.current) return;
    try {
      player.play();
    } catch (err) {
      console.error('[useVoicePlayer] Auto-play error:', err);
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

  // ── Cleanup on unmount ──────────────────────────────────────────────────
  useEffect(() => {
    return () => { clearLoadingTimeout(); };
  }, []);

  // ── Play ────────────────────────────────────────────────────────────────

  const play = useCallback(async (voiceUrl: string, messageId: string, durationMs: number) => {
    console.log('[useVoicePlayer] play():', { messageId, isLocal: voiceUrl.startsWith('file://') });

    // Stop current player if switching to a different voice note.
    if (currentSource && currentSource !== voiceUrl) {
      try { player?.pause(); } catch { /* ignore — old player might be unloaded */ }
    }

    clearLoadingTimeout();
    activeMessageIdRef.current = messageId;

    setState({
      activeMessageId: messageId,
      status: 'loading',
      positionMs: 0,
      durationMs,
      error: null,
    });

    // FIX 1: Always include allowsRecording: false.
    // The voice recorder sets allowsRecording: true for iOS to use the recording
    // audio session. Without resetting it here, iOS keeps routing audio to the
    // earpiece (recording mode) — the speaker produces no sound during playback.
    try {
      await setAudioModeAsync({
        playsInSilentMode: true,
        interruptionMode: 'duckOthers',
        allowsRecording: false,
      });
    } catch {
      setState((prev) => ({
        ...prev,
        status: 'error',
        error: 'Failed to configure audio mode',
      }));
      return;
    }

    // Arm the loading timeout. It is cleared when playerStatus.playing fires
    // (audio actually started) or when an error occurs.
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
        // Replay the same note: seek to start and play immediately.
        player.seekTo(0);
        player.play();
        clearLoadingTimeout();
        wasPlayingRef.current = true;
        setState((prev) => ({ ...prev, status: 'playing' }));
      } else {
        // FIX 2: New source — set state and let the auto-play effect call
        // player.play() once expo-audio has created the new player instance.
        // Do NOT prematurely set status:'playing' or clear the timeout here;
        // the playerStatus sync effect handles both when playing actually starts.
        setCurrentSource(voiceUrl);
      }
    } catch (error: any) {
      clearLoadingTimeout();
      activeMessageIdRef.current = null;
      console.error('[useVoicePlayer] Play error:', error);
      setState((prev) => ({
        ...prev,
        status: 'error',
        error: 'Failed to load voice note',
      }));
    }
  }, [currentSource, player]);

  // ── Pause ───────────────────────────────────────────────────────────────

  const pause = useCallback(async () => {
    try {
      player?.pause();
      wasPlayingRef.current = false;
      setState((prev) => ({ ...prev, status: 'paused' }));
    } catch (err) {
      console.error('[useVoicePlayer] Pause error:', err);
    }
  }, [player]);

  // ── Resume ──────────────────────────────────────────────────────────────

  const resume = useCallback(async () => {
    try {
      player?.play();
      wasPlayingRef.current = true;
      setState((prev) => ({ ...prev, status: 'playing' }));
    } catch (err) {
      console.error('[useVoicePlayer] Resume error:', err);
    }
  }, [player]);

  // ── Stop ────────────────────────────────────────────────────────────────

  const stop = useCallback(async () => {
    try {
      clearLoadingTimeout();
      wasPlayingRef.current = false;
      activeMessageIdRef.current = null;
      if (player && currentSource) {
        player.pause();
        player.seekTo(0);
      }
      // Don't clear currentSource — keeping it lets replay work without refetch.
      setState(INITIAL_STATE);
    } catch (err) {
      console.error('[useVoicePlayer] Stop error:', err);
      setState(INITIAL_STATE);
    }
  }, [player, currentSource]);

  // ── Seek ────────────────────────────────────────────────────────────────

  const seek = useCallback(async (positionMs: number) => {
    try {
      if (player && activeMessageIdRef.current) {
        player.seekTo(positionMs / 1000);
        setState((prev) => ({ ...prev, positionMs }));
      }
    } catch (err) {
      console.error('[useVoicePlayer] Seek error:', err);
    }
  }, [player]);

  return { state, play, pause, resume, stop, seek };
}
