const { spawn } = require('node:child_process');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const {
  Client,
  GatewayIntentBits,
  ChannelType
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  entersState,
  VoiceConnectionStatus
} = require('@discordjs/voice');

let client = null;
let connection = null;
let player = null;
let queue = [];
let playing = false;
let currentFfmpeg = null;
let currentSource = null;
let onStatus = () => {};

function inspectWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) {
    throw new Error('Refusing invalid synthesized audio: WAV is too small.');
  }
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Refusing invalid synthesized audio: not a RIFF/WAVE file.');
  }

  let offset = 12;
  let fmt = null;
  let dataSize = null;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (dataStart + size > buffer.length) break;

    if (id === 'fmt ' && size >= 16) {
      fmt = {
        channels: buffer.readUInt16LE(dataStart + 2),
        sampleRate: buffer.readUInt32LE(dataStart + 4),
        bitsPerSample: buffer.readUInt16LE(dataStart + 14)
      };
    } else if (id === 'data') {
      dataSize = size;
    }

    offset = dataStart + size + (size % 2);
  }

  if (!fmt || dataSize == null || !fmt.channels || !fmt.sampleRate || !fmt.bitsPerSample) {
    throw new Error('Refusing invalid synthesized audio: malformed WAV header.');
  }

  const bytesPerSecond = fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
  const durationSeconds = dataSize / bytesPerSecond;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('Refusing invalid synthesized audio: impossible duration.');
  }

  return { ...fmt, dataSize, durationSeconds };
}

function ffmpegPath() {
  let p = require('ffmpeg-static');
  if (p && p.includes('app.asar')) p = p.replace('app.asar', 'app.asar.unpacked');
  return p;
}

async function connect({ token, guildId, channelId }, statusCallback = () => {}) {
  onStatus = statusCallback;
  if (!token || !guildId || !channelId) throw new Error('Discord bot token, server ID, and voice channel ID are required.');
  await disconnect();

  client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  client.on('error', (err) => onStatus({ level: 'error', text: `Discord: ${err.message}` }));
  await client.login(token);

  const guild = await client.guilds.fetch(guildId);
  const channel = await guild.channels.fetch(channelId);
  if (!channel || !channel.isVoiceBased()) throw new Error('The configured channel is not a Discord voice/stage channel.');
  if (![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type)) throw new Error('Unsupported Discord channel type.');

  connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false
  });
  await entersState(connection, VoiceConnectionStatus.Ready, 15_000);

  player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
  });
  player.on('error', (err) => {
    playing = false;
    onStatus({ level: 'error', text: `Discord audio: ${err.message}` });
    playNext();
  });
  player.on(AudioPlayerStatus.Idle, () => {
    playing = false;
    playNext();
  });
  connection.subscribe(player);
  onStatus({ level: 'ok', text: `Discord connected: ${guild.name} / ${channel.name}` });
  return { guildName: guild.name, channelName: channel.name };
}

function wavToDiscordPcm(wavBuffer) {
  const ff = spawn(ffmpegPath(), [
    '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1'
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  currentFfmpeg = ff;
  ff.stderr.on('data', (d) => onStatus({ level: 'warn', text: `ffmpeg: ${d.toString().trim()}` }));
  ff.on('error', (err) => onStatus({ level: 'error', text: `ffmpeg failed: ${err.message}` }));
  ff.on('close', () => {
    if (currentFfmpeg === ff) currentFfmpeg = null;
  });
  Readable.from([wavBuffer]).pipe(ff.stdin);
  return ff.stdout;
}

function rawPcmToDiscordPcm(source, { sampleRate = 24000, channels = 1 } = {}) {
  const ff = spawn(ffmpegPath(), [
    '-hide_banner', '-loglevel', 'error',
    '-f', 's16le',
    '-ar', String(sampleRate),
    '-ac', String(channels),
    '-i', 'pipe:0',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1'
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  currentFfmpeg = ff;
  currentSource = source;

  const maxInputBytes = Math.ceil(sampleRate * channels * 2 * 35);
  let inputBytes = 0;
  const guard = new Transform({
    transform(chunk, _encoding, callback) {
      inputBytes += chunk.length;
      if (inputBytes > maxInputBytes) {
        callback(new Error('Blocked runaway streaming audio longer than 35 seconds.'));
        return;
      }
      callback(null, chunk);
    }
  });

  const stopOnError = (err) => {
    onStatus({ level: 'error', text: `Streaming audio stopped: ${err.message}` });
    try { source.destroy?.(); } catch {}
    try { ff.kill('SIGKILL'); } catch {}
  };

  source.on('error', stopOnError);
  guard.on('error', stopOnError);
  ff.stdin.on('error', (err) => {
    if (err?.code !== 'EPIPE') stopOnError(err);
  });
  ff.stderr.on('data', (d) => {
    const text = d.toString().trim();
    if (text) onStatus({ level: 'warn', text: `ffmpeg: ${text}` });
  });
  ff.on('error', (err) => onStatus({ level: 'error', text: `ffmpeg failed: ${err.message}` }));
  ff.on('close', () => {
    if (currentFfmpeg === ff) currentFfmpeg = null;
    if (currentSource === source) currentSource = null;
  });

  source.pipe(guard).pipe(ff.stdin);
  return ff.stdout;
}

function enqueue(wavBuffer) {
  if (!connection || !player) throw new Error('Discord is not connected.');

  const wav = Buffer.from(wavBuffer);
  if (wav.length > 12 * 1024 * 1024) {
    throw new Error('Blocked synthesized audio larger than 12 MB.');
  }

  const info = inspectWav(wav);
  if (info.durationSeconds > 35) {
    throw new Error(
      'Blocked runaway synthesized audio (' +
      info.durationSeconds.toFixed(1) +
      ' seconds).'
    );
  }

  if (queue.length >= 2) {
    queue.splice(0, queue.length - 1);
    onStatus({ level: 'warn', text: 'Dropped stale queued speech.' });
  }
  queue.push({ type: 'wav', wav });
  playNext();
}

function enqueuePcmStream(stream, { sampleRate = 24000, channels = 1 } = {}) {
  if (!connection || !player) throw new Error('Discord is not connected.');
  if (!stream || typeof stream.pipe !== 'function') {
    throw new Error('Streaming TTS did not provide a readable PCM stream.');
  }

  if (queue.length >= 2) {
    const stale = queue.splice(0, queue.length - 1);
    for (const item of stale) {
      try { item?.stream?.destroy?.(); } catch {}
    }
    onStatus({ level: 'warn', text: 'Dropped stale queued speech.' });
  }

  queue.push({
    type: 'pcm-stream',
    stream,
    sampleRate,
    channels
  });
  playNext();
}

function playNext() {
  if (playing || !player || queue.length === 0) return;

  const item = queue.shift();
  let pcm;

  if (item?.type === 'pcm-stream') {
    pcm = rawPcmToDiscordPcm(item.stream, {
      sampleRate: item.sampleRate,
      channels: item.channels
    });
  } else {
    pcm = wavToDiscordPcm(item.wav);
  }

  const resource = createAudioResource(pcm, { inputType: StreamType.Raw });
  playing = true;
  player.play(resource);
}

function interrupt() {
  const hadAudio = playing || queue.length > 0 || !!currentFfmpeg || !!currentSource;
  queue = [];
  playing = false;

  try { currentSource?.destroy?.(); } catch {}
  currentSource = null;

  try { currentFfmpeg?.kill('SIGKILL'); } catch {}
  currentFfmpeg = null;

  try { player?.stop(true); } catch {}

  return hadAudio;
}

async function disconnect() {
  interrupt();
  try { connection?.destroy(); } catch {}
  connection = null;
  player = null;
  if (client) {
    try { client.destroy(); } catch {}
  }
  client = null;
}

function isConnected() {
  return !!connection && connection.state?.status === VoiceConnectionStatus.Ready;
}

function hasActiveAudio() {
  return playing || queue.length > 0 || !!currentFfmpeg || !!currentSource;
}

module.exports = {
  connect,
  disconnect,
  interrupt,
  enqueue,
  enqueuePcmStream,
  isConnected,
  hasActiveAudio
};
