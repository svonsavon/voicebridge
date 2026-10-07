const { spawn } = require('node:child_process');
const path = require('node:path');
const { Readable } = require('node:stream');
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
let onStatus = () => {};

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

  ff.stderr.on('data', (d) => onStatus({ level: 'warn', text: `ffmpeg: ${d.toString().trim()}` }));
  ff.on('error', (err) => onStatus({ level: 'error', text: `ffmpeg failed: ${err.message}` }));
  Readable.from([wavBuffer]).pipe(ff.stdin);
  return ff.stdout;
}

function enqueue(wavBuffer) {
  if (!connection || !player) throw new Error('Discord is not connected.');
  queue.push(Buffer.from(wavBuffer));
  playNext();
}

function playNext() {
  if (playing || !player || queue.length === 0) return;
  const wav = queue.shift();
  const pcm = wavToDiscordPcm(wav);
  const resource = createAudioResource(pcm, { inputType: StreamType.Raw });
  playing = true;
  player.play(resource);
}

async function disconnect() {
  queue = [];
  playing = false;
  try { player?.stop(true); } catch {}
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

module.exports = { connect, disconnect, enqueue, isConnected };
