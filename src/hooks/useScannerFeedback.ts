/**
 * Scanner audio and visual feedback — specification sections 3.3, 3.4, 35.
 *
 * Tones are synthesised with the Web Audio API rather than shipping audio
 * files: they are instant (no network fetch or decode before the first scan)
 * and cannot desynchronise from rapid scanning.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

type AudioContextConstructor = typeof AudioContext;

function getAudioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === 'undefined') return null;
  const candidate =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
  return candidate ?? null;
}

export type FeedbackKind = 'success' | 'error';

export function useScannerFeedback(options: {
  soundEnabled: boolean;
  successSound: boolean;
  errorSound: boolean;
  successFlash: boolean;
  errorFlash: boolean;
}): {
  flash: FeedbackKind | null;
  signal: (kind: FeedbackKind) => void;
} {
  const contextRef = useRef<AudioContext | null>(null);
  const [flash, setFlash] = useState<FeedbackKind | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
      void contextRef.current?.close();
    },
    [],
  );

  const playTone = useCallback((kind: FeedbackKind) => {
    const Constructor = getAudioContextConstructor();
    if (Constructor === null) return;

    try {
      contextRef.current ??= new Constructor();
      const context = contextRef.current;
      // Browsers start the context suspended until a user gesture; scanning
      // always follows one, so this resolves immediately in practice.
      if (context.state === 'suspended') void context.resume();

      const oscillator = context.createOscillator();
      const gain = context.createGain();

      // Success: short, bright. Error: lower and longer, unmistakable in a
      // noisy warehouse.
      oscillator.type = kind === 'success' ? 'sine' : 'square';
      oscillator.frequency.value = kind === 'success' ? 1180 : 240;

      const duration = kind === 'success' ? 0.07 : 0.22;
      const now = context.currentTime;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(kind === 'success' ? 0.18 : 0.3, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

      oscillator.connect(gain).connect(context.destination);
      oscillator.start(now);
      oscillator.stop(now + duration + 0.02);
    } catch {
      // Audio is a convenience; never let it break counting.
    }
  }, []);

  const signal = useCallback(
    (kind: FeedbackKind) => {
      const soundWanted =
        options.soundEnabled && (kind === 'success' ? options.successSound : options.errorSound);
      if (soundWanted) playTone(kind);

      const flashWanted = kind === 'success' ? options.successFlash : options.errorFlash;
      if (flashWanted) {
        if (flashTimer.current !== null) clearTimeout(flashTimer.current);
        setFlash(kind);
        // Section 35: brief; must not slow down rapid scanning.
        flashTimer.current = setTimeout(() => setFlash(null), kind === 'success' ? 400 : 600);
      }
    },
    [options, playTone],
  );

  return { flash, signal };
}
