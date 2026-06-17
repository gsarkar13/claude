"use client";

import { useState, useRef, useCallback, useEffect } from "react";

type CleanupMode = "fix" | "formal" | "bullet" | "email" | "slack";
type TranscribeMode = "browser" | "groq";
type HistoryItem = {
  id: string;
  raw: string;
  cleaned: string | null;
  mode: CleanupMode | null;
  ts: number;
};

const MODES: { value: CleanupMode; label: string; icon: string }[] = [
  { value: "fix", label: "Fix Grammar", icon: "✏️" },
  { value: "formal", label: "Formal", icon: "👔" },
  { value: "bullet", label: "Bullets", icon: "•" },
  { value: "email", label: "Email", icon: "✉️" },
  { value: "slack", label: "Slack", icon: "💬" },
];

interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}
interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognitionInstance;
    webkitSpeechRecognition: new () => SpeechRecognitionInstance;
  }
}

export default function Home() {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [rawText, setRawText] = useState("");
  const [interimText, setInterimText] = useState("");
  const [cleanedText, setCleanedText] = useState("");
  const [activeMode, setActiveMode] = useState<CleanupMode>("fix");
  const [transcribeMode, setTranscribeMode] = useState<TranscribeMode>("browser");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [amplitude, setAmplitude] = useState(0);
  const [hasSpeechAPI, setHasSpeechAPI] = useState(true);
  const [showHistory, setShowHistory] = useState(false);

  const isRecordingRef = useRef(false);
  const chunksRef = useRef<Blob[]>([]);
  const animFrameRef = useRef<number>(0);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem("whisperflow_history");
    if (saved) setHistory(JSON.parse(saved));
    const supported = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    setHasSpeechAPI(supported);
    if (!supported) setTranscribeMode("groq");
  }, []);

  const saveHistory = useCallback((items: HistoryItem[]) => {
    localStorage.setItem("whisperflow_history", JSON.stringify(items.slice(0, 50)));
  }, []);

  const animateAmplitude = useCallback(() => {
    if (!analyserRef.current) return;
    const data = new Uint8Array(analyserRef.current.frequencyBinCount);
    analyserRef.current.getByteFrequencyData(data);
    const avg = data.reduce((a, b) => a + b, 0) / data.length;
    setAmplitude(avg / 128);
    animFrameRef.current = requestAnimationFrame(animateAmplitude);
  }, []);

  const setupAudioAnalyser = useCallback(async (stream: MediaStream) => {
    const ctx = new AudioContext();
    audioCtxRef.current = ctx;
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    analyserRef.current = analyser;
    animateAmplitude();
  }, [animateAmplitude]);

  const teardownAudio = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current);
    setAmplitude(0);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    audioCtxRef.current?.close();
    analyserRef.current = null;
  }, []);

  // Browser Web Speech API — auto-restarts on mobile Chrome where continuous mode is unreliable
  const startBrowserRecording = useCallback(async () => {
    setError("");
    setRawText("");
    setCleanedText("");
    setInterimText("");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      await setupAudioAnalyser(stream);

      const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

      const launchRec = () => {
        if (!isRecordingRef.current) return;
        const recognition = new SpeechRec();
        recognition.continuous = false; // false = more reliable on Android Chrome
        recognition.interimResults = true;
        recognition.lang = "en-US";

        recognition.onresult = (e) => {
          let final = "";
          let interim = "";
          for (let i = 0; i < e.results.length; i++) {
            if (e.results[i].isFinal) final += e.results[i][0].transcript + " ";
            else interim += e.results[i][0].transcript;
          }
          setRawText((prev) => (prev + " " + final).trim());
          setInterimText(interim);
        };

        recognition.onerror = (e) => {
          if (e.error === "not-allowed") {
            setError("Microphone permission denied.");
          } else if (e.error === "network") {
            setError("Network error. Try ⚡ Groq Whisper mode instead.");
          } else if (e.error !== "aborted" && e.error !== "no-speech") {
            setError(`Error: ${e.error}. Try ⚡ Groq Whisper mode.`);
          }
        };

        recognition.onend = () => {
          setInterimText("");
          // Auto-restart while still holding
          if (isRecordingRef.current) {
            setTimeout(launchRec, 100);
          }
        };

        recognition.start();
      };

      isRecordingRef.current = true;
      setRecording(true);
      launchRec();
    } catch {
      setError("Microphone access denied.");
    }
  }, [setupAudioAnalyser]);

  const stopBrowserRecording = useCallback(() => {
    isRecordingRef.current = false;
    setRecording(false);
    setInterimText("");
    teardownAudio();
  }, [teardownAudio]);

  // Groq Whisper — records audio then sends to API
  const startGroqRecording = useCallback(async () => {
    setError("");
    setRawText("");
    setCleanedText("");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      await setupAudioAnalyser(stream);

      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.start(100);
      isRecordingRef.current = true;
      setRecording(true);
    } catch {
      setError("Microphone access denied.");
    }
  }, [setupAudioAnalyser]);

  const stopGroqRecording = useCallback(async () => {
    isRecordingRef.current = false;
    setRecording(false);
    teardownAudio();

    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    await new Promise<void>((resolve) => { recorder.onstop = () => resolve(); recorder.stop(); });

    const blob = new Blob(chunksRef.current, { type: "audio/webm" });
    if (blob.size < 1000) return;

    setTranscribing(true);
    try {
      const form = new FormData();
      form.append("audio", blob, "recording.webm");
      const res = await fetch("/api/transcribe", { method: "POST", body: form });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setRawText(data.text);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transcription failed");
    } finally {
      setTranscribing(false);
    }
  }, [teardownAudio]);

  const startRecording = useCallback(() => {
    if (transcribeMode === "browser") startBrowserRecording();
    else startGroqRecording();
  }, [transcribeMode, startBrowserRecording, startGroqRecording]);

  const stopRecording = useCallback(() => {
    if (transcribeMode === "browser") stopBrowserRecording();
    else stopGroqRecording();
  }, [transcribeMode, stopBrowserRecording, stopGroqRecording]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (e.code === "Space" && !e.repeat && !recording && tag !== "TEXTAREA" && tag !== "INPUT") {
        e.preventDefault();
        startRecording();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space" && recording) { e.preventDefault(); stopRecording(); }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener("keyup", onKeyUp); };
  }, [recording, startRecording, stopRecording]);

  const cleanup = useCallback(async (mode: CleanupMode) => {
    if (!rawText) return;
    setActiveMode(mode);
    setCleaning(true);
    setCleanedText("");
    try {
      const res = await fetch("/api/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: rawText, mode }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setCleanedText(data.text);

      const item: HistoryItem = { id: crypto.randomUUID(), raw: rawText, cleaned: data.text, mode, ts: Date.now() };
      setHistory((prev) => { const next = [item, ...prev]; saveHistory(next); return next; });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cleanup failed");
    } finally {
      setCleaning(false);
    }
  }, [rawText, saveHistory]);

  const copy = useCallback((text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, []);

  const scale = recording ? 1 + amplitude * 0.35 : 1;

  const HistoryPanel = (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-gray-800 flex items-center justify-between">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">History</h2>
        <button onClick={() => setShowHistory(false)} className="md:hidden text-gray-600 hover:text-white text-lg leading-none">×</button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {history.length === 0 ? (
          <p className="text-gray-600 text-xs p-4">No recordings yet</p>
        ) : (
          history.map((item) => (
            <button
              key={item.id}
              onClick={() => { setRawText(item.raw); setCleanedText(item.cleaned ?? ""); if (item.mode) setActiveMode(item.mode); setShowHistory(false); }}
              className="w-full text-left p-3 border-b border-gray-800/60 hover:bg-gray-800 transition-colors"
            >
              <p className="text-xs text-gray-600 mb-1">
                {new Date(item.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                {item.mode && <span className="ml-2 text-blue-500">{item.mode}</span>}
              </p>
              <p className="text-xs text-gray-400 truncate">{item.cleaned ?? item.raw}</p>
            </button>
          ))
        )}
      </div>
      {history.length > 0 && (
        <button
          onClick={() => { setHistory([]); localStorage.removeItem("whisperflow_history"); }}
          className="p-3 text-xs text-gray-600 hover:text-red-500 transition-colors border-t border-gray-800"
        >
          Clear history
        </button>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-950 text-white flex">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-64 bg-gray-900 border-r border-gray-800 flex-col overflow-hidden shrink-0">
        {HistoryPanel}
      </aside>

      {/* Mobile history drawer */}
      {showHistory && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowHistory(false)} />
          <div className="absolute left-0 top-0 bottom-0 w-72 bg-gray-900 flex flex-col">
            {HistoryPanel}
          </div>
        </div>
      )}

      {/* Main */}
      <main className="flex-1 flex flex-col items-center px-4 py-6 md:p-8 overflow-y-auto">
        {/* Header */}
        <div className="w-full max-w-2xl mb-6">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-3">
              {/* Mobile history button */}
              <button
                onClick={() => setShowHistory(true)}
                className="md:hidden flex flex-col gap-1 p-2 rounded-lg hover:bg-gray-800 transition-colors"
              >
                <span className="block w-5 h-0.5 bg-gray-400" />
                <span className="block w-5 h-0.5 bg-gray-400" />
                <span className="block w-5 h-0.5 bg-gray-400" />
              </button>
              <div>
                <h1 className="text-xl md:text-2xl font-bold bg-gradient-to-r from-blue-400 to-violet-500 bg-clip-text text-transparent">
                  WhisperFlow
                </h1>
                <p className="text-gray-600 text-xs mt-0.5 hidden md:block">
                  Hold <kbd className="bg-gray-800 px-1 py-0.5 rounded text-gray-400 font-mono text-xs">Space</kbd> or button · 100% free
                </p>
              </div>
            </div>

            {/* Mode toggle */}
            <div className="flex items-center gap-1 bg-gray-900 rounded-lg p-1 text-xs border border-gray-800">
              <button
                onClick={() => setTranscribeMode("browser")}
                disabled={!hasSpeechAPI}
                className={`px-2 md:px-3 py-1.5 rounded-md transition-all whitespace-nowrap ${
                  transcribeMode === "browser"
                    ? "bg-blue-600 text-white"
                    : "text-gray-500 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                }`}
              >
                🌐 <span className="hidden sm:inline">Browser</span>
              </button>
              <button
                onClick={() => setTranscribeMode("groq")}
                className={`px-2 md:px-3 py-1.5 rounded-md transition-all whitespace-nowrap ${
                  transcribeMode === "groq"
                    ? "bg-violet-600 text-white"
                    : "text-gray-500 hover:text-white"
                }`}
              >
                ⚡ <span className="hidden sm:inline">Groq</span>
              </button>
            </div>
          </div>

          <p className={`text-xs mt-2 ${transcribeMode === "browser" ? "text-green-500/70" : "text-violet-400/70"}`}>
            {transcribeMode === "browser"
              ? "✓ Browser mode — no API key needed (Chrome/Edge)"
              : "⚡ Groq Whisper — high quality, works on all browsers"}
          </p>
        </div>

        {/* Record Button */}
        <div className="relative flex items-center justify-center mb-6 md:mb-8">
          {recording && (
            <>
              <div className="absolute w-48 h-48 md:w-44 md:h-44 rounded-full bg-red-500/10 animate-ping" style={{ animationDuration: "1.5s" }} />
              <div className="absolute w-40 h-40 md:w-36 md:h-36 rounded-full bg-red-500/15 animate-pulse" />
            </>
          )}
          <button
            onMouseDown={startRecording}
            onMouseUp={stopRecording}
            onMouseLeave={() => recording && stopRecording()}
            onTouchStart={(e) => { e.preventDefault(); if (!recording) startRecording(); }}
            onTouchEnd={(e) => { e.preventDefault(); if (recording) stopRecording(); }}
            style={{ transform: `scale(${scale})`, transition: "transform 80ms ease" }}
            className={`relative w-32 h-32 md:w-24 md:h-24 rounded-full flex items-center justify-center select-none cursor-pointer ${
              recording
                ? "bg-red-500 shadow-[0_0_50px_rgba(239,68,68,0.5)]"
                : "bg-blue-600 hover:bg-blue-500 shadow-[0_0_30px_rgba(59,130,246,0.35)] active:scale-95"
            }`}
          >
            {recording ? (
              <div className="w-9 h-9 md:w-7 md:h-7 rounded-sm bg-white" />
            ) : (
              <svg className="w-12 h-12 md:w-9 md:h-9 text-white" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
              </svg>
            )}
          </button>
        </div>

        {/* Hold hint for mobile */}
        <p className="text-gray-600 text-xs mb-4 md:hidden">Hold the button and speak</p>

        {/* Status */}
        <div className="min-h-5 mb-4 text-center">
          {recording && transcribeMode === "browser" && <p className="text-red-400 text-sm animate-pulse">Listening… release to stop</p>}
          {recording && transcribeMode === "groq" && <p className="text-red-400 text-sm animate-pulse">Recording… release to transcribe</p>}
          {transcribing && <p className="text-yellow-400 text-sm animate-pulse">Transcribing with Groq Whisper…</p>}
          {cleaning && <p className="text-blue-400 text-sm animate-pulse">Enhancing with LLaMA 3…</p>}
          {error && <p className="text-red-400 text-xs px-2 text-center">{error}</p>}
        </div>

        {/* Output */}
        {(rawText || interimText) && (
          <div className="w-full max-w-2xl space-y-3">
            {/* Raw transcript */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-gray-500 font-medium uppercase tracking-wider">Transcript</span>
                {rawText && (
                  <button onClick={() => copy(rawText)} className="text-xs text-gray-600 hover:text-white transition-colors">
                    Copy
                  </button>
                )}
              </div>
              <p className="text-gray-200 leading-relaxed whitespace-pre-wrap text-sm md:text-base">
                {rawText}
                {interimText && <span className="text-gray-500">{rawText ? " " : ""}{interimText}</span>}
              </p>
            </div>

            {/* Enhance buttons */}
            {rawText && (
              <div>
                <p className="text-xs text-gray-600 mb-2 uppercase tracking-wider font-medium">Enhance with AI</p>
                <div className="flex flex-wrap gap-2">
                  {MODES.map((m) => (
                    <button
                      key={m.value}
                      onClick={() => cleanup(m.value)}
                      disabled={cleaning}
                      className={`px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                        activeMode === m.value && cleanedText
                          ? "bg-violet-600 text-white shadow-[0_0_15px_rgba(139,92,246,0.3)]"
                          : "bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white active:scale-95"
                      } disabled:opacity-40`}
                    >
                      {m.icon} {m.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Cleaned output */}
            {cleanedText && (
              <div className="bg-gray-900 border border-violet-800/40 rounded-xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-violet-400 font-medium uppercase tracking-wider">
                    AI · {MODES.find((m) => m.value === activeMode)?.label}
                  </span>
                  <button
                    onClick={() => copy(cleanedText)}
                    className={`text-xs transition-colors ${copied ? "text-green-400" : "text-gray-600 hover:text-white"}`}
                  >
                    {copied ? "Copied!" : "Copy"}
                  </button>
                </div>
                <p className="text-white leading-relaxed whitespace-pre-wrap text-sm md:text-base">{cleanedText}</p>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
