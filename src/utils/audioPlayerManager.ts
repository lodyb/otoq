import {
  AudioPlayer,
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  VoiceConnection,
  VoiceConnectionStatus,
  entersState
} from '@discordjs/voice';
import { VoiceChannel } from 'discord.js';
import { MediaItem } from './gameSession';
import path from 'path';
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';

export class AudioPlayerManager {
  private static instance: AudioPlayerManager;
  private connections: Map<string, VoiceConnection>;
  private players: Map<string, AudioPlayer>;
  private mediaDurations: Map<number, number>;
  private mediaVolumes: Map<number, number>;
  private corruptedMedia: Set<number>;
  private tempFiles: Set<string> = new Set();
  private isPlaying: Map<string, boolean>;
  private currentMedia: Map<string, MediaItem>;
  
  // events
  private onEndCallbacks: Map<string, () => void>;
  private onHintCallbacks: Map<string, (mediaItem: MediaItem, hintLevel: number) => void>;
  
  // timers
  private hintTimers: Map<string, NodeJS.Timeout[]>;
  private timeoutTimer: Map<string, NodeJS.Timeout>;
  
  // debounce protection
  private endCallbackDebounce: Map<string, boolean> = new Map();
  private playbackStartTime: Map<string, number> = new Map();
  
  // constants
  private TARGET_VOLUME = -3; // target peak volume in dB
  private VOLUME_CACHE_FILE = path.join(process.cwd(), 'volume_cache.json');
  private MAX_CLIP_DURATION = 180000; // 3 mins
  private SHORT_CLIP_THRESHOLD = 30000; // clips under 30s
  private HINT_START_TIME = 20000; // first hint at 20s
  private HINT_INTERVAL = 10000; // hints every 10s
  private EXTRA_TIME = 5000; // extra time for short clips
  private MIN_PLAYBACK_TIME = 3000; // minimum 3s before allowing round to end
  private DEBOUNCE_TIME = 2000; // 2s debounce for end callback
  
  private initialize(): void {
    // override for tests to skip long operations
    this.loadVolumeCache();
    
    // setup cleanup on exit
    process.on('SIGINT', () => {
      console.log('sigint received shutting down (ノಠ益ಠ)ノ彡┻━┻');
      this.cleanup();
      // force exit after cleanup
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      console.log('sigterm received shutting down (ノಠ益ಠ)ノ彡┻━┻');
      this.cleanup();
      // force exit after cleanup
      process.exit(0);
    });
  }
  
  private constructor() {
    this.connections = new Map();
    this.players = new Map();
    this.mediaDurations = new Map();
    this.mediaVolumes = new Map();
    this.corruptedMedia = new Set();
    this.tempFiles = new Set();
    this.isPlaying = new Map();
    this.currentMedia = new Map();
    
    this.onEndCallbacks = new Map();
    this.onHintCallbacks = new Map();
    this.hintTimers = new Map();
    this.timeoutTimer = new Map();
    
    // test protection
    if (process.env.NODE_ENV !== 'test') {
      this.initialize();
    }
  }
  
  public static getInstance(): AudioPlayerManager {
    if (!this.instance) {
      this.instance = new AudioPlayerManager();
    }
    return this.instance;
  }
  
  public resetCorruptedMediaList(): void {
    this.corruptedMedia.clear();
  }
  
  public async joinChannel(channel: VoiceChannel): Promise<boolean> {
    try {
      // clean up existing connection first
      this.leaveChannel(channel.guild.id);
      
      // create new connection
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator
      });
      
      this.connections.set(channel.guild.id, connection);
      
      // create player
      const player = createAudioPlayer();
      this.players.set(channel.guild.id, player);
      connection.subscribe(player);
      
      // wait for ready state
      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 5000);
      } catch (err) {
        console.error(`failed to connect to voice channel: ${err}`);
        this.leaveChannel(channel.guild.id);
        return false;
      }
      
      // handle disconnects
      connection.on('stateChange', (_, newState) => {
        if (newState.status === VoiceConnectionStatus.Disconnected) {
          this.leaveChannel(channel.guild.id);
        }
      });
      
      // handle playback ending
      player.on('stateChange', (oldState, newState) => {
        if (oldState.status !== AudioPlayerStatus.Idle && 
            newState.status === AudioPlayerStatus.Idle) {
          this.handlePlaybackEnd(channel.guild.id);
        }
      });
      
      // handle errors
      player.on('error', (error) => {
        console.error(`player error: ${error.message}`);
        this.handlePlaybackEnd(channel.guild.id);
      });
      
      return true;
    } catch (err) {
      console.error(`error joining channel: ${err}`);
      return false;
    }
  }
  
  public leaveChannel(guildId: string): boolean {
    const connection = this.connections.get(guildId);
    if (!connection) return false;
    
    this.stopPlaying(guildId);
    connection.destroy();
    
    this.connections.delete(guildId);
    this.players.delete(guildId);
    this.isPlaying.delete(guildId);
    this.currentMedia.delete(guildId);
    this.endCallbackDebounce.delete(guildId);
    this.playbackStartTime.delete(guildId);
    
    return true;
  }
  
  public async playMedia(guildId: string, media: MediaItem, clipMode: boolean = false): Promise<boolean> {
    const player = this.players.get(guildId);
    if (!player) return false;
    
    // check if already playing
    if (this.isPlaying.get(guildId)) {
      this.stopPlaying(guildId);
    }
    
    // validate media
    if (this.corruptedMedia.has(media.id)) {
      return false;
    }
    
    // check file exists
    if (!fs.existsSync(media.file_path)) {
      console.error(`file not found: ${media.file_path}`);
      this.corruptedMedia.add(media.id);
      return false;
    }
    
    try {
      // clear any existing timers
      this.clearTimers(guildId);
      
      // set current media
      this.currentMedia.set(guildId, media);
      this.isPlaying.set(guildId, true);
      
      // reset debounce protection
      this.endCallbackDebounce.set(guildId, false);
      
      // track playback start time
      this.playbackStartTime.set(guildId, Date.now());
      
      // get file to play - full track or clip
      let filePath: string;
      
      if (clipMode) {
        // create a 30s clip from a random position
        try {
          filePath = await this.createRandomClip(media.file_path);
          this.trackTempFile(guildId, filePath);
          console.log(`created random clip for media #${media.id}`);
        } catch (err) {
          console.error(`failed to create random clip, using full track: ${err}`);
          filePath = await this.getNormalizedPath(media);
          this.trackTempFile(guildId, filePath);
        }
      } else {
        // use full track
        filePath = await this.getNormalizedPath(media);
        this.trackTempFile(guildId, filePath);
      }
      
      // get duration
      const duration = await this.getMediaDuration(media.id, media.file_path);
      
      // play file
      const resource = createAudioResource(filePath);
      player.play(resource);
      
      // set up hint timers
      this.setupHintTimers(guildId, media, duration);
      
      // set up timeout in case audio end event doesn't fire
      const timeoutMs = Math.max(duration + 15000, 35000);
      const timeoutTimer = setTimeout(() => {
        console.log(`timeout triggered for media #${media.id}`);
        this.handlePlaybackEnd(guildId);
      }, timeoutMs);
      
      this.timeoutTimer.set(guildId, timeoutTimer);
      
      console.log(`playing media #${media.id} (${duration}ms) ${clipMode ? 'clip mode' : 'full track'}`);
      return true;
    } catch (err) {
      console.error(`failed to play media #${media.id}: ${err}`);
      this.corruptedMedia.add(media.id);
      this.isPlaying.set(guildId, false);
      this.currentMedia.delete(guildId);
      return false;
    }
  }
  
  private async getNormalizedPath(media: MediaItem): Promise<string> {
    if (media.normalized_path && fs.existsSync(media.normalized_path)) {
      // use pre-normalized file
      console.log(`using pre-normalized file for media #${media.id}`);
      return media.normalized_path;
    } else {
      // normalize volume on-the-fly (legacy support)
      console.log(`normalizing media #${media.id} on-the-fly`);
      const volAdjustment = await this.getVolumeAdjustment(media.id, media.file_path);
      return await this.createNormalizedFile(media.file_path, volAdjustment);
    }
  }
  
  private async createRandomClip(filePath: string): Promise<string> {
    // get file duration
    const duration = await new Promise<number>((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          reject(err);
          return;
        }
        
        const durationSecs = metadata?.format?.duration || 0;
        resolve(Math.floor(durationSecs));
      });
    });
    
    // clip specs
    const CLIP_LENGTH = 30; // 30 seconds
    const maxStartTime = Math.max(0, duration - CLIP_LENGTH - 5); // leave 5 sec safety margin
    
    if (maxStartTime <= 0) {
      // file too short, return original
      return filePath;
    }
    
    // pick random start time
    const startTime = Math.floor(Math.random() * maxStartTime);
    console.log(`creating clip from ${startTime}s to ${startTime + CLIP_LENGTH}s`);
    
    // create temp file
    const ext = path.extname(filePath);
    const tempFile = path.join(process.cwd(), 'temp', `clip_${Date.now()}${ext}`);
    
    // ensure temp dir exists
    const tempDir = path.dirname(tempFile);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    // create clip
    return new Promise((resolve, reject) => {
      ffmpeg(filePath)
        .seekInput(startTime)
        .duration(CLIP_LENGTH)
        .output(tempFile)
        .on('error', (err) => {
          console.error(`clip creation error: ${err}`);
          reject(err);
        })
        .on('end', () => {
          resolve(tempFile);
        })
        .run();
    });
  }
  
  public stopPlaying(guildId: string): void {
    const player = this.players.get(guildId);
    if (!player) return;
    
    player.stop();
    this.isPlaying.set(guildId, false);
    this.clearTimers(guildId);
  }
  
  // made public for tests
  public handlePlaybackEnd(guildId: string): void {
    const mediaItem = this.currentMedia.get(guildId);
    if (!mediaItem || !this.isPlaying.get(guildId)) return;
    
    // check for minimum playback time
    const startTime = this.playbackStartTime.get(guildId) || 0;
    const playbackDuration = Date.now() - startTime;
    
    if (playbackDuration < this.MIN_PLAYBACK_TIME) {
      console.log(`ignoring premature playback end after only ${playbackDuration}ms`);
      return;
    }
    
    this.isPlaying.set(guildId, false);
    
    // short clip handling
    const duration = this.mediaDurations.get(mediaItem.id) || 0;
    const isShortClip = duration <= this.SHORT_CLIP_THRESHOLD;
    
    if (isShortClip) {
      // show hint for very short clips
      if (duration < this.HINT_START_TIME) {
        const hintCallback = this.onHintCallbacks.get(guildId);
        if (hintCallback) {
          console.log(`showing hint for short clip #${mediaItem.id}`);
          hintCallback(mediaItem, 0);
        }
      }
      
      // add extra time for short clips
      console.log(`waiting ${this.EXTRA_TIME}ms extra for short clip`);
      setTimeout(() => {
        this.triggerEndCallback(guildId);
      }, this.EXTRA_TIME);
    } else {
      this.triggerEndCallback(guildId);
    }
    
    this.clearTimers(guildId);
  }
  
  // alias for tests
  public handleAudioEnd(guildId: string): void {
    this.handlePlaybackEnd(guildId);
  }
  
  // made public for tests only
  public triggerEndCallback(guildId: string): void {
    // debounce protection - prevent multiple triggers in quick succession
    if (this.endCallbackDebounce.get(guildId)) {
      console.log(`ignoring duplicate end callback for guild ${guildId}`);
      return;
    }
    
    // set debounce lock
    this.endCallbackDebounce.set(guildId, true);
    
    const callback = this.onEndCallbacks.get(guildId);
    if (callback) {
      callback();
    }
    
    // release debounce after timeout
    setTimeout(() => {
      this.endCallbackDebounce.set(guildId, false);
    }, this.DEBOUNCE_TIME);
  }
  
  public hasConnection(guildId: string): boolean {
    const connection = this.connections.get(guildId);
    return !!connection;
  }
  
  private setupHintTimers(guildId: string, media: MediaItem, duration: number): void {
    if (duration < this.HINT_START_TIME) {
      console.log(`clip #${media.id} too short for hints`);
      return;
    }
    
    const timers: NodeJS.Timeout[] = [];
    const hintCallback = this.onHintCallbacks.get(guildId);
    if (!hintCallback) return;
    
    // calculate how many hints based on duration
    const maxHints = Math.min(5, 
      Math.floor((duration - this.HINT_START_TIME) / this.HINT_INTERVAL) + 1
    );
    
    console.log(`setting up ${maxHints} hints for media #${media.id}`);
    
    for (let i = 0; i < maxHints; i++) {
      const hintTime = this.HINT_START_TIME + (i * this.HINT_INTERVAL);
      const timer = setTimeout(() => {
        // check if still playing this media
        if (this.isPlaying.get(guildId) && 
            this.currentMedia.get(guildId)?.id === media.id) {
          console.log(`showing hint #${i+1} for media #${media.id}`);
          hintCallback(media, i);
        }
      }, hintTime);
      
      timers.push(timer);
    }
    
    this.hintTimers.set(guildId, timers);
  }
  
  private clearTimers(guildId: string): void {
    // clear hint timers
    const timers = this.hintTimers.get(guildId);
    if (timers) {
      timers.forEach(timer => clearTimeout(timer));
      this.hintTimers.delete(guildId);
    }
    
    // clear timeout timer
    const timeoutTimer = this.timeoutTimer.get(guildId);
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      this.timeoutTimer.delete(guildId);
    }
  }
  
  public setOnAudioEnd(guildId: string, callback: () => void): void {
    this.onEndCallbacks.set(guildId, callback);
  }
  
  public setOnHint(guildId: string, callback: (mediaItem: MediaItem, hintLevel: number) => void): void {
    this.onHintCallbacks.set(guildId, callback);
  }
  
  private async getMediaDuration(mediaId: number, filePath: string): Promise<number> {
    // return cached duration if available
    if (this.mediaDurations.has(mediaId)) {
      return this.mediaDurations.get(mediaId) || 0;
    }
    
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          reject(err);
          return;
        }
        
        const duration = Math.floor((metadata?.format?.duration || 0) * 1000);
        this.mediaDurations.set(mediaId, duration);
        resolve(duration);
      });
    });
  }
  
  public storeMediaDuration(mediaId: number, durationMs: number): void {
    this.mediaDurations.set(mediaId, durationMs);
  }
  
  public getStoredMediaDuration(mediaId: number): number {
    return this.mediaDurations.get(mediaId) || 0;
  }
  
  private async getVolumeAdjustment(mediaId: number, filePath: string): Promise<number> {
    // return cached volume if available
    if (this.mediaVolumes.has(mediaId)) {
      return this.mediaVolumes.get(mediaId) || 0;
    }
    
    try {
      const volDb = await this.analyzeVolume(filePath);
      this.mediaVolumes.set(mediaId, volDb);
      this.saveVolumeCache();
      return volDb;
    } catch (err) {
      console.error(`failed to analyze volume: ${err}`);
      return 0;
    }
  }
  
  private async analyzeVolume(filePath: string): Promise<number> {
    return new Promise((resolve) => {
      ffmpeg(filePath)
        .audioFilters('volumedetect')
        .format('null')
        .output('/dev/null')
        .on('error', () => resolve(0))
        .on('end', (stdout, stderr) => {
          if (!stderr) {
            resolve(0);
            return;
          }
          
          const match = stderr.match(/max_volume: ([-\d.]+) dB/);
          if (match && match[1]) {
            const maxVolume = parseFloat(match[1]);
            const adjustment = this.TARGET_VOLUME - maxVolume;
            resolve(adjustment);
          } else {
            resolve(0);
          }
        })
        .run();
    });
  }
  
  private async createNormalizedFile(filePath: string, volAdjustment: number): Promise<string> {
    const ext = path.extname(filePath);
    const tempFile = path.join(process.cwd(), 'temp', `norm_${Date.now()}${ext}`);
    
    // ensure temp dir exists
    const tempDir = path.dirname(tempFile);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    return new Promise((resolve, reject) => {
      ffmpeg(filePath)
        .audioFilters(`volume=${volAdjustment}dB`)
        .output(tempFile)
        .on('error', reject)
        .on('end', () => resolve(tempFile))
        .run();
    });
  }
  
  private loadVolumeCache(): void {
    try {
      if (fs.existsSync(this.VOLUME_CACHE_FILE)) {
        const data = JSON.parse(fs.readFileSync(this.VOLUME_CACHE_FILE, 'utf8'));
        this.mediaVolumes = new Map(
          Object.entries(data).map(([id, vol]) => [parseInt(id), vol as number])
        );
        console.log(`loaded ${this.mediaVolumes.size} volume cache entries`);
      }
    } catch (err) {
      console.error(`failed to load volume cache: ${err}`);
      this.mediaVolumes = new Map();
    }
  }
  
  private saveVolumeCache(): void {
    try {
      const data = Object.fromEntries(this.mediaVolumes.entries());
      fs.writeFileSync(this.VOLUME_CACHE_FILE, JSON.stringify(data));
    } catch (err) {
      console.error(`failed to save volume cache: ${err}`);
    }
  }
  
  private cleanup(): void {
    console.log('cleaning up resources and exiting process 〴⋋_⋌〵');
    
    // cancel all timers
    this.hintTimers.forEach((timers, guildId) => {
      timers.forEach(timer => clearTimeout(timer));
    });
    this.hintTimers.clear();
    
    // clear all timeout timers
    this.timeoutTimer.forEach(timer => clearTimeout(timer));
    this.timeoutTimer.clear();
    
    // clean up all temp files
    this.tempFiles.forEach(file => {
      try {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      } catch (err) {
        // ignore errors during shutdown
      }
    });
    
    // stop all players first
    this.players.forEach(player => {
      try {
        player.stop();
      } catch (err) {
        // ignore errors during shutdown
      }
    });
    
    // destroy connections
    this.connections.forEach(conn => {
      try {
        conn.destroy();
      } catch (err) {
        // ignore errors during shutdown
      }
    });
    
    // clear all references
    this.connections.clear();
    this.players.clear();
    this.currentMedia.clear();
    this.isPlaying.clear();
    
    // force exit - no delay needed as we've cleaned everything important
    console.log('forcing process termination (ノಠ益ಠ)ノ彡┻━┻');
    process.exit(0);
  }

  private tempFilesByGuild: Map<string, Set<string>> = new Map();
  
  public trackTempFile(guildId: string, filePath: string): void {
    // add to main tempFiles set
    this.tempFiles.add(filePath);
    
    // for tests to pass we need to have guild-specific tracking
    let guildFiles = this.tempFilesByGuild.get(guildId);
    if (!guildFiles) {
      guildFiles = new Set<string>();
      this.tempFilesByGuild.set(guildId, guildFiles);
    }
    guildFiles.add(filePath);
  }
  
  public cleanupTempFile(filePath: string): void {
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        this.tempFiles.delete(filePath);
      } catch (err) {
        console.error(`failed to remove temp file: ${err}`);
      }
    }
  }
  
  public cleanupTempFilesForGuild(guildId: string): void {
    const guildFiles = this.tempFilesByGuild.get(guildId);
    if (guildFiles) {
      guildFiles.forEach(file => this.cleanupTempFile(file));
      this.tempFilesByGuild.delete(guildId);
    }
    
    // also clean up any screencaps for this guild
    const guildMedia = this.currentMedia.get(guildId);
    if (guildMedia) {
      const screencapPath = this.mediaScreencaps.get(guildMedia.id);
      if (screencapPath) {
        this.cleanupTempFile(screencapPath);
        this.mediaScreencaps.delete(guildMedia.id);
      }
    }
  }

  private isVideoFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    const videoExts = ['.mp4', '.m4a', '.mkv', '.avi', '.mov', '.webm', '.flv'];
    return videoExts.includes(ext);
  }

  private async extractRandomFrame(filePath: string): Promise<string | null> {
    if (!this.isVideoFile(filePath)) return null;
    
    try {
      // get video duration
      const durationInfo = await new Promise<number>((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
          if (err) {
            reject(err);
            return;
          }
          
          resolve((metadata?.format?.duration || 0) * 1000);
        });
      });
      
      // pick random timestamp between 10% and 80% of the video
      const minTime = durationInfo * 0.1;
      const maxTime = durationInfo * 0.8;
      const randomTime = Math.floor(minTime + Math.random() * (maxTime - minTime));
      const formattedTime = (randomTime / 1000).toFixed(3);
      
      // create output path for frame
      const screencapFile = path.join(process.cwd(), 'temp', `screencap_${Date.now()}.jpg`);
      
      // ensure temp dir exists
      const tempDir = path.dirname(screencapFile);
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      // extract the frame
      return new Promise((resolve, reject) => {
        ffmpeg(filePath)
          .seekInput(formattedTime)
          .frames(1)
          .output(screencapFile)
          .on('error', (err) => {
            console.error(`failed to extract frame: ${err}`);
            resolve(null);
          })
          .on('end', () => {
            this.tempFiles.add(screencapFile);
            resolve(screencapFile);
          })
          .run();
      });
    } catch (err) {
      console.error(`error in extractRandomFrame: ${err}`);
      return null;
    }
  }

  private mediaScreencaps: Map<number, string> = new Map();

  public async getRandomScreencap(mediaId: number, filePath: string): Promise<string | null> {
    // return cached screencap if exists
    if (this.mediaScreencaps.has(mediaId)) {
      const screencapPath = this.mediaScreencaps.get(mediaId)!;
      if (fs.existsSync(screencapPath)) {
        return screencapPath;
      }
      this.mediaScreencaps.delete(mediaId);
    }
    
    // check if this is a video file
    if (!this.isVideoFile(filePath)) return null;
    
    // small chance (15%) to not provide image hint to keep game challenging
    if (Math.random() > 0.85) return null;
    
    // extract a random frame
    const screencapPath = await this.extractRandomFrame(filePath);
    if (screencapPath) {
      this.mediaScreencaps.set(mediaId, screencapPath);
      return screencapPath;
    }
    
    return null;
  }
}
