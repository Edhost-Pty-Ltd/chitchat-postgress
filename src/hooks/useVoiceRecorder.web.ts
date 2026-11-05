// ─── useVoiceRecorder Hook (Web Implementation) ──────────────────────────────
// Matches the native hook's public API exactly so ChatScreen compiles and
// runs identically on web. Uses the browser's MediaRecorder API.

import { useState, useRef, useCallback, useEffect } from 'react';

// ─── Re-use the same interface names that the native version exports ──────────
export interface RecordingState {
  status: 'idle' | 'requesting-permission' | 'recording' | 'cancelled' | 'stopped';
  durationMs: number;
  metering: number;
  amplitudeHistory: number[];
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

export interface UseVoiceRecorderReturn {
  state: RecordingState;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<RecordingResult | null>;
  cancelRecording: () => void;
}

const MAX_DURATION_MS = 120_000;
const WARNING_DURATION_MS = 110_000;
const TICK_MS = 100;
const HISTORY_LEN = 50;

const INITIAL_STATE: RecordingState = {
  status: 'idle',
  durationMs: 0,
  metering: -160,
  amplitudeHistory: [],
  isWarning: false,
  permissionDenied: false,
  permissionDeniedPermanently: false,
};

export function useVoiceRecorder(): UseVoiceRecorderReturn {
  const [state, setState] = useState<RecordingState>(INITIAL_STATE);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef   = useRef<Blob[]>([]);
  const startTimeRef     = useRef<number>(0);
  const intervalRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const analyserRef      = useRef<AnalyserNode | null>(null);
  const audioCtxRef      = useRef<AudioContext | null>(null);

  const clearTimer = () => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
  };

  const startRecording = useCallback(async () => {
    setState({ ...INITIAL_STATE, status: 'requesting-permission' });

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err: any) {
      // Permission denied — canAskAgain is not available in browsers
      setState({
        ...INITIAL_STATE,
        status: 'idle',
        permissionDenied: true,
        // Treat NotAllowedError as permanently denied (browser won't prompt again
        // in the same session once denied via the permission chip).
        permissionDeniedPermanently: err?.name === 'NotAllowedError',
      });
      return;
    }

    // Optional: hook up an AnalyserNode for metering
    try {
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
    } catch { /* metering is optional */ }

    audioChunksRef.current = [];

    // Prefer webm/opus; fall back gracefully
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : '';

    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
    recorder.onstop = () => stream.getTracks().forEach((t) => t.stop());
    recorder.start();
    mediaRecorderRef.current = recorder;
    startTimeRef.current = Date.now();

    setState({ ...INITIAL_STATE, status: 'recording' });

    const buf = new Uint8Array(analyserRef.current?.frequencyBinCount ?? 0);

    intervalRef.current = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current;

      // Read metering
      let metering = -160;
      let normalised = 0;
      if (analyserRef.current) {
        analyserRef.current.getByteFrequencyData(buf);
        const avg = buf.reduce((s, v) => s + v, 0) / buf.length;
        normalised = avg / 255;
        metering = avg > 0 ? (20 * Math.log10(avg / 255)) : -160;
      }

      setState((prev) => {
        const history = [...prev.amplitudeHistory, normalised].slice(-HISTORY_LEN);
        return {
          ...prev,
          durationMs: elapsed,
          metering,
          amplitudeHistory: history,
          isWarning: elapsed >= WARNING_DURATION_MS,
        };
      });

      if (elapsed >= MAX_DURATION_MS) {
        // Auto-stop — will trigger stopRecording path below
        mediaRecorderRef.current?.stop();
        clearTimer();
      }
    }, TICK_MS);
  }, []);

  const stopRecording = useCallback(async (): Promise<RecordingResult | null> => {
    clearTimer();
    const recorder = mediaRecorderRef.current;
    if (!recorder) return null;

    return new Promise<RecordingResult | null>((resolve) => {
      const originalOnStop = recorder.onstop;
      recorder.onstop = (e) => {
        // Run existing cleanup (stream track stop)
        if (typeof originalOnStop === 'function') (originalOnStop as any)(e);

        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        const uri  = URL.createObjectURL(blob);
        const durationMs = Date.now() - startTimeRef.current;

        // Tear down audio context
        try { audioCtxRef.current?.close(); } catch {}
        audioCtxRef.current = null;
        analyserRef.current = null;
        mediaRecorderRef.current = null;

        setState({ ...INITIAL_STATE, status: 'stopped' });
        resolve({ uri, durationMs, fileSize: blob.size, metering: -30 });
      };
      recorder.stop();
    });
  }, []);

  const cancelRecording = useCallback(() => {
    clearTimer();
    try { mediaRecorderRef.current?.stop(); } catch {}
    try { audioCtxRef.current?.close(); } catch {}
    audioCtxRef.current = null;
    analyserRef.current = null;
    mediaRecorderRef.current = null;
    setState({ ...INITIAL_STATE, status: 'cancelled' });
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearTimer();
      try { mediaRecorderRef.current?.stop(); } catch {}
      try { audioCtxRef.current?.close(); } catch {}
    };
  }, []);

  return { state, startRecording, stopRecording, cancelRecording };
}
