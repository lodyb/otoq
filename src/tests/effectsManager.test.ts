import { EffectsManager, CommandParams } from '../utils/effectsManager'

describe('EffectsManager', () => {
  let effectsManager: EffectsManager

  beforeEach(() => {
    effectsManager = EffectsManager.getInstance()
  })

  describe('parseCommandString', () => {
    test('parses basic command with no params', () => {
      const result = effectsManager.parseCommandString('..o')
      expect(result).toEqual({
        effects: [],
        clipLength: 10,
        startTime: 0,
        searchTerm: ''
      })
    })

    test('parses search term without effects', () => {
      const result = effectsManager.parseCommandString('..o.test search')
      expect(result).toEqual({
        effects: [],
        clipLength: 10,
        startTime: 0,
        searchTerm: 'test search'
      })
    })

    test('parses clip length parameter', () => {
      const result = effectsManager.parseCommandString('..o.c=5')
      expect(result.clipLength).toBe(5)
    })

    test('parses start time parameter', () => {
      const result = effectsManager.parseCommandString('..o.s=30')
      expect(result.startTime).toBe(30)
    })

    test('parses single effect', () => {
      const result = effectsManager.parseCommandString('..o.bass')
      expect(result.effects).toEqual(['bass'])
    })

    test('parses multiple effects', () => {
      const result = effectsManager.parseCommandString('..o.bass.echo.reverse')
      expect(result.effects).toEqual(['bass', 'echo', 'reverse'])
    })

    test('parses effect with count', () => {
      const result = effectsManager.parseCommandString('..o.echo=3')
      expect(result.effects).toEqual(['echo', 'echo', 'echo'])
    })

    test('parses complex command with all params', () => {
      const result = effectsManager.parseCommandString('..o.c=15.s=5.bass.echo=2.test query')
      expect(result).toEqual({
        effects: ['bass', 'echo', 'echo'],
        clipLength: 15,
        startTime: 5,
        searchTerm: 'test query'
      })
    })
  })

  describe('buildAudioEffectsFilter', () => {
    test('returns empty string for no effects', () => {
      const result = effectsManager.buildAudioEffectsFilter([])
      expect(result).toBe('')
    })

    test('builds filter for single audio effect', () => {
      const result = effectsManager.buildAudioEffectsFilter(['bass'])
      expect(result).toContain('bass=g=')
    })

    test('builds filter for multiple audio effects', () => {
      const result = effectsManager.buildAudioEffectsFilter(['bass', 'echo', 'reverse'])
      expect(result).toContain('bass=g=')
      expect(result).toContain('aecho=')
      expect(result).toContain('areverse')
    })

    test('stacks multiple echo effects', () => {
      const result = effectsManager.buildAudioEffectsFilter(['echo', 'echo'])
      const matches = result.match(/aecho=/g)
      expect(matches?.length).toBeGreaterThan(1)
    })
  })

  describe('buildVideoEffectsFilter', () => {
    test('returns empty array for no effects', () => {
      const result = effectsManager.buildVideoEffectsFilter([])
      expect(result).toEqual([])
    })

    test('builds filters for single video effect', () => {
      const result = effectsManager.buildVideoEffectsFilter(['pixelize'])
      expect(result).toEqual(['pixelize=w=16:h=16'])
    })

    test('builds filters for multiple video effects', () => {
      const result = effectsManager.buildVideoEffectsFilter(['pixelize', 'reverse', 'drunk'])
      expect(result).toContain('pixelize=w=16:h=16')
      expect(result).toContain('reverse')
      expect(result[2]).toMatch(/tmix=frames=\d+/)
    })
  })

  describe('getFFmpegCommand', () => {
    test('generates basic command with no effects', () => {
      const params: CommandParams = {
        effects: [],
        clipLength: 10,
        startTime: 0,
        searchTerm: ''
      }
      const result = effectsManager.getFFmpegCommand('input.mp4', 'output.mp4', params)
      expect(result).toContain('ffmpeg -i "input.mp4"')
      expect(result).toContain('-t 10')
      expect(result).toContain('"output.mp4"')
    })

    test('includes start time when set', () => {
      const params: CommandParams = {
        effects: [],
        clipLength: 10,
        startTime: 30,
        searchTerm: ''
      }
      const result = effectsManager.getFFmpegCommand('input.mp4', 'output.mp4', params)
      expect(result).toContain('-ss 30')
    })

    test('includes audio filters when audio effects present', () => {
      const params: CommandParams = {
        effects: ['bass', 'echo'],
        clipLength: 10,
        startTime: 0,
        searchTerm: ''
      }
      const result = effectsManager.getFFmpegCommand('input.mp4', 'output.mp4', params)
      expect(result).toContain('-af "')
    })

    test('includes video filters when video effects present', () => {
      const params: CommandParams = {
        effects: ['pixelize', 'drunk'],
        clipLength: 10,
        startTime: 0,
        searchTerm: ''
      }
      const result = effectsManager.getFFmpegCommand('input.mp4', 'output.mp4', params)
      expect(result).toContain('-filter_complex "')
    })

    test('generates complex command with mixed effects', () => {
      const params: CommandParams = {
        effects: ['bass', 'echo', 'pixelize', 'reverse'],
        clipLength: 15,
        startTime: 5,
        searchTerm: ''
      }
      const result = effectsManager.getFFmpegCommand('input.mp4', 'output.mp4', params)
      expect(result).toContain('ffmpeg -i "input.mp4"')
      expect(result).toContain('-filter_complex "')
      expect(result).toContain('-af "')
      expect(result).toContain('-ss 5')
      expect(result).toContain('-t 15')
      expect(result).toContain('"output.mp4"')
    })
  })

  describe('complex effect combinations', () => {
    test('multiple echo effects change delay values', () => {
      const result = effectsManager.buildAudioEffectsFilter(['echo', 'echo', 'echo'])
      
      // should have 3 different echo delays
      expect(result).toContain('aecho=0.8:0.5:300:0.5')
      expect(result).toContain('aecho=0.8:0.4:600:0.5') 
      expect(result).toContain('aecho=0.8:0.3:900:0.5')
    })
    
    test('combines speed and reversal effects', () => {
      const audioResult = effectsManager.buildAudioEffectsFilter(['fast', 'reverse'])
      const videoResult = effectsManager.buildVideoEffectsFilter(['fast', 'reverse'])
      
      expect(audioResult).toContain('atempo=1.5')
      expect(audioResult).toContain('areverse')
      expect(videoResult).toContain('setpts=0.5*PTS')
      expect(videoResult).toContain('reverse')
    })
    
    test('parses search query containing periods', () => {
      const result = effectsManager.parseCommandString('..o.bass.s=10.this is a song with periods')
      
      expect(result.effects).toEqual(['bass'])
      expect(result.startTime).toBe(10)
      expect(result.searchTerm).toBe('this is a song with periods')
    })
    
    test('handles effect chain with multiple of the same effect', () => {
      const cmd = '..o.c=20.bass.echo=3.reverse.bass'
      const result = effectsManager.parseCommandString(cmd)
      
      expect(result.clipLength).toBe(20)
      expect(result.effects).toContain('bass')
      expect(result.effects).toContain('reverse')
      expect(result.effects.filter(e => e === 'echo').length).toBe(3)
      expect(result.effects.filter(e => e === 'bass').length).toBe(2)
    })
  })
})