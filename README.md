# VoiceBridge 0.1

A local-first macOS voice bridge:

**microphone → in-memory PCM → local whisper.cpp → text → local AivisSpeech → synthesized WAV → Discord bot voice**

The microphone recording is never intentionally written to disk and is never sent to Discord or a cloud transcription/TTS API. Whisper is bound to `127.0.0.1:8080`; AivisSpeech is expected at `127.0.0.1:10101`. Discord receives only synthesized audio.

## What 0.1 already does

- Always-on microphone capture.
- Automatic utterance segmentation using an adaptive local energy/VAD gate.
- ~220 ms pre-roll so beginnings of words are not chopped.
- Hold **F8** globally to mute while the key is held.
- Manual mute button.
- Local Whisper transcription with `whisper.cpp`.
- Local AivisSpeech HTTP synthesis.
- Small prosody adapter: punctuation + local RMS/duration statistics adjust speed, intonation, and output volume.
- Discord bot joins a specified voice channel and streams only the generated audio.
- Discord bot token is encrypted with Electron `safeStorage` when available.
- Mic samples remain in renderer memory and are discarded after the utterance is sent to the loopback Whisper server.

## Build on an Apple-Silicon Mac

Prerequisites: macOS, Node/npm, Xcode Command Line Tools, and AivisSpeech installed.

```bash
cd voicebridge-mac
npm run setup:runtime
npm run dist:mac
```

Then open:

```text
dist/mac-arm64/VoiceBridge.app
```

The first launch should request Microphone permission. The global hold-to-mute helper may additionally trigger macOS Input Monitoring permission. If F8 does nothing, enable the app/helper under **System Settings → Privacy & Security → Input Monitoring**, then relaunch.

## AivisSpeech

Launch AivisSpeech before VoiceBridge, or use the app's **Launch AivisSpeech** button. VoiceBridge calls the local engine at `http://127.0.0.1:10101`, lists installed speaker/style IDs, calls `/audio_query`, applies conservative expression parameters, then calls `/synthesis`.

If your Discord conversation is mainly English, the TTS provider layer should eventually be swapped/tested against an English-focused local expressive engine. The rest of the application does not care which local TTS engine is behind the provider.

## Discord bot setup

Create a normal Discord bot application, invite that bot to the server with permission to View Channels, Connect, and Speak, then enable Developer Mode in Discord so you can copy the Server ID and Voice Channel ID. Paste the bot token, Server ID, and Voice Channel ID into VoiceBridge and click **Connect bot**.

Do not automate a normal user account/self-bot; VoiceBridge is designed around a proper bot account.

## Privacy model

Network destinations used by VoiceBridge itself:

- `127.0.0.1:8080`: local Whisper transcription.
- `127.0.0.1:10101`: local TTS.
- Discord's normal bot/voice infrastructure: bot login and **synthesized** audio only.

The one-time Whisper setup script uses the internet to clone `whisper.cpp` and download the model. After installation, transcription runs locally.

## Current limits

This is a working first-pass source build, but it has not been executed on macOS inside this Linux build environment. The JavaScript source is syntax-checkable here; macOS-only pieces (Swift global hotkey helper, microphone permission flow, Metal Whisper runtime, final `.app`) must be compiled/tested on the target Mac.

The next engineering pass should focus on latency tuning, false-trigger suppression, interruption/cancellation, and choosing the best expressive English/Japanese voice provider for the actual Discord usage.


## v0.1.2 capture fixes
- Explicitly resumes the Chromium AudioContext after macOS permission flow.
- Lowers the initial VAD floor for quiet Mac microphones and enables automatic gain control.
- Logs the selected mic, AudioContext state, and first PCM frame for diagnosis.
- Replaces the global CGEventTap hotkey helper with low-impact Right-Control state polling.

## v0.1.4 diagnostics

- Whisper startup now waits up to 60 seconds (v0.1.2 incorrectly gave up after ~7.5 seconds while `ggml-small` could still be loading/initializing Metal).
- Early Whisper process exits now surface their final diagnostic output instead of only saying "did not become ready".
- Global Right-Control hold-to-mute now uses macOS's listen-only modifier event path. If macOS blocks it, VoiceBridge tells you explicitly to enable **System Settings → Privacy & Security → Input Monitoring → VoiceBridge** and relaunch.
- The focused-window Right-Control fallback now checks both Chromium's `code` and right-side keyboard `location`.


## v0.1.4 fixes

- Removes the unsupported `--no-context` command-line flag from `whisper-server`. The request now sends `no_context=true` and `no_timestamps=true` as inference form fields instead.
- Trims Whisper startup to stable arguments only: host, port, and model.
- Changes global hold-to-mute from Right Control to **F8**, using hardware key-state polling. On a Mac whose top row controls media, hold **Fn+F8**.
