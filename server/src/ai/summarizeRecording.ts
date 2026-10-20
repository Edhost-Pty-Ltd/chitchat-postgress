// ─── Meeting recording → AI minutes ─────────────────────────────────────────
// Port of the old `summarizeMeetingRecording` Cloud Function. Reads the audio
// from the object store, uploads it to the Gemini Files API (resumable),
// waits until the file is ACTIVE, transcribes it, turns the transcript into
// formal minutes, then deletes the temporary Gemini file. Prompts, retries and
// polling match the original function.

import { getEnv } from '../config/env.js';
import { logger } from '../config/logger.js';
import { getObjectBuffer } from '../media/presign.js';

export class SummarizeError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_CONFIGURED' | 'UPSTREAM' | 'TIMEOUT' | 'EMPTY',
  ) {
    super(message);
    this.name = 'SummarizeError';
  }
}

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function geminiConfigured(): boolean {
  return !!getEnv().GEMINI_API_KEY;
}

/** Summarize the audio object `objectKey` into meeting minutes. */
export async function summarizeRecordingObject(
  objectKey: string,
  recordingId: string,
): Promise<string> {
  const env = getEnv();
  const key = env.GEMINI_API_KEY;
  if (!key) throw new SummarizeError('GEMINI_API_KEY is not set on the server.', 'NOT_CONFIGURED');

  // 1. Read the audio from the object store.
  const { bytes: audio, contentType } = await getObjectBuffer(objectKey);
  const mimeType = contentType && contentType.startsWith('audio/') ? contentType : 'audio/mp4';
  const size = audio.byteLength;
  logger.info({ recordingId, size }, '[summarize] fetched audio');

  // 2. Start a resumable upload to the Gemini Files API.
  const startRes = await fetch(`${GEMINI_BASE}/upload/v1beta/files?key=${key}`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(size),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: `rec_${recordingId}.m4a` } }),
  });
  if (!startRes.ok) {
    throw new SummarizeError(`Gemini upload start failed: ${await startRes.text()}`, 'UPSTREAM');
  }
  const uploadUrl = startRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new SummarizeError('Gemini did not return an upload URL.', 'UPSTREAM');

  // 3. Upload the bytes.
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(size),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: new Uint8Array(audio),
  });
  if (!uploadRes.ok) {
    throw new SummarizeError(`Gemini upload failed: ${await uploadRes.text()}`, 'UPSTREAM');
  }
  const uploadData = (await uploadRes.json()) as { file?: { name?: string; uri?: string } };
  const fileName = uploadData.file?.name;
  const fileUri = uploadData.file?.uri;
  if (!fileName || !fileUri) throw new SummarizeError('Gemini did not return a file URI.', 'UPSTREAM');

  try {
    // 4. Poll until the file is ACTIVE.
    for (let i = 0; i < 20; i++) {
      const stateRes = await fetch(`${GEMINI_BASE}/v1beta/${fileName}?key=${key}`);
      const stateData = (await stateRes.json()) as { state?: string };
      if (stateData.state === 'ACTIVE') break;
      if (stateData.state === 'FAILED') throw new SummarizeError('Gemini file processing failed.', 'UPSTREAM');
      if (i === 19) {
        throw new SummarizeError('Timed out waiting for Gemini to process the audio.', 'TIMEOUT');
      }
      await sleep(3000);
    }

    const endpoint = `${GEMINI_BASE}/v1beta/models/${env.GEMINI_MODEL}:generateContent?key=${key}`;

    // POST with up to 4 attempts on capacity / rate-limit errors (5s/10s/15s backoff).
    const geminiPost = async (body: object): Promise<any> => {
      let lastError = '';
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt > 0) await sleep(5000 * attempt);
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = (await res.json()) as any;
        if (res.ok) return data;
        const msg: string = data?.error?.message ?? `Gemini error ${res.status}`;
        lastError = msg;
        const lower = msg.toLowerCase();
        if (res.status === 429 || res.status === 503 || lower.includes('high demand') || lower.includes('quota')) {
          logger.warn({ attempt: attempt + 1 }, '[summarize] Gemini capacity error, retrying');
          continue;
        }
        throw new SummarizeError(msg, 'UPSTREAM');
      }
      throw new SummarizeError(`Gemini overloaded after retries: ${lastError}`, 'UPSTREAM');
    };

    // 5. Transcribe.
    const transcriptData = await geminiPost({
      contents: [
        {
          parts: [
            {
              text:
                'Transcribe this meeting recording verbatim. Include every spoken word accurately. ' +
                'Do not summarize — produce a full, clean transcript only. Label each speaker as ' +
                '"Speaker 1:", "Speaker 2:", etc. when voices change.',
            },
            { fileData: { mimeType, fileUri } },
          ],
        },
      ],
    });
    const tCand = transcriptData.candidates?.[0];
    const transcript = ((tCand?.content?.parts ?? []) as any[])
      .map((p) => p.text ?? '')
      .join('')
      .trim();
    if (!transcript) {
      throw new SummarizeError(
        `Empty transcript (finishReason: ${tCand?.finishReason ?? 'unknown'}).`,
        'EMPTY',
      );
    }

    // 6. Summarize into formal minutes.
    const promptText = [
      'You are a professional executive meeting secretary. Using the transcript below, produce formal, structured meeting minutes.',
      '',
      'Format your output EXACTLY as follows:',
      '',
      'MEETING MINUTES',
      '---',
      '',
      'EXECUTIVE SUMMARY',
      "[2-4 sentence overview of the meeting's purpose and main outcomes]",
      '',
      'KEY TOPICS DISCUSSED',
      '- [Topic 1]',
      '- [Topic 2]',
      '',
      'DECISIONS MADE',
      '- [Decision 1]',
      '',
      'ACTION ITEMS',
      '- [Person/Role] - [Task] - [Deadline if mentioned]',
      '',
      'FULL TRANSCRIPT',
      transcript,
      '',
      'Write in formal business English. Be concise, accurate, and professional.',
    ].join('\n');

    const summaryData = await geminiPost({ contents: [{ parts: [{ text: promptText }] }] });
    const minutes: string =
      summaryData.candidates?.[0]?.content?.parts?.[0]?.text ?? 'No summary returned.';
    logger.info({ recordingId, chars: minutes.length }, '[summarize] minutes generated');
    return minutes;
  } finally {
    // 7. Clean up the temporary Gemini file (best effort).
    try {
      await fetch(`${GEMINI_BASE}/v1beta/${fileName}?key=${key}`, { method: 'DELETE' });
    } catch (err) {
      logger.warn({ err }, '[summarize] failed to delete Gemini file');
    }
  }
}
