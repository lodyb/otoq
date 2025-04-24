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
import { VoiceChannel, User, DMChannel } from 'discord.js';
import { MediaItem } from './gameSession';
import { MediaProcessor } from './mediaProcessor';
import { EffectsManager } from './effectsManager';
import path from 'path';
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import { exec } from 'child_process';
import { promisify } from 'util';

const execPromise = promisify(exec);

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
      console.log(`already playing something for guild ${guildId}, stopping first`)
      this.stopPlaying(guildId);
      
      // add small delay to ensure clean state
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // check file exists
    if (!fs.existsSync(media.file_path)) {
      console.error(`file not found: ${media.file_path}`);
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
      
      // get normalized file path - prefer pre-normalized if available
      const filePath = await this.getNormalizedPath(media);
      this.trackTempFile(guildId, filePath);
      
      // create clip if clipMode is true
      let finalPath = filePath;
      if (clipMode) {
        try {
          console.log(`creating random 10-sec clip for media #${media.id}`);
          finalPath = await this.createRandomClip(filePath);
          this.trackTempFile(guildId, finalPath);
        } catch (err) {
          console.error(`failed to create clip: ${err}, using full file`);
        }
      }
      
      const resource = createAudioResource(finalPath);
      player.play(resource);
      
      // get duration for hint system - for full file, not clip
      const duration = await this.getMediaDuration(media.id, media.file_path);
      
      // set up hint timers
      this.setupHintTimers(guildId, media, duration);
      
      // set up timeout - shorter for clips
      const timeoutMs = clipMode 
        ? Math.max(30000, 15000) // for clips: at least 15s, normally 30s
        : Math.max(duration + 15000, 35000); // for full files
      
      const timeoutTimer = setTimeout(() => {
        console.log(`timeout triggered for media #${media.id}`);
        this.handlePlaybackEnd(guildId);
      }, timeoutMs);
      
      this.timeoutTimer.set(guildId, timeoutTimer);
      
      console.log(`playing media #${media.id} ${clipMode ? '(10s clip)' : `(${duration}ms)`} ${media.normalized_path ? 'using pre-normalized file' : 'using on-the-fly normalization'}`);
      return true;
    } catch (err) {
      console.error(`failed to play media #${media.id}: ${err}`);
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
      
      try {
        const mediaProcessor = MediaProcessor.getInstance();
        const normalizedDir = path.join(process.cwd(), 'temp');
        
        const result = await mediaProcessor.normalizeAndConvert(media.file_path, normalizedDir);
        this.storeMediaDuration(media.id, result.duration);
        
        return result.outputPath;
      } catch (err) {
        console.error(`failed to normalize: ${err}`);
        
        // fallback to original file
        return media.file_path;
      }
    }
  }
  
  public async createRandomClip(filePath: string, options?: { clipLength?: number; startTime?: number }): Promise<string> {
    try {
      // use provided values or defaults
      const clipLength = options?.clipLength || 10
      let startTime = options?.startTime
      
      // if no start time provided, calculate random position
      if (startTime === undefined) {
        const duration = await this.getMediaDuration(filePath)
        if (!duration) {
          throw new Error('failed to get media duration')
        }
        
        // generate random start time, leaving room for clip
        const maxStart = Math.max(0, duration / 1000 - clipLength)
        startTime = maxStart > 0 ? Math.random() * maxStart : 0
      }
      
      // make sure temp dir exists
      if (!fs.existsSync('/tmp/otoq')) {
        fs.mkdirSync('/tmp/otoq', { recursive: true })
      }
      
      // generate output path with same extension
      const outputPath = `/tmp/otoq/clip_${Date.now()}${path.extname(filePath)}`
      
      // use fluent-ffmpeg API for test compatibility
      return new Promise((resolve, reject) => {
        ffmpeg(filePath)
          .seekInput(startTime)
          .duration(clipLength)
          .output(outputPath)
          .on('error', (err) => {
            console.error('error creating clip:', err)
            reject(err)
          })
          .on('end', () => {
            resolve(outputPath)
          })
          .run()
      })
    } catch (error) {
      console.error('failed to create random clip:', error)
      return filePath
    }
  }

  // create a clip with effects
  public async createClipWithEffects(
    filePath: string, 
    params: import('./effectsManager').CommandParams
  ): Promise<string> {
    try {
      // make sure temp dir exists
      if (!fs.existsSync('/tmp/otoq')) {
        fs.mkdirSync('/tmp/otoq', { recursive: true })
      }
      
      // generate unique output file
      const ext = params.effects.length > 0 || params.rawFilters ? '.mp4' : path.extname(filePath)
      const outputPath = `/tmp/otoq/clip_${Date.now()}${ext}`
      
      const effectsManager = EffectsManager.getInstance();
      
      // if no effects or raw filters, just use createRandomClip with custom length
      if (params.effects.length === 0 && !params.rawFilters) {
        return this.createRandomClip(filePath, {
          clipLength: params.clipLength,
          startTime: params.startTime
        })
      }
      
      // build ffmpeg command with effects or raw filters
      const ffmpegCommand = effectsManager.getFFmpegCommand(
        filePath,
        outputPath,
        params
      )
      
      // run command with error handling
      await this.execCommand(ffmpegCommand, params.userId || undefined);
      
      // check if output file exists
      if (!fs.existsSync(outputPath)) {
        // if failed, try a simple clip without effects
        console.error('ffmpeg command failed to produce output, falling back to simple clip');
        return this.createRandomClip(filePath, {
          clipLength: params.clipLength,
          startTime: params.startTime
        });
      }
      
      return outputPath;
    } catch (error) {
      console.error('failed to create clip with effects:', error);
      
      // fallback to simple clip
      return this.createRandomClip(filePath);
    }
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
  
  // overload methods for different ways to get duration
  public async getMediaDuration(filePath: string): Promise<number>
  public async getMediaDuration(mediaId: number, filePath: string): Promise<number>
  public async getMediaDuration(mediaIdOrPath: number | string, filePath?: string): Promise<number> {
    // if first arg is string, it's a direct file path
    if (typeof mediaIdOrPath === 'string') {
      return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(mediaIdOrPath, (err, metadata) => {
          if (err) {
            reject(err)
            return
          }
          
          const duration = Math.floor((metadata?.format?.duration || 0) * 1000)
          resolve(duration)
        })
      })
    }
    
    // if we get here, first arg is mediaId
    const mediaId = mediaIdOrPath
    
    // return cached duration if available
    if (this.mediaDurations.has(mediaId)) {
      return this.mediaDurations.get(mediaId) || 0
    }
    
    // we need valid file path
    if (!filePath) {
      return 0
    }
    
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          reject(err)
          return
        }
        
        const duration = Math.floor((metadata?.format?.duration || 0) * 1000)
        this.mediaDurations.set(mediaId, duration)
        resolve(duration)
      })
    })
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
  
  public async createNormalizedFile(filePath: string, volAdjustment: number): Promise<string> {
    const ext = path.extname(filePath)
    let tempFile = path.join(process.cwd(), 'temp', `norm_${Date.now()}${ext}`)
    
    // ensure temp dir exists
    const tempDir = path.dirname(tempFile)
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true })
    }
    
    return new Promise((resolve, reject) => {
      ffmpeg(filePath)
        .audioFilters(`volume=${volAdjustment}dB`)
        .output(tempFile)
        .on('error', reject)
        .on('end', () => resolve(tempFile))
        .run()
    })
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
    const ext = path.extname(filePath).toLowerCase()
    const videoExts = ['.mp4', '.m4a', '.mkv', '.avi', '.mov', '.webm', '.flv']
    return videoExts.includes(ext)
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

  public async getRandomScreencapDirect(mediaId: number, filePath: string): Promise<string | null> {
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
    
    // extract a random frame - no random chance of failing
    const screencapPath = await this.extractRandomFrame(filePath);
    if (screencapPath) {
      this.mediaScreencaps.set(mediaId, screencapPath);
      return screencapPath;
    }
    
    return null;
  }

  // run ffmpeg command (useful for effects processing)
  public async execCommand(command: string, userId?: string): Promise<void> {
    try {
      await execPromise(command);
    } catch (error) {
      const typedError = error as { message?: string };
      console.error(`ffmpeg error: ${typedError.message || 'unknown error'}`);
      
      // store error for user if userId provided
      if (userId) {
        const effectsManager = EffectsManager.getInstance();
        
        // limit error length and clean it up for readability
        let errorMessage = typedError.message || 'unknown error';
        if (errorMessage.length > 1500) {
          errorMessage = errorMessage.substring(0, 1500) + '... (truncated)';
        }
        
        // store the error with the user ID
        effectsManager.storeFFmpegError(userId, errorMessage);
      }
    }
  }
}
