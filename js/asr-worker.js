// Speech recognition (Whisper) in a Web Worker so the page stays responsive.
// Runs entirely in the browser; the model is downloaded once and cached.
// The self-contained browser bundle (the ".web" build has bare imports that need a bundler).
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';

env.allowLocalModels = false;
let asr = null;
let loadedKey = '';

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      const key = `${m.model}|${m.device}`;
      if (!asr || loadedKey !== key) {
        asr = await pipeline('automatic-speech-recognition', m.model, {
          device: m.device,
          // WebGPU: full-precision encoder + 4-bit decoder; WASM: 8-bit quantized.
          dtype: m.device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
          progress_callback: (p) => {
            if (p.status === 'progress') self.postMessage({ type: 'download', file: p.file, loaded: p.loaded, total: p.total });
          },
        });
        loadedKey = key;
      }
      self.postMessage({ type: 'ready', device: m.device });
    } else if (m.type === 'run') {
      const out = await asr(m.audio, {
        language: m.language,
        task: 'transcribe',
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: true,
      });
      self.postMessage({ type: 'result', id: m.id, chunks: out.chunks || [{ timestamp: [0, null], text: out.text }] });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String(err?.message || err) });
  }
};
