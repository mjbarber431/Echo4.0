#!/usr/bin/env python3
"""Makes the sounds hands-free mode plays, into EchoMobile/Resources/Cues.

    python3 ios/scripts/generate-cues.py            # chimes, and any voice clips not made yet
    python3 ios/scripts/generate-cues.py --force    # remake the voice clips too

Chimes are synthesised here, so they need nothing. Voice clips come from ElevenLabs
and need ELEVENLABS_API_KEY in the repo's .env, and ffmpeg.

This runs on a developer's Mac, never in the app: Echo ships the finished audio
files and makes no network calls to play them. The key must never go in the app.
"""
import json
import math
import os
import struct
import subprocess
import sys
import tempfile
import urllib.request
import wave

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "ios", "EchoMobile", "Resources", "Cues")
RATE = 44_100

VOICES = {"sarah": "EXAVITQu4vr4xnSDxMaL", "eric": "cjVigY5qzO86Huf0OWal"}
MODEL = "eleven_multilingual_v2"
WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
         "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"]

# Short and free of the word "Echo" where possible: on a speaker the mic hears these.
PHRASES = {
    "ready": "Hands-free is on. Note one.",
    "new-note": "New note.",
    "paused": "Paused.",
    "resumed": "Recording.",
    "discarded": "Note discarded.",
    "restored": "Note restored.",
    "undone": "Undone.",
    "saved": "All done. Your notes are saved.",
    "nothing-saved": "All done. Nothing to save.",
    "nothing-to-undo": "Nothing to undo.",
    "mic-changed": "The microphone changed. Paused.",
    "commands-stopped": "Voice commands stopped. Still recording.",
    "problem": "Recording stopped. Open Echo.",
    "help": "Say Echo, then new note, pause, resume, discard, undo, status, or finish.",
}
PHRASES.update({f"note-{i + 1}": f"Note {w}." for i, w in enumerate(WORDS)})

# Each chime: (seconds from the start, frequency, loudness). A soft bell: a sine with a little
# octave and a fast decay. Rising means "going on", falling means "stopping".
C5, D5, E5, G5, A5, C6, E6, G4, C4 = 523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1318.5, 392.0, 261.63
CHIMES = {
    "ready": [(0, C5, 1), (0.13, E5, 1), (0.26, G5, 1)],
    "note": [(0, G5, 1), (0.14, C6, 1)],
    "paused": [(0, G5, 1), (0.16, C5, 0.9)],
    "resumed": [(0, C5, 0.9), (0.16, G5, 1)],
    "discarded": [(0, E5, 0.9), (0.12, C5, 0.9), (0.24, G4, 0.9)],
    "undone": [(0, C6, 0.9), (0.12, G5, 0.9)],
    "saved": [(0, C5, 1), (0.14, G5, 1), (0.28, C6, 1), (0.28, E6, 0.5)],
    "problem": [(0, C4, 1), (0.22, C4, 1)],
}
for n in range(1, 6):  # status: one pip per note
    CHIMES[f"count-{n}"] = [(i * 0.17, A5, 0.8) for i in range(n)]


def chime(notes):
    length = int((max(t for t, _, _ in notes) + 0.75) * RATE)
    out = [0.0] * length
    for start, freq, level in notes:
        first = int(start * RATE)
        for i in range(length - first):
            t = i / RATE
            attack = min(1, t / 0.004)
            bell = math.sin(2 * math.pi * freq * t) + 0.28 * math.sin(4 * math.pi * freq * t) * math.exp(-t * 14)
            out[first + i] += level * attack * math.exp(-t * 7.5) * bell
    peak = max(abs(s) for s in out)
    return [s / peak * 0.5 for s in out]  # -6 dB: a nudge in the ear, not an alarm


def make_chimes():
    for name, notes in CHIMES.items():
        with wave.open(os.path.join(OUT, f"chime-{name}.wav"), "wb") as f:
            f.setnchannels(1)
            f.setsampwidth(2)
            f.setframerate(RATE)
            f.writeframes(b"".join(struct.pack("<h", int(s * 32767)) for s in chime(notes)))


def api_key():
    for line in open(os.path.join(ROOT, ".env")):
        if line.startswith("ELEVENLABS_API_KEY"):
            return line.split("=", 1)[1].strip().strip("\"'")
    sys.exit("ELEVENLABS_API_KEY isn't in .env")


def speak(key, voice, text, path):
    body = {"text": text, "model_id": MODEL, "seed": 7, "voice_settings": {"stability": 0.55, "similarity_boost": 0.75}}
    request = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{VOICES[voice]}?output_format=mp3_44100_128",
        data=json.dumps(body).encode(),
        headers={"xi-api-key": key, "Content-Type": "application/json"},
    )
    with tempfile.TemporaryDirectory() as tmp:
        mp3 = os.path.join(tmp, "clip.mp3")
        wav = os.path.join(tmp, "clip.wav")
        with urllib.request.urlopen(request, timeout=90) as response, open(mp3, "wb") as f:
            f.write(response.read())
        # Trim the silence at both ends, so the confirmation comes straight away.
        trim = "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", mp3, "-af", trim, "-ar", "44100", "-ac", "1", wav], check=True)
        subprocess.run(["afconvert", "-f", "m4af", "-d", "aac", "-b", "64000", wav, path], check=True)


def main():
    os.makedirs(OUT, exist_ok=True)
    make_chimes()
    print(f"{len(CHIMES)} chimes")
    key = api_key()
    made = 0
    for voice in VOICES:
        for name, text in PHRASES.items():
            path = os.path.join(OUT, f"voice-{voice}-{name}.m4a")
            if os.path.exists(path) and "--force" not in sys.argv:
                continue
            speak(key, voice, text, path)
            made += 1
    print(f"{made} voice clips made")


if __name__ == "__main__":
    main()
