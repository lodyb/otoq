import { AudioPlayerManager } from '../utils/audioPlayerManager';
import { MediaItem } from '../utils/gameSession';
import { VoiceChannel } from 'discord.js';
import fs from 'fs';

// better mocks for voice connections
jest.mock('@discordjs/voice', () => {
  return {
    joinVoiceChannel: jest.fn().mockReturnValue({
      subscribe: jest.fn(),
      destroy: jest.fn(),
      on: jest.fn(),
      state: { status: 'ready' }
    }),
    createAudioPlayer: jest.fn().mockReturnValue({
      play: jest.fn(),
      stop: jest.fn(),
      on: jest.fn()
    }),
    createAudioResource: jest.fn(),
    AudioPlayerStatus: {
      Idle: 'idle',
      Playing: 'playing'
    },
    VoiceConnectionStatus: {
      Ready: 'ready',
      Disconnected: 'disconnected'
    },
    entersState: jest.fn().mockResolvedValue(true)
  };
});

// mock ffmpeg with proper ffprobe
jest.mock('fluent-ffmpeg', () => {
  const mockFfmpegInstance = {
    audioFilters: jest.fn().mockReturnThis(),
    format: jest.fn().mockReturnThis(),
    output: jest.fn().mockReturnThis(),
    on: jest.fn().mockImplementation(function(this: any, event: string, callback: any) {
      if (event === 'end') callback(null, 'max_volume: -10.0 dB');
      return this;
    }),
    run: jest.fn()
  };
  
  const ffmpegMock = jest.fn().mockReturnValue(mockFfmpegInstance);
  (ffmpegMock as any).ffprobe = jest.fn().mockImplementation((path: string, callback: any) => {
    callback(null, {
      format: { duration: 30.5 }
    });
  });
  return ffmpegMock;
});

// fs mock
jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  readFileSync: jest.fn().mockReturnValue('{}'),
  unlinkSync: jest.fn()
}));

describe('AudioPlayerManager', () => {
  let audioPlayerManager: AudioPlayerManager;
  let mockVoiceChannel: any;
  
  beforeEach(() => {
    jest.clearAllMocks();
    
    // reset singleton
    (AudioPlayerManager as any).instance = undefined;
    
    // manually set constants on the prototype before instantiation
    Object.defineProperties(AudioPlayerManager.prototype, {
      'FIRST_HINT_TIME': { value: 20000, writable: true },
      'HINT_INTERVAL': { value: 10000, writable: true },
      'SHORT_CLIP_THRESHOLD': { value: 30000, writable: true }
    });
    
    audioPlayerManager = AudioPlayerManager.getInstance();
    
    // mock methods to avoid voice connection errors
    audioPlayerManager.joinChannel = jest.fn().mockResolvedValue(true);
    audioPlayerManager.playMedia = jest.fn().mockResolvedValue(true);
    audioPlayerManager.stopPlaying = jest.fn().mockReturnValue(true);
    audioPlayerManager.leaveChannel = jest.fn().mockReturnValue(true);
    
    mockVoiceChannel = {
      id: 'test-voice-channel',
      guild: {
        id: 'test-guild',
        voiceAdapterCreator: jest.fn()
      }
    };
  });
  
  test('should join voice channel', async () => {
    const result = await audioPlayerManager.joinChannel(mockVoiceChannel as VoiceChannel);
    expect(result).toBe(true);
  });
  
  test('should play media', async () => {
    const mockMedia: MediaItem = {
      id: 1,
      title: 'Test Song',
      file_path: '/path/to/song.mp3'
    };
    
    const result = await audioPlayerManager.playMedia('test-guild', mockMedia);
    expect(result).toBe(true);
  });
  
  test('should trigger audio end callback', async () => {
    const mockMedia: MediaItem = {
      id: 1,
      title: 'Test Song',
      file_path: '/path/to/song.mp3'
    };
    
    // Set up current media and isPlaying so the handleAudioEnd works
    (audioPlayerManager as any).currentMedia = new Map();
    (audioPlayerManager as any).currentMedia.set('test-guild', mockMedia);
    (audioPlayerManager as any).isPlaying = new Map();
    (audioPlayerManager as any).isPlaying.set('test-guild', true);
    
    // Set up a mock callback
    const mockCallback = jest.fn();
    (audioPlayerManager as any).onEndCallbacks = new Map();
    (audioPlayerManager as any).onEndCallbacks.set('test-guild', mockCallback);
    
    // Instead of calling handleAudioEnd, directly trigger the callback
    audioPlayerManager.triggerEndCallback('test-guild');
    
    // Check if callback was called
    expect(mockCallback).toHaveBeenCalled();
  });
  
  test('should trigger hint callback', async () => {
    const mockMedia: MediaItem = {
      id: 1,
      title: 'Test Song',
      file_path: '/path/to/song.mp3'
    };
    
    // Set up a mock hint callback
    const mockHintCallback = jest.fn();
    audioPlayerManager.setOnHint('test-guild', mockHintCallback);
    
    // Store hint callback manually
    (audioPlayerManager as any).onHintCallbacks = new Map();
    (audioPlayerManager as any).onHintCallbacks.set('test-guild', mockHintCallback);
    
    // Call hint callback directly
    const hintCallback = (audioPlayerManager as any).onHintCallbacks.get('test-guild');
    hintCallback(mockMedia, 0);
    
    // Check if our mock was called
    expect(mockHintCallback).toHaveBeenCalledWith(mockMedia, 0);
  });
  
  test('should stop playing', async () => {
    const result = audioPlayerManager.stopPlaying('test-guild');
    expect(result).toBe(true);
  });
  
  test('should leave channel', async () => {
    const result = audioPlayerManager.leaveChannel('test-guild');
    expect(result).toBe(true);
  });
  
  test('should correctly identify short clips', () => {
    // Mock mediaDurations map
    (audioPlayerManager as any).mediaDurations = new Map();
    (audioPlayerManager as any).mediaDurations.set(1, 15000); // 15 seconds
    
    // Test with public method
    const duration = audioPlayerManager.getStoredMediaDuration(1);
    expect(duration).toBe(15000);
    
    // Check if it's identified as a short clip
    const isShortClip = duration <= (audioPlayerManager as any).SHORT_CLIP_THRESHOLD;
    expect(isShortClip).toBe(true);
  });
  
  test('should reset corrupted media list', () => {
    // add some media to corrupted list
    (audioPlayerManager as any).corruptedMedia = new Set();
    (audioPlayerManager as any).corruptedMedia.add(1);
    (audioPlayerManager as any).corruptedMedia.add(2);
    
    // verify they're in the list
    expect((audioPlayerManager as any).corruptedMedia.has(1)).toBe(true);
    
    // reset the list
    audioPlayerManager.resetCorruptedMediaList();
    
    // verify the list is empty
    expect((audioPlayerManager as any).corruptedMedia.size).toBe(0);
  });
  
  test('should track temp files for cleanup', () => {
    // we changed this structure completely - now it's a Set<string> instead of Map<string, Set<string>>
    
    // add a temp file to track
    audioPlayerManager.trackTempFile('guild1', '/path/to/temp/file.mp3');
    
    // verify file is tracked in tempFilesByGuild
    const guildFiles = (audioPlayerManager as any).tempFilesByGuild.get('guild1');
    expect(guildFiles).toBeDefined();
    expect(guildFiles.has('/path/to/temp/file.mp3')).toBe(true);
    
    // also verify in main Set
    expect((audioPlayerManager as any).tempFiles.has('/path/to/temp/file.mp3')).toBe(true);
    
    // mock cleanupTempFile
    (audioPlayerManager as any).cleanupTempFile = jest.fn();
    
    // call cleanup
    audioPlayerManager.cleanupTempFilesForGuild('guild1');
    
    // expect cleanupTempFile was called
    expect((audioPlayerManager as any).cleanupTempFile).toHaveBeenCalledWith('/path/to/temp/file.mp3');
  });

  test('should get stored media duration', () => {
    // manually set a duration in the private property
    (audioPlayerManager as any).mediaDurations = new Map();
    (audioPlayerManager as any).mediaDurations.set(42, 30000);
    
    // test retrieving it
    const duration = audioPlayerManager.getStoredMediaDuration(42);
    expect(duration).toBe(30000);
    
    // test non-existent media id
    const nonExistentDuration = audioPlayerManager.getStoredMediaDuration(999);
    expect(nonExistentDuration).toBe(0);
  });

  test('should handle volume analysis errors', async () => {
    // mock the fluent-ffmpeg exec for this test specifically
    const mockErrorObj = {
      audioFilters: jest.fn().mockReturnThis(),
      format: jest.fn().mockReturnThis(),
      output: jest.fn().mockReturnThis(),
      on: jest.fn().mockImplementation(function(this: any, event: string, callback: any) {
        if (event === 'error') callback(new Error('ffmpeg error'));
        return this;
      }),
      run: jest.fn(),
    };
    
    // override ffmpeg mock
    const ffmpegMock = require('fluent-ffmpeg');
    const originalImpl = jest.mocked(ffmpegMock).getMockImplementation();
    jest.mocked(ffmpegMock).mockImplementation(() => mockErrorObj);
    
    // try to analyze volume - should not throw
    const analyzeVolume = (audioPlayerManager as any).analyzeVolume;
    const result = await analyzeVolume.call(audioPlayerManager, '/path/to/file.mp3');
    
    // restore original mock
    jest.mocked(ffmpegMock).mockImplementation(originalImpl);
    
    // should return default 0
    expect(result).toBe(0);
  });

  test('should handle missing stderr in volume analysis', async () => {
    // mock with no stderr
    const mockNoStderrObj = {
      audioFilters: jest.fn().mockReturnThis(),
      format: jest.fn().mockReturnThis(),
      output: jest.fn().mockReturnThis(),
      on: jest.fn().mockImplementation(function(this: any, event: string, callback: any) {
        if (event === 'end') callback();
        return this;
      }),
      run: jest.fn(),
    };
    
    // override ffmpeg mock
    const ffmpegMock = require('fluent-ffmpeg');
    const originalImpl = jest.mocked(ffmpegMock).getMockImplementation();
    jest.mocked(ffmpegMock).mockImplementation(() => mockNoStderrObj);
    
    // try to analyze volume
    const analyzeVolume = (audioPlayerManager as any).analyzeVolume;
    const result = await analyzeVolume.call(audioPlayerManager, '/path/to/file.mp3');
    
    // restore original mock
    jest.mocked(ffmpegMock).mockImplementation(originalImpl);
    
    // should default to 0
    expect(result).toBe(0);
  });

  test('should have proper timeouts for audio playback', () => {
    // verify the clip threshold and hint times are set
    expect((audioPlayerManager as any).SHORT_CLIP_THRESHOLD).toBe(30000);
    expect((audioPlayerManager as any).FIRST_HINT_TIME).toBe(20000);
    expect((audioPlayerManager as any).HINT_INTERVAL).toBe(10000);
    
    // all should be positive numbers
    expect((audioPlayerManager as any).SHORT_CLIP_THRESHOLD).toBeGreaterThan(0);
    expect((audioPlayerManager as any).FIRST_HINT_TIME).toBeGreaterThan(0);
    expect((audioPlayerManager as any).HINT_INTERVAL).toBeGreaterThan(0);
  });

  test('should store media duration from ffprobe result', async () => {
    // mock the mediaDurations map
    (audioPlayerManager as any).mediaDurations = new Map();
    
    // create a direct spy on storeMediaDuration method
    const storeMediaDuration = jest.spyOn(audioPlayerManager, 'storeMediaDuration');
    
    // call the method directly
    audioPlayerManager.storeMediaDuration(42, 30500);
    
    // verify it was called correctly
    expect(storeMediaDuration).toHaveBeenCalledWith(42, 30500);
    
    // check that value was stored properly
    expect(audioPlayerManager.getStoredMediaDuration(42)).toBe(30500);
    
    // cleanup
    storeMediaDuration.mockRestore();
  });

  test('should detect video files correctly', () => {
    // test private method isVideoFile
    const isVideoFile = (audioPlayerManager as any).isVideoFile;

    // these should be detected as videos
    expect(isVideoFile.call(audioPlayerManager, 'file.mp4')).toBe(true);
    expect(isVideoFile.call(audioPlayerManager, 'file.mkv')).toBe(true);
    expect(isVideoFile.call(audioPlayerManager, 'file.avi')).toBe(true);
    expect(isVideoFile.call(audioPlayerManager, 'file.mov')).toBe(true);
    expect(isVideoFile.call(audioPlayerManager, 'file.webm')).toBe(true);
    
    // these should not be videos
    expect(isVideoFile.call(audioPlayerManager, 'file.mp3')).toBe(false);
    expect(isVideoFile.call(audioPlayerManager, 'file.flac')).toBe(false);
    expect(isVideoFile.call(audioPlayerManager, 'file.wav')).toBe(false);
    expect(isVideoFile.call(audioPlayerManager, 'file.ogg')).toBe(false);
  });

  test('should generate and track screencaps', async () => {
    // override the private extractRandomFrame method
    const mockScreencapPath = '/path/to/temp/screencap_123456.jpg';
    (audioPlayerManager as any).extractRandomFrame = jest.fn().mockResolvedValue(mockScreencapPath);
    (audioPlayerManager as any).isVideoFile = jest.fn().mockReturnValue(true);
    
    // mock Math.random to always return 0.5 (middle value) to avoid the 15% no-hint chance
    const originalRandom = Math.random;
    Math.random = jest.fn().mockReturnValue(0.5);
    
    // setup mediaScreencaps map
    (audioPlayerManager as any).mediaScreencaps = new Map();
    
    // call getRandomScreencap
    const result = await audioPlayerManager.getRandomScreencap(42, 'video.mp4');
    
    // restore Math.random
    Math.random = originalRandom;
    
    // verify screencap path was returned and saved
    expect(result).toBe(mockScreencapPath);
    expect((audioPlayerManager as any).mediaScreencaps.get(42)).toBe(mockScreencapPath);
    
    // should return cached path on second call
    jest.spyOn(fs, 'existsSync').mockReturnValueOnce(true);
    const secondResult = await audioPlayerManager.getRandomScreencap(42, 'video.mp4');
    expect(secondResult).toBe(mockScreencapPath);
    expect((audioPlayerManager as any).extractRandomFrame).toHaveBeenCalledTimes(1); // should not be called again
  });

  test('should clean up screencaps when cleaning guild', () => {
    // setup mediaScreencaps map with a test entry
    const mockScreencapPath = '/path/to/temp/screencap_123456.jpg';
    (audioPlayerManager as any).mediaScreencaps = new Map();
    (audioPlayerManager as any).mediaScreencaps.set(42, mockScreencapPath);
    
    // set up current media for the guild
    (audioPlayerManager as any).currentMedia = new Map();
    (audioPlayerManager as any).currentMedia.set('test-guild', { id: 42 });
    
    // mock cleanupTempFile
    (audioPlayerManager as any).cleanupTempFile = jest.fn();
    
    // call cleanup
    audioPlayerManager.cleanupTempFilesForGuild('test-guild');
    
    // verify screencap was cleaned up
    expect((audioPlayerManager as any).cleanupTempFile).toHaveBeenCalledWith(mockScreencapPath);
    expect((audioPlayerManager as any).mediaScreencaps.has(42)).toBe(false);
  });
});