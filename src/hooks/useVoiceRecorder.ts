// ─── useVoiceRecorder Hook ────────────────────────────────────────────────────
// Recording lifecycle, permissions, duration, metering, warning at 110s,
// auto-stop at 120s, smooth 100ms updates, live amplitude history.
// Uses expo-audio (SDK 56/57).

import { useState, useRef, useCallback, useEffect } from 'react';
import {
  useAudioRecorder,
  useAudioRecorderState,
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
} from 'expo-audio';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface RecordingState {
  status: 'idle' | 'requesting-permission' | 'recording' | 'cancelled' | 'stopped';
  durationMs: number;
  metering: number;              // dBFS, -160 .. 0
  amplitudeHistory: number[];    // normalized 0..1, last 50 samples
  isWarning: boolean;
  permissionDenied: boolean;
  permissionDeniedPermanently: boolean;
}

export interface RecordingResult {
  uri: string;
  durationMs: number;
  fileSize: number;
  metering: number;
}

export interface UseVoiceRecorderOptions {
  /** Fires when the 120s auto-stop kicks in — the result you'd normally get from stopRecording(). */
  onAutoStop?: (result: RecordingResult) => void;
}

export interface UseVoiceRecorderReturn {
  state: RecordingState;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<RecordingResult | null>;
  cancelRecording: () => Promise<void>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_DURATION_MS = 120_000;
const WARNING_THRESHOLD_MS = 110_000;
const MIN_DURATION_MS = 1_000;
const UPDATE_INTERVAL_MS = 100;
const AMPLITUDE_HISTORY_LENGTH = 50;

const INITIAL_STATE: RecordingState = {
  status: 'idle',
  durationMs: 0,
  metering: -160,
  amplitudeHistory: [],
  isWarning: false,
  permissionDenied: false,
  permissionDeniedPermanently: false,
};

/** Convert dBFS to a 0..1 normalized amplitude (clamped to -60..0 dB). */
function normalizeMetering(db: number): number {
  const clamped = Math.max(-60, Math.min(0, db));
  return (clamped + 60) / 60;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useVoiceRecorder(
  options: UseVoiceRecorderOptions = {},
): UseVoiceRecorderReturn {
  const { onAutoStop } = options;

  const [state, setState] = useState<RecordingState>(INITIAL_STATE);
  const isStoppingRef = useRef(false);
  const isRecordingRef = useRef(false);

  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    isMeteringEnabled: true,
  });

  // 100 ms → smooth timer + live waveform
  const recorderState = useAudioRecorderState(recorder, UPDATE_INTERVAL_MS);

  const onAutoStopRef = useRef(onAutoStop);
  onAutoStopRef.current = onAutoStop;

  // ── Core stop implementation ─────────────────────────────────────────────
  const stopRecordingInternal = useCallback(async (): Promise<RecordingResult | null> => {
    if (!isRecordingRef.current || isStoppingRef.current) return null;
    isStoppingRef.current = true;

    try {
      await recorder.stop();

      const uri = recorder.uri;
      const durationMs = recorderState.durationMillis;
      const metering = recorderState.metering ?? -160;

      isRecordingRef.current = false;

      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
      }).catch(() => {});

      if (!uri || durationMs < MIN_DURATION_MS) {
        setState(INITIAL_STATE);
        return null;
      }

      setState((prev) => ({ ...prev, status: 'stopped', durationMs }));

      const estimatedFileSize = Math.round((durationMs / 1000) * 16_000);

      return { uri, durationMs, fileSize: estimatedFileSize, metering };
    } catch (error) {
      console.error('[useVoiceRecorder] stop error:', error);
      isRecordingRef.current = false;
      setState(INITIAL_STATE);
      return null;
    } finally {
      isStoppingRef.current = false;
    }
  }, [recorder, recorderState.durationMillis, recorderState.metering]);

  // Ref-based access so the effect never captures a stale closure.
  const stopRecordingRef = useRef(stopRecordingInternal);
  stopRecordingRef.current = stopRecordingInternal;

  // ── Sync recorder → component state + auto-stop ──────────────────────────
  useEffect(() => {
    if (!isRecordingRef.current) return;

    const durationMs = recorderState.durationMillis;
    const rawMetering = recorderState.metering ?? -160;
    const isWarning = durationMs >= WARNING_THRESHOLD_MS;
    const normalized = normalizeMetering(rawMetering);

    setState((prev) => {
      if (
        prev.durationMs === durationMs &&
        prev.metering === rawMetering &&
        prev.isWarning === isWarning
      ) {
        return prev;
      }
      const amplitudeHistory = [
        ...prev.amplitudeHistory.slice(-(AMPLITUDE_HISTORY_LENGTH - 1)),
        normalized,
      ];
      return {
        ...prev,
        durationMs,
        metering: rawMetering,
        amplitudeHistory,
        isWarning,
      };
    });

    if (durationMs >= MAX_DURATION_MS && !isStoppingRef.current) {
      void stopRecordingRef.current().then((result) => {
        if (result && onAutoStopRef.current) onAutoStopRef.current(result);
      });
    }
  }, [recorderState]);

  // ── Start ────────────────────────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    if (isRecordingRef.current || isStoppingRef.current) return;

    try {
      setState((prev) => ({ ...prev, status: 'requesting-permission' }));

      const permissionResponse = await AudioModule.requestRecordingPermissionsAsync();

      if (!permissionResponse.granted) {
        setState({
          ...INITIAL_STATE,
          permissionDenied: true,
          permissionDeniedPermanently: !permissionResponse.canAskAgain,
        });
        return;
      }

      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });

      await recorder.prepareToRecordAsync();
      recorder.record();

      isRecordingRef.current = true;

      setState({
        status: 'recording',
        durationMs: 0,
        metering: -160,
        amplitudeHistory: [],
        isWarning: false,
        permissionDenied: false,
        permissionDeniedPermanently: false,
      });
    } catch (error) {
      console.error('[useVoiceRecorder] start error:', error);
      isRecordingRef.current = false;
      setState(INITIAL_STATE);
    }
  }, [recorder]);

  // ── Stop ─────────────────────────────────────────────────────────────────
  const stopRecording = useCallback(
    (): Promise<RecordingResult | null> => stopRecordingInternal(),
    [stopRecordingInternal],
  );

  // ── Cancel ───────────────────────────────────────────────────────────────
  const cancelRecording = useCallback(async () => {
    if (!isRecordingRef.current) return;

    try {
      await recorder.stop();
    } catch (error) {
      console.error('[useVoiceRecorder] cancel error:', error);
    } finally {
      isRecordingRef.current = false;
      isStoppingRef.current = false;
      await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
      setState({ ...INITIAL_STATE, status: 'cancelled' });
    }
  }, [recorder]);

  useEffect(() => {
    return () => {
      if (isRecordingRef.current) {
        recorder.stop().catch(() => {});
        isRecordingRef.current = false;
      }
    };
  }, [recorder]);

  return { state, startRecording, stopRecording, cancelRecording };
}