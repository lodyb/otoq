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

  private constructor() {}

  public static getInstance(): EffectsManager {
    if (!EffectsManager.instance) {
      EffectsManager.instance = new EffectsManager()
    }
    return EffectsManager.instance
  }

  /**
   * parse command for effects and params
   * format: ..o.param1=value1.param2=value2
   */
  public parseCommandString(command: string): CommandParams {
    const params: CommandParams = {
      effects: [],
      clipLength: 10,
      startTime: 0,
      searchTerm: '',
      effectParams: {}
    }

    // handle basic command case
    if (command === '..o' || command === '..oc' || command === '..of') {
      return params
    }

    // extract command without prefix for parsing
    let cmdText = command
    const prefixes = ['..o', '..oc', '..of']
    for (const prefix of prefixes) {
      if (command.startsWith(prefix)) {
        cmdText = command.substring(prefix.length)
        break
      }
    }

    // if no command after prefix, return defaults
    if (!cmdText || cmdText === '') {
      return params
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
    
    const audioFilter = this.buildAudioEffectsFilter(params.effects, params)
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
}