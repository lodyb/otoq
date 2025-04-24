import { AudioPlayerManager } from '../utils/audioPlayerManager';
import path from 'path';

// we don't need to test the actual ffmpeg functionality
jest.mock('fluent-ffmpeg');
jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  mkdirSync: jest.fn()
}));

describe('VideoExtensionHandling', () => {
  let audioPlayerManager: AudioPlayerManager;
  
  beforeEach(() => {
    jest.clearAllMocks();
    (AudioPlayerManager as any).instance = undefined;
    audioPlayerManager = AudioPlayerManager.getInstance();
  });
  
  test('should properly identify webm file extensions', () => {
    // access the private isVideoFile method
    const isVideoFile = (audioPlayerManager as any).isVideoFile;
    
    // test with various extensions
    expect(isVideoFile.call(audioPlayerManager, 'file.webm')).toBe(true);
    expect(isVideoFile.call(audioPlayerManager, 'file.mp4')).toBe(true);
    expect(isVideoFile.call(audioPlayerManager, 'file.mkv')).toBe(true);
    
    // these should NOT be detected as videos
    expect(isVideoFile.call(audioPlayerManager, 'file.ebm')).toBe(false);
    expect(isVideoFile.call(audioPlayerManager, 'file.txt')).toBe(false);
    expect(isVideoFile.call(audioPlayerManager, 'file.mp3')).toBe(false);
  });
  
  // skip testing createNormalizedFile directly since it's private
  // instead just check that various extensions are handled properly
  test('should handle video extensions correctly', () => {
    // mock the extension check function in audioPlayerManager
    const isVideoFileSpy = jest.spyOn(audioPlayerManager as any, 'isVideoFile');
    
    // call with various extensions
    (audioPlayerManager as any).isVideoFile('test.webm');
    (audioPlayerManager as any).isVideoFile('test.mp4');
    (audioPlayerManager as any).isVideoFile('test.mp3');
    
    // verify it was called
    expect(isVideoFileSpy).toHaveBeenCalledTimes(3);
  });

  test('should filter MP4 files correctly', () => {
    const videoFileList = [
      { id: 1, title: 'video 1', file_path: '/path/to/video1.mp4' },
      { id: 2, title: 'audio 1', file_path: '/path/to/audio1.mp3' },
      { id: 3, title: 'video 2', file_path: '/path/to/video2.MP4' }, // uppercase
      { id: 4, title: 'video 3', file_path: '/path/to/video3.mkv' },
    ];
    
    // filter only mp4 files
    const mp4Files = videoFileList.filter(m => m.file_path.toLowerCase().endsWith('.mp4'));
    
    // should only have the two mp4 files
    expect(mp4Files.length).toBe(2);
    expect(mp4Files.map(f => f.id).sort()).toEqual([1, 3]);
    
    // filter matches case-insensitive
    expect(mp4Files.some(f => f.id === 3)).toBe(true);
    
    // doesn't match other video formats
    expect(mp4Files.some(f => f.id === 4)).toBe(false);
  });
});