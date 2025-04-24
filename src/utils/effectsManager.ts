/**
 * class to handle parsing and applying effects for media commands
 */
import path from 'path'

export class EffectsManager {
  private static instance: EffectsManager

  // valid effects that can be applied
  private validEffects = [
    'slow', 'fast', 'bass', 'clipping', 'reverse', 'random',
    'chorus', 'ess', 'mountains', 'whisper', 'robot', 'phaser', 
    'tremelo', 'vibrato', 'oscilloscope', 'pixelize', 'interlace', 
    'drunk', '360', 'vectorscope', 'amplify', 'echo',
    'crazy', 'delay', 'blur', 'sharp', 'dark', 'bright', 'colorshift', 'grain', 'glitch'
  ]
  
  // whitelist of allowed raw ffmpeg filters
  private validRawFilters = [
    // audio filters
    'afftfilt', 'aecho', 'aeval', 'afade', 'acrusher', 'adelay', 'aresample',
    'areverse', 'atempo', 'bass', 'bandpass', 'bandreject', 'chorus', 'compand',
    'compensationdelay', 'crossfeed', 'crystalizer', 'dcshift', 'deesser',
    'drmeter', 'dynaudnorm', 'earwax', 'equalizer', 'extrastereo', 'firequalizer',
    'flanger', 'haas', 'hdcd', 'highpass', 'join', 'loudnorm', 'lowpass',
    'mcompand', 'pan', 'phaser', 'aphaser', 'apulsator', 'reverb', 'sidechaincompress', 
    'silenceremove', 'stereotools', 'stereowiden', 'superequalizer', 'surround', 
    'treble', 'asetrate', 'tremolo', 'vibrato', 'volume', 'volumedetect',
    
    // video filters
    'amplify', 'boxblur', 'colorbalance', 'colorchannelmixer', 'colorlevels',
    'colormatrix', 'convolution', 'datascope', 'deband', 'deflicker', 'deshake',
    'despill', 'drawbox', 'drawgrid', 'edgedetect', 'elbg', 'eq', 'gblur',
    'gradfun', 'hflip', 'hue', 'interlace', 'kerndeint', 'lenscorrection',
    'loop', 'lutyuv', 'lut3d', 'negate', 'noise', 'normalize', 'oscilloscope',
    'pixelize', 'random', 'reverse', 'rotate', 'scale', 'setpts', 'sharpen',
    'smartblur', 'stereo3d', 'swapuv', 'tmix', 'transpose', 'unsharp', 'v360',
    'vectorscope', 'vflip', 'vignette', 'zoompan'
  ]
  
  // users who have gotten ffmpeg errors (to be DM'd)
  private ffmpegErrors: Map<string, string> = new Map()

  private constructor() {}

  public static getInstance(): EffectsManager {
    if (!EffectsManager.instance) {
      EffectsManager.instance = new EffectsManager()
    }
    return EffectsManager.instance
  }

  /**
   * parse command for effects and params
   * formats:
   * - ..o.param1=value1.param2=value2
   * - ..o{filter1=param1=val1:param2=val2,filter2=param=val} search term
   */
  public parseCommandString(command: string): CommandParams {
    const params: CommandParams = {
      effects: [],
      clipLength: 10,
      startTime: 0,
      searchTerm: '',
      effectParams: {},
      rawFilters: null,
      userId: null,
      rawFilterType: null
    }

    // handle basic command case
    if (command === '..o' || command === '..oc' || command === '..of') {
      return params
    }

    // extract command prefix to determine type
    const prefixes = ['..o', '..oc', '..of']
    let prefix = ''
    let cmdText = command
    
    for (const p of prefixes) {
      if (command.startsWith(p)) {
        prefix = p
        cmdText = command.substring(p.length)
        break
      }
    }
    
    // if no valid prefix or no command text
    if (!prefix || !cmdText) {
      return params
    }
    
    // extract parts inside curly braces safely
    const braceMatches: {start: number, end: number, content: string}[] = []
    let braceStart = -1
    let braceLevel = 0
    
    // find all matching curly brace sections
    for (let i = 0; i < cmdText.length; i++) {
      if (cmdText[i] === '{') {
        braceLevel++
        if (braceLevel === 1) {
          braceStart = i
        }
      } else if (cmdText[i] === '}') {
        braceLevel--
        if (braceLevel === 0 && braceStart !== -1) {
          braceMatches.push({
            start: braceStart,
            end: i,
            content: cmdText.substring(braceStart + 1, i)
          })
          braceStart = -1
        }
      }
    }
    
    // if we have any brace matches, we need special handling
    if (braceMatches.length > 0) {
      // split command into segments
      const segments: {type: 'text' | 'brace', content: string}[] = []
      let lastPos = 0
      
      // build segments in order
      for (const match of braceMatches) {
        // add text before brace if any
        if (match.start > lastPos) {
          segments.push({
            type: 'text',
            content: cmdText.substring(lastPos, match.start)
          })
        }
        
        // add brace content
        segments.push({
          type: 'brace',
          content: match.content
        })
        
        lastPos = match.end + 1
      }
      
      // add any remaining text after last brace
      if (lastPos < cmdText.length) {
        segments.push({
          type: 'text',
          content: cmdText.substring(lastPos)
        })
      }
      
      // process segments
      let filterContent = null
      let textBeforeFilter = ''
      let textAfterFilter = ''
      let foundFilter = false
      
      for (const segment of segments) {
        if (segment.type === 'brace' && !foundFilter) {
          // first brace content becomes our filter
          filterContent = segment.content
          foundFilter = true
        } else if (segment.type === 'text') {
          if (!foundFilter) {
            textBeforeFilter += segment.content
          } else {
            textAfterFilter += segment.content
          }
        } else if (segment.type === 'brace' && foundFilter) {
          // additional brace content gets added to search term
          textAfterFilter += `{${segment.content}}`
        }
      }
      
      // process standard params from text before filter
      if (textBeforeFilter) {
        // Handle parameters that come before the filter braces
        // Parse standard format params (c=8, s=45, etc.)
        const standardParams = this.parseStandardPrefixParams(prefix + textBeforeFilter)
        
        // Copy the parsed parameters to our result params object
        if (standardParams.clipLength !== undefined) params.clipLength = standardParams.clipLength;
        if (standardParams.startTime !== undefined) params.startTime = standardParams.startTime;
        if (standardParams.effects && standardParams.effects.length > 0) {
          params.effects = standardParams.effects;
        }
        if (standardParams.effectParams) {
          params.effectParams = standardParams.effectParams;
        }
      }
      
      // set raw filter content
      if (filterContent) {
        params.rawFilters = this.validateRawFilter(filterContent)
      }
      
      // set search term from text after filter
      params.searchTerm = textAfterFilter.trim()
      
      // determine filter type based on the character right before the first brace
      if (braceMatches[0].start > 0) {
        const charBeforeBrace = cmdText[braceMatches[0].start - 1]
        if (charBeforeBrace === 'v') {
          params.rawFilterType = 'video'
        } else if (charBeforeBrace === 'a') {
          params.rawFilterType = 'audio'
        } else {
          params.rawFilterType = 'both'
        }
      } else {
        params.rawFilterType = 'both'
      }
      
      return params
    }
    
    // if no braces found, use standard parsing
    return this.parseStandardCommand(command)
  }

  /**
   * parse just the prefix params from a standard command
   * (everything before the search term)
   */
  private parseStandardPrefixParams(command: string): Partial<CommandParams> {
    const params: Partial<CommandParams> = {
      effects: [],
      effectParams: {},
      clipLength: 10,
      startTime: 0
    }
    
    // extract command without prefix
    let cmdText = command
    const prefixes = ['..o', '..oc', '..of']
    for (const prefix of prefixes) {
      if (command.startsWith(prefix)) {
        cmdText = command.substring(prefix.length)
        break
      }
    }
    
    // remove leading dot if present
    if (cmdText.startsWith('.')) {
      cmdText = cmdText.substring(1)
    }

    // no params? return defaults
    if (!cmdText) {
      return params
    }

    // split params by dots
    const parts = cmdText.split('.')
    
    // parse param parts (but not search text)
    for (const part of parts) {
      // skip parts with spaces (likely search text)
      if (part.includes(' ')) continue
      
      // param=value format
      if (part.includes('=')) {
        const [paramName, paramValue] = part.split('=')
        
        switch (paramName.toLowerCase()) {
          case 'c':
          case 'clip':
          case 'length':
            params.clipLength = parseFloat(paramValue) || 10
            break
            
          case 's':
          case 'start':
            params.startTime = parseFloat(paramValue) || 0
            break
            
          // handle effect params like echo=2
          default:
            if (this.validEffects.includes(paramName)) {
              const value = parseInt(paramValue) || 1
              params.effectParams![paramName] = value
              
              // add to effects array for backward compatibility
              for (let j = 0; j < value; j++) {
                params.effects!.push(paramName)
              }
            }
        }
      } else {
        // check for numbered effects like echo3
        const match = part.match(/^(\D+)(\d+)$/)
        if (match) {
          const [_, baseEffect, countStr] = match
          if (this.validEffects.includes(baseEffect)) {
            const count = parseInt(countStr) || 1
            params.effectParams![baseEffect] = count
            
            // add to effects array for backward compatibility
            for (let j = 0; j < count; j++) {
              params.effects!.push(baseEffect)
            }
          }
        } 
        // single effect
        else if (this.validEffects.includes(part)) {
          params.effects!.push(part)
          params.effectParams![part] = (params.effectParams![part] || 0) + 1
        }
      }
    }
    
    return params
  }
  
  /**
   * parse standard command format without raw filters
   * format: ..o.param1=value1.param2=value2 search term
   */
  private parseStandardCommand(command: string): CommandParams {
    const params: CommandParams = {
      effects: [],
      clipLength: 10,
      startTime: 0,
      searchTerm: '',
      effectParams: {},
      rawFilters: null,
      userId: null,
      rawFilterType: null
    }
    
    // extract command without prefix
    let cmdText = command
    const prefixes = ['..o', '..oc', '..of']
    for (const prefix of prefixes) {
      if (command.startsWith(prefix)) {
        cmdText = command.substring(prefix.length)
        break
      }
    }
    
    // remove leading dot if present
    if (cmdText.startsWith('.')) {
      cmdText = cmdText.substring(1)
    }

    // split params by dots
    const parts = cmdText.split('.')
    let paramParts: string[] = []
    let searchText = ''

    // find where the regular text (non-param) starts
    let textStartIndex = -1
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      
      // if part has spaces or doesn't have = and isn't an effect, it's search text
      if (part.includes(' ') || 
         (!part.includes('=') && !this.isEffectParam(part))) {
        textStartIndex = i
        break
      }
      
      paramParts.push(part)
    }

    // if we found text, combine the rest as search term
    if (textStartIndex !== -1) {
      const textParts = parts.slice(textStartIndex)
      searchText = textParts.join(' ')
      params.searchTerm = searchText
    }

    // parse actual params
    for (const part of paramParts) {
      // param=value format
      if (part.includes('=')) {
        const [paramName, paramValue] = part.split('=')
        
        switch (paramName.toLowerCase()) {
          case 'c':
          case 'clip':
          case 'length':
            params.clipLength = parseFloat(paramValue) || 10
            break
            
          case 's':
          case 'start':
            params.startTime = parseFloat(paramValue) || 0
            break
            
          // handle effect params like echo=2
          default:
            if (this.validEffects.includes(paramName)) {
              const value = parseInt(paramValue) || 1
              
              // store as param value for configurable effects
              params.effectParams[paramName] = value
              
              // still add to effects array for backward compatibility
              for (let j = 0; j < value; j++) {
                params.effects.push(paramName)
              }
            }
        }
      } else {
        // check for numbered effects like echo3
        const match = part.match(/^(\D+)(\d+)$/)
        if (match) {
          const [_, baseEffect, countStr] = match
          if (this.validEffects.includes(baseEffect)) {
            const count = parseInt(countStr) || 1
            
            // store as param value for configurable effects
            params.effectParams[baseEffect] = count
            
            // still add to effects array for backward compatibility
            for (let j = 0; j < count; j++) {
              params.effects.push(baseEffect)
            }
          }
        } 
        // single effect
        else if (this.validEffects.includes(part)) {
          params.effects.push(part)
          
          // also increment/initialize effect param
          params.effectParams[part] = (params.effectParams[part] || 0) + 1
        }
      }
    }
    
    return params
  }
  
  /**
   * validate a raw filter string to prevent command injection
   * returns sanitized filter string or null if invalid
   */
  private validateRawFilter(filterStr: string): string | null {
    if (!filterStr || filterStr.trim() === '') {
      return null
    }
    
    try {
      // split into individual filters
      const filters = filterStr.split(',')
      const validatedFilters: string[] = []
      
      for (const filter of filters) {
        // check for basic filter syntax: filtername=params
        const eqIndex = filter.indexOf('=')
        if (eqIndex === -1) {
          // only filter name, check if it's in whitelist
          if (this.validRawFilters.includes(filter.trim())) {
            validatedFilters.push(filter.trim())
          }
          continue
        }
        
        // extract filter name
        const filterName = filter.substring(0, eqIndex).trim()
        
        // check if filter is in whitelist
        if (!this.validRawFilters.includes(filterName)) {
          continue
        }
        
        // for params, we don't validate individual values as ffmpeg will handle ranges
        // but we do sanitize for shell injection
        const paramsPart = filter.substring(eqIndex + 1)
        
        // basic sanitization for shell safety
        if (this.hasDangerousChars(paramsPart)) {
          continue
        }
        
        // this filter + params validated, add to result
        validatedFilters.push(`${filterName}=${paramsPart}`)
      }
      
      // if all filters were invalid, return null
      if (validatedFilters.length === 0) {
        return null
      }
      
      // join validated filters
      return validatedFilters.join(',')
    } catch (error) {
      console.error('error validating raw filter:', error)
      return null
    }
  }
  
  /**
   * check for dangerous characters that could allow shell injection
   */
  private hasDangerousChars(input: string): boolean {
    // character blacklist for shell command injection
    // only block actual dangerous shell characters, not ffmpeg filter chars
    const dangerousPatterns = [
      // shell escape sequences and command chaining
      ';', '&', '|', '`', 
      // redirection
      '>', '<',
      // quotes that could break out of our ffmpeg string
      '"', "'",
    ]
    
    return dangerousPatterns.some(pattern => input.includes(pattern))
  }

  /**
   * check if a string might be an effect parameter
   */
  private isEffectParam(part: string): boolean {
    // check for basic effect names
    if (this.validEffects.includes(part)) return true
    
    // check for numbered effects like echo3
    const match = part.match(/^(\D+)(\d+)$/)
    if (match) {
      const [_, baseEffect, _count] = match
      return this.validEffects.includes(baseEffect)
    }
    
    // check for command params
    return ['c', 'clip', 'length', 's', 'start'].includes(part)
  }

  /**
   * build ffmpeg filter string for audio effects
   */
  public buildAudioEffectsFilter(effects: string[], params?: CommandParams): string {
    // if raw audio filters are provided, use them directly
    if (params?.rawFilters && (params.rawFilterType === 'audio' || params.rawFilterType === 'both')) {
      return params.rawFilters
    }
    
    // otherwise, use the existing logic
    let audioFilter = ''
    let bassGain = 0
    let crystalizerIntensity = 0
    let echoCount = 0
    let delayCount = 0
    let vibratoAmount = 1
    let rubberbandTempo = 1
    let rubberbandPitch = 1
    
    // get effect multipliers from params
    const effectParams = params?.effectParams || {}
    
    // handle direct param effects first
    if (Object.keys(effectParams).length > 0) {
      const paramEffects = Object.keys(effectParams)
      
      paramEffects.forEach(effect => {
        const amount = effectParams[effect]
        
        switch (effect) {
          case 'bass':
            bassGain = amount * 10
            crystalizerIntensity += amount * 1.3
            break
            
          case 'clipping':
            for (let i = 0; i < amount; i++) {
              audioFilter += 'acrusher=.1:1:64:0:log,'
            }
            crystalizerIntensity += amount * 2
            break
            
          case 'crazy':
            for (let i = 0; i < amount; i++) {
              audioFilter += 'acrusher=.1:1:64:0:log,'
            }
            crystalizerIntensity += amount * 3
            break
            
          case 'echo':
            // calculate values based on total amount
            const delay = 300 * amount
            const decay = Math.max(0.1, 0.6 - (amount * 0.1)).toFixed(1)
            audioFilter += `aecho=0.8:${decay}:${delay}:0.5,`
            break
            
          case 'delay':
            // calculate values based on total amount
            const delayMs = 150 + (amount * 200)
            const delayMsR = 250 + (amount * 150)
            audioFilter += `adelay=${delayMs}|${delayMsR},`
            break
            
          case 'vibrato':
            vibratoAmount = Math.max(1, amount * 2)
            audioFilter += `vibrato=f=${vibratoAmount},`
            break
            
          case 'slow':
            rubberbandTempo = Math.max(0.2, Math.pow(0.5, amount))
            audioFilter += `atempo=${rubberbandTempo},`
            break
            
          case 'fast':
            rubberbandTempo = Math.min(2.0, Math.pow(1.5, amount))
            audioFilter += `atempo=${rubberbandTempo},`
            break
            
          case 'reverse':
            if (amount % 2 === 1) { // only add if odd number
              audioFilter += 'areverse,'
            }
            break
            
          case 'chorus':
            audioFilter += 'chorus=0.5:0.9:50|60|70:0.3|0.22|0.3:0.25|0.4|0.3:2|2.3|1.3,'
            break
            
          case 'ess':
            audioFilter += 'deesser=i=1:s=e[a];[a]aeval=val(ch)*10:c=same,'
            break
            
          case 'mountains':
            audioFilter += 'aecho=0.8:0.9:500|1000:0.2|0.1,'
            break
            
          case 'whisper':
            audioFilter += "afftfilt=real='hypot(re,im)*cos((random(0)*2-1)*2*3.14)':imag='hypot(re,im)*sin((random(1)*2-1)*2*3.14)':win_size=128:overlap=0.8,"
            break
            
          case 'robot':
            audioFilter += "afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75,"
            break
            
          case 'phaser':
            audioFilter += 'aphaser=type=t:speed=2:decay=0.6,'
            break
            
          case 'tremelo':
            audioFilter += 'apulsator=mode=sine:hz=1:width=0.3:offset_r=0,'
            break
        }
      })
      
      // add bass gain after all calculations
      if (bassGain > 0) {
        audioFilter += `bass=g=${Math.min(bassGain, 30)},`
      }
      
      // add crystalizer if used
      if (crystalizerIntensity > 0) {
        audioFilter += `crystalizer=i=${Math.min(crystalizerIntensity, 9.9)},`
      }
      
      // trim trailing comma
      if (audioFilter.endsWith(',')) {
        audioFilter = audioFilter.slice(0, -1)
      }
      
      return audioFilter
    }
    
    // fallback to old implementation if no params
    effects.forEach(effect => {
      switch (effect) {
        case 'clipping':
          audioFilter += 'acrusher=.1:1:64:0:log,'
          crystalizerIntensity += 2
          break
          
        case 'bass':
          bassGain += 10
          crystalizerIntensity += 1.3
          break
          
        case 'reverse':
          audioFilter += 'areverse,'
          break
          
        case 'chorus':
          audioFilter += 'chorus=0.5:0.9:50|60|70:0.3|0.22|0.3:0.25|0.4|0.3:2|2.3|1.3,'
          break
          
        case 'ess':
          audioFilter += 'deesser=i=1:s=e[a];[a]aeval=val(ch)*10:c=same,'
          break
          
        case 'mountains':
          audioFilter += 'aecho=0.8:0.9:500|1000:0.2|0.1,'
          break
          
        case 'whisper':
          audioFilter += "afftfilt=real='hypot(re,im)*cos((random(0)*2-1)*2*3.14)':imag='hypot(re,im)*sin((random(1)*2-1)*2*3.14)':win_size=128:overlap=0.8,"
          break
          
        case 'robot':
          audioFilter += "afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75,"
          break
          
        case 'phaser':
          audioFilter += 'aphaser=type=t:speed=2:decay=0.6,'
          break
          
        case 'tremelo':
          audioFilter += 'apulsator=mode=sine:hz=1:width=0.3:offset_r=0,'
          break
          
        case 'vibrato':
          audioFilter += 'vibrato=f=4,'
          break
          
        case 'echo':
          echoCount++
          // increase delay and decrease volume with more echoes
          const delay = 300 * echoCount
          const decay = Math.max(0.1, 0.6 - (echoCount * 0.1)).toFixed(1) // fix floating point
          audioFilter += `aecho=0.8:${decay}:${delay}:0.5,`
          break
          
        case 'slow':
          audioFilter += 'atempo=0.5,'
          break
          
        case 'fast':
          audioFilter += 'atempo=1.5,'
          break
          
        case 'crazy':
          audioFilter += 'acrusher=.1:1:64:0:log,'
          crystalizerIntensity += 3
          break
          
        case 'delay':
          delayCount++
          // different style of delay than echo
          const delayMs = 150 + (delayCount * 200)
          const delayMsR = 250 + (delayCount * 150)
          audioFilter += `adelay=${delayMs}|${delayMsR},`
          break
      }
    })
    
    // add bass and crystalizer if used
    if (bassGain > 0) {
      audioFilter += `bass=g=${Math.min(bassGain, 30)},`
    }
    
    if (crystalizerIntensity > 0) {
      audioFilter += `crystalizer=i=${Math.min(crystalizerIntensity, 9.9)},`
    }
    
    // trim trailing comma
    if (audioFilter.endsWith(',')) {
      audioFilter = audioFilter.slice(0, -1)
    }
    
    return audioFilter
  }

  /**
   * build ffmpeg filter string for video effects
   */
  public buildVideoEffectsFilter(effects: string[], params?: CommandParams): string[] {
    // if raw video filters are provided, use them directly
    if (params?.rawFilters && (params.rawFilterType === 'video' || params.rawFilterType === 'both')) {
      // for raw video filters, we need to convert the comma-separated string to array
      // as video filters are handled differently than audio filters
      return params.rawFilters.split(',')
    }
    
    // otherwise, use existing code
    const videoFilters: string[] = []
    
    // get effect params if available
    const effectParams = params?.effectParams || {}
    
    // base values
    let drunkFrames = 8
    let randomFrames = 4
    let blurAmount = 2
    let sharpAmount = 1
    let darkenAmount = 0.1
    let brightenAmount = 0.9
    let hueShift = 45
    let saturation = 1.3
    let grainAmount = 4
    let glitchAmount = 0.3
    let amplifyFactor = 1.5
    let amplifyThreshold = 0.9
    
    // use params directly when available
    if (Object.keys(effectParams).length > 0) {
      // apply direct param effects
      Object.keys(effectParams).forEach(effect => {
        const amount = effectParams[effect]
        
        switch (effect) {
          case 'reverse':
            if (amount % 2 === 1) { // only add if odd number
              videoFilters.push('reverse')
            }
            break
            
          case 'random':
            videoFilters.push(`random=frames=${4 * amount}`)
            break
            
          case 'oscilloscope':
            videoFilters.push('oscilloscope=x=1:y=1:s=1')
            break
            
          case 'pixelize':
            videoFilters.push(`pixelize=w=${8 * amount}:h=${8 * amount}`)
            break
            
          case 'interlace':
            videoFilters.push('interlace=scan=tff')
            break
            
          case 'drunk':
            videoFilters.push(`tmix=frames=${8 * Math.min(amount, 6)}`)
            break
            
          case '360':
            videoFilters.push('v360=input=equirect:output=fisheye:ih_fov=180:iv_fov=180')
            break
            
          case 'vectorscope':
            videoFilters.push('vectorscope=mode=color:graticule=green:flags=name')
            break
            
          case 'amplify':
            // amplify scales more dramatically
            const factor = 1.5 * Math.pow(2, amount - 1)
            videoFilters.push(`amplify=factor=${factor}:threshold=${amplifyThreshold}`)
            break
            
          case 'slow':
            videoFilters.push(`setpts=${Math.pow(2, amount)}*PTS`)
            break
            
          case 'fast':
            videoFilters.push(`setpts=${1 / Math.pow(1.5, amount)}*PTS`)
            break
            
          case 'blur':
            videoFilters.push(`boxblur=${2 * amount}:${2 * amount}`)
            break
            
          case 'sharp':
            const sharp = Math.min(amount, 5)
            videoFilters.push(`unsharp=${sharp}:${sharp}:${sharp * 0.3}:${sharp * 0.3}:${sharp * 0.2}:0`)
            break
            
          case 'dark':
            const darkVal = Math.min(0.1 * amount, 0.9)
            videoFilters.push(`colorlevels=rimin=${darkVal}:gimin=${darkVal}:bimin=${darkVal}`)
            break
            
          case 'bright':
            const brightVal = Math.max(1 - (0.1 * amount), 0.2)
            videoFilters.push(`colorlevels=romax=${brightVal}:gomax=${brightVal}:bomax=${brightVal}`)
            break
            
          case 'colorshift':
            const hue = (45 * amount) % 360
            const sat = Math.min(1 + (0.3 * amount), 3)
            videoFilters.push(`hue=h=${hue}:s=${sat}`)
            break
            
          case 'grain':
            const noise = Math.min(4 * amount, 15)
            videoFilters.push(`noise=alls=${noise}:allf=t`)
            break
            
          case 'glitch':
            const opacity = Math.min(0.3 * amount, 0.8)
            videoFilters.push(`datascope=mode=color:format=hex:opacity=${opacity}`)
            break
        }
      })
      
      return videoFilters
    }
    
    // fallback to original implementation for backward compatibility
    effects.forEach(effect => {
      switch (effect) {
        case 'reverse':
          videoFilters.push('reverse')
          break
          
        case 'random':
          videoFilters.push(`random=frames=${randomFrames}`)
          randomFrames = Math.min(randomFrames + 4, 32)
          break
          
        case 'oscilloscope':
          videoFilters.push('oscilloscope=x=1:y=1:s=1')
          break
          
        case 'pixelize':
          videoFilters.push('pixelize=w=16:h=16')
          break
          
        case 'interlace':
          videoFilters.push('interlace=scan=tff')
          break
          
        case 'drunk':
          videoFilters.push(`tmix=frames=${drunkFrames}`)
          drunkFrames = Math.min(drunkFrames + 4, 32)
          break
          
        case '360':
          videoFilters.push('v360=input=equirect:output=fisheye:ih_fov=180:iv_fov=180')
          break
          
        case 'vectorscope':
          videoFilters.push('vectorscope=mode=color:graticule=green:flags=name')
          break
          
        case 'amplify':
          videoFilters.push('amplify=factor=1.5:threshold=0.9')
          break
          
        case 'slow':
          videoFilters.push('setpts=2*PTS')
          break
          
        case 'fast':
          videoFilters.push('setpts=0.5*PTS')
          break
          
        case 'blur':
          videoFilters.push(`boxblur=${blurAmount}:${blurAmount}`)
          blurAmount = Math.min(blurAmount + 2, 20)
          break
          
        case 'sharp':
          videoFilters.push(`unsharp=${sharpAmount}:${sharpAmount}:${sharpAmount * 0.3}:${sharpAmount * 0.3}:${sharpAmount * 0.2}:0`)
          sharpAmount = Math.min(sharpAmount + 1, 5)
          break
          
        case 'dark':
          videoFilters.push(`colorlevels=rimin=${darkenAmount}:gimin=${darkenAmount}:bimin=${darkenAmount}`)
          darkenAmount = Math.min(darkenAmount + 0.05, 0.9)
          break
          
        case 'bright':
          videoFilters.push(`colorlevels=romax=${brightenAmount}:gomax=${brightenAmount}:bomax=${brightenAmount}`)
          brightenAmount = Math.max(brightenAmount - 0.1, 0.2)
          break
          
        case 'colorshift':
          videoFilters.push(`hue=h=${hueShift}:s=${saturation}`)
          hueShift = (hueShift + 45) % 360
          saturation = Math.min(saturation + 0.3, 3)
          break
          
        case 'grain':
          videoFilters.push(`noise=alls=${grainAmount}:allf=t`)
          grainAmount = Math.min(grainAmount + 2, 15)
          break
          
        case 'glitch':
          videoFilters.push(`datascope=mode=color:format=hex:opacity=${glitchAmount}`)
          glitchAmount = Math.min(glitchAmount + 0.1, 0.8)
          break
      }
    })
    
    return videoFilters
  }

  /**
   * get command params for creating audio/video clips
   */
  public getFFmpegCommand(
    inputFile: string, 
    outputFile: string,
    params: CommandParams
  ): string {
    // check if file has video stream
    const hasVideo = this.checkForVideoStream(inputFile)
    
    // dynamically set output extension if needed
    if (!hasVideo && outputFile.endsWith('.mp4')) {
      // change output file extension for audio-only files
      outputFile = outputFile.replace(/\.mp4$/, '.mp3')
    }
    
    // build audio filter string 
    const audioFilter = this.buildAudioEffectsFilter(params.effects, params)
    
    // build video filters array
    const videoFilters = hasVideo ? this.buildVideoEffectsFilter(params.effects, params) : []
    
    let filterComplex = ''
    let filterArgs = ''
    
    // handle video filters if any (only if we have video)
    if (hasVideo && videoFilters.length > 0) {
      filterComplex = `[0:v]${videoFilters.join(',')}[v]`
      filterArgs = `-map "[v]" -map 0:a? `
    }
    
    // add audio filter if any
    if (audioFilter) {
      filterArgs += `-af "${audioFilter}" `
    }
    
    // build command
    let command = `ffmpeg -i "${inputFile}" `
    
    // add complex filter if needed
    if (filterComplex) {
      command += `-filter_complex "${filterComplex}" `
    }
    
    // add other filters
    command += filterArgs
    
    // add start time if needed
    if (params.startTime > 0) {
      command += `-ss ${params.startTime} `
    }
    
    // add duration
    command += `-t ${params.clipLength} `
    
    // output settings based on type
    if (hasVideo) {
      command += `-c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k "${outputFile}"`
    } else {
      command += `-c:a libmp3lame -b:a 192k "${outputFile}"`
    }
    
    return command
  }
  
  /**
   * check if a file has a video stream
   */
  private checkForVideoStream(filePath: string): boolean {
    try {
      // quick check based on extension
      const ext = path.extname(filePath).toLowerCase()
      const audioOnlyExts = ['.mp3', '.ogg', '.wav', '.flac', '.m4a', '.aac']
      if (audioOnlyExts.includes(ext)) {
        return false
      }
      
      // for other extensions, assume video is present
      // (the real check requires ffprobe which is async)
      return true
    } catch (err) {
      // assume it has video on error
      return true
    }
  }
  
  /**
   * store ffmpeg error for a user to be sent as DM
   */
  public storeFFmpegError(userId: string, error: string): void {
    this.ffmpegErrors.set(userId, error)
  }
  
  /**
   * get and clear ffmpeg error for a user
   */
  public getAndClearFFmpegError(userId: string): string | null {
    const error = this.ffmpegErrors.get(userId)
    if (error) {
      this.ffmpegErrors.delete(userId)
      return error
    }
    return null
  }
  
  /**
   * check if a user has pending ffmpeg errors
   */
  public hasFFmpegError(userId: string): boolean {
    return this.ffmpegErrors.has(userId)
  }
}

/**
 * type for command parameters
 */
export interface CommandParams {
  effects: string[]
  clipLength: number
  startTime: number
  searchTerm: string
  effectParams: { [key: string]: number }
  rawFilters: string | null
  rawFilterType: 'audio' | 'video' | 'both' | null
  userId: string | null
}