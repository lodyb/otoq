import path from 'path'
import fs from 'fs'
import ffmpeg from 'fluent-ffmpeg'

interface MediaItemToProcess {
  id: number
  file_path: string
  processed_path?: string 
  duration?: number
}

interface MediaMetadata {
  hasVideo: boolean
  duration: number
  width?: number
  height?: number
  bitrate?: number
  size?: number
}

export class MediaProcessor {
  private static instance: MediaProcessor
  private TARGET_VOLUME = -3 
  private MAX_FILE_SIZE_BYTES = 9 * 1024 * 1024  // exact 9MB limit
  private USE_HARDWARE_ACCEL = true
  private MAX_VIDEO_DURATION_MS = 240000 // 4 minutes max for troublesome videos
  private MAX_NVENC_CRF = 50 // max crf for nvenc
  private MAX_X264_CRF = 51 // max crf for libx264
  private readonly RESOLUTION_STEPS = [
    { width: 1280, height: 720 },  // 720p - default start
    { width: 640, height: 360 },   // 360p - step down
    { width: 480, height: 270 },   // low quality but ok
    { width: 320, height: 180 }    // worst quality that looks ok
  ]

  private constructor() {}

  public static getInstance(): MediaProcessor {
    if (!MediaProcessor.instance) {
      MediaProcessor.instance = new MediaProcessor()
    }
    // disable hardware acceleration in test environment
    if (process.env.NODE_ENV === 'test') {
      MediaProcessor.instance.USE_HARDWARE_ACCEL = false
    }
    return MediaProcessor.instance
  }

  private async isValidMediaFile(filePath: string): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.error(`validation timed out for: ${filePath}`)
        resolve(false)
      }, 15000)
      
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        clearTimeout(timeout)
        
        if (err) {
          console.error(`file validation failed: ${filePath} - ${err.message}`)
          resolve(false)
          return
        }
        
        if (!metadata?.format?.duration) {
          console.error(`file has no duration metadata: ${filePath}`)
          resolve(false)
          return
        }

        resolve(true)
      })
    })
  }

  private async getMediaMetadata(filePath: string): Promise<MediaMetadata> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`metadata analysis timed out for: ${filePath}`))
      }, 15000)
      
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        clearTimeout(timeout)
        
        if (err) {
          reject(new Error(`failed to analyze metadata: ${err.message}`))
          return
        }
        
        const duration = Math.floor((metadata?.format?.duration || 0) * 1000)
        const size = metadata?.format?.size ? Number(metadata.format.size) : fs.statSync(filePath).size
        const bitrate = metadata?.format?.bit_rate ? Number(metadata.format.bit_rate) : 0
        
        // check if there's a video stream
        const videoStream = metadata?.streams?.find(stream => stream.codec_type === 'video' && 
          !stream.disposition?.attached_pic) // exclude cover art
        
        if (videoStream) {
          resolve({
            hasVideo: true,
            duration,
            width: videoStream.width,
            height: videoStream.height,
            bitrate,
            size
          })
        } else {
          resolve({
            hasVideo: false,
            duration,
            bitrate,
            size
          })
        }
      })
    })
  }

  public async normalizeAndConvert(inputPath: string, outputDir: string, mediaId?: number): Promise<{
    outputPath: string
    duration: number
  }> {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true })
    }

    // check file is valid before proceeding
    const isValid = await this.isValidMediaFile(inputPath)
    if (!isValid) {
      throw new Error(`corrupt or invalid media file: ${inputPath}`)
    }

    // get detailed metadata about the media
    const metadata = await this.getMediaMetadata(inputPath)
    
    // determine output format based on content (mp4 for video, mp3 for audio-only)
    const outputExt = metadata.hasVideo ? '.mp4' : '.mp3'
    const baseName = path.basename(inputPath, path.extname(inputPath))
    const outputFileName = mediaId ? `norm_${mediaId}${outputExt}` : `norm_${Date.now()}_${baseName}${outputExt}`
    const outputPath = path.join(outputDir, outputFileName)

    try {
      // analyze volume
      const { maxVolume } = await this.analyzeVolume(inputPath)
      const adjustment = this.TARGET_VOLUME - maxVolume

      // process media with all our parameters
      await this.processMedia(inputPath, outputPath, adjustment, metadata)

      return { outputPath, duration: metadata.duration }
    } catch (err) {
      console.error(`failed processing media: ${err}`)
      throw err
    }
  }

  private async analyzeVolume(filePath: string): Promise<{ maxVolume: number }> {
    return new Promise((resolve, reject) => {
      const volumeTimeout = setTimeout(() => {
        reject(new Error(`volume analysis timed out for: ${filePath}`))
      }, 20000)
      
      ffmpeg(filePath)
        .audioFilters('volumedetect')
        .format('null')
        .output('/dev/null')
        .on('error', (err) => {
          clearTimeout(volumeTimeout)
          reject(new Error(`volume analysis failed: ${err.message}`))
        })
        .on('end', (stdout, stderr) => {
          clearTimeout(volumeTimeout)
          
          if (!stderr) {
            console.error('no stderr output from ffmpeg volume analysis, using default volume')
            resolve({ maxVolume: this.TARGET_VOLUME })
            return
          }

          const match = stderr.match(/max_volume: ([-\d.]+) dB/)
          if (!match || !match[1]) {
            console.error(`could not detect volume level for ${filePath}, using default volume`)
            resolve({ maxVolume: this.TARGET_VOLUME })
            return
          }

          const maxVolume = parseFloat(match[1])
          resolve({ maxVolume })
        })
        .run()
    })
  }

  private async processMedia(
    inputPath: string, 
    outputPath: string, 
    volAdjustment: number, 
    metadata: MediaMetadata
  ): Promise<void> {
    // calculate optimal encoding settings based on source media
    let { crf, audioBitrate } = this.calculateCompressionSettings(metadata);
    
    console.log(`processing ${path.basename(inputPath)} - ${metadata.hasVideo ? 'video' : 'audio'} file`);
    console.log(`source: ${metadata.size ? Math.round(metadata.size/1024/1024) + 'MB' : 'unknown size'}, ${metadata.duration}ms duration`);
    
    let resolutionIndex = 0; // start with highest resolution
    let audioBitrateNum = parseInt(audioBitrate.replace('k', ''));
    let attempt = 1;
    const maxAttempts = 10;
    let mp3Quality = this.isLargeFile(metadata.size) ? 5 : 2; // for audio files
    let opusQuality = this.isLargeFile(metadata.size) ? 5 : 3; // for video audio (1-10 scale, lower=better)
    
    // for extremely large files, start with more aggressive settings
    if (metadata.size && metadata.size > 30 * 1024 * 1024) { // >30MB
      console.log(`extremely large file (${Math.round(metadata.size/1024/1024)}MB), starting with more aggressive settings`);
      crf += 10; // much higher compression
      resolutionIndex = 1; // start with 640x360
      audioBitrateNum = 128; // start with minimum
      mp3Quality = 5; // worse quality for audio
      opusQuality = 6; // worse quality for video audio
    }
    
    while (attempt <= maxAttempts) {
      // get current resolution from steps
      const resolution = this.RESOLUTION_STEPS[resolutionIndex];
      
      console.log(`compression attempt ${attempt}/${maxAttempts}: ${metadata.hasVideo ? 
        `crf=${crf}, resolution=${resolution.width}x${resolution.height}, audioBitrate=${audioBitrateNum}k` : 
        `mp3Quality=${mp3Quality}`}`);
      
      try {
        if (metadata.hasVideo) {
          // run ffmpeg with current video settings
          await this.runFfmpeg(inputPath, outputPath, volAdjustment, metadata, crf, 
                              `${audioBitrateNum}k`, resolution.width, resolution.height, opusQuality);
        } else {
          // audio-only with specific quality
          await this.runFfmpegAudio(inputPath, outputPath, volAdjustment, mp3Quality);
        }
        
        // check if result is small enough
        if (fs.existsSync(outputPath)) {
          const stats = fs.statSync(outputPath);
          const sizeMB = Math.round(stats.size/1024/1024);
          console.log(`output size: ${sizeMB}MB`);
          
          if (stats.size <= this.MAX_FILE_SIZE_BYTES) {
            return; // success!
          }
          
          // not small enough yet, adjust settings for next attempt
          if (attempt < maxAttempts) {
            console.log(`still too large (${sizeMB}MB), trying more aggressive settings...`);
            
            // increase compression for next attempt
            if (metadata.hasVideo) {
              // for video: first try increasing crf before dropping resolution
              if (attempt % 2 === 1) {
                crf += 4; // increase CRF (higher = more compression)
                opusQuality = Math.min(10, opusQuality + 1); // worse audio quality (1-10)
              } else {
                // only drop resolution every other attempt, and only if we haven't reached minimum
                if (resolutionIndex < this.RESOLUTION_STEPS.length - 1) {
                  resolutionIndex++;
                }
                audioBitrateNum = Math.max(96, Math.floor(audioBitrateNum * 0.9)); // keep audio quality decent
              }
            } else {
              // for audio: incrementally increase quality number (worse quality)
              mp3Quality = Math.min(9, mp3Quality + 1);
            }
          }
        }
      } catch (err) {
        console.error(`attempt ${attempt} failed: ${err}`);
        // try again with more aggressive settings if not the last attempt
        if (attempt >= maxAttempts) throw err;
        
        if (metadata.hasVideo) {
          crf = Math.min(51, crf + 4); // x264 max is 51
          audioBitrateNum = Math.max(64, Math.floor(audioBitrateNum * 0.8));
          opusQuality = Math.min(10, opusQuality + 2);
          
          // go to next resolution if available
          if (resolutionIndex < this.RESOLUTION_STEPS.length - 1) {
            resolutionIndex++;
          }
        } else {
          mp3Quality = Math.min(9, mp3Quality + 2); // much worse quality for next attempt
        }
      }
      
      attempt++;
    }
    
    // // if all attempts fail and we have a video file, try last resort mode - audio only
    // if (metadata.hasVideo && metadata.size && metadata.size > 15 * 1024 * 1024) {
    //   console.log("all video attempts failed - trying audio-only extraction as last resort");
    //   try {
    //     await this.extractAudioOnly(inputPath, outputPath, volAdjustment);
    //     if (fs.existsSync(outputPath) && fs.statSync(outputPath).size <= this.MAX_FILE_SIZE_BYTES) {
    //       console.log(`successful audio-only extraction, size: ${Math.round(fs.statSync(outputPath).size/1024/1024)}MB`);
    //       return;
    //     }
    //   } catch (err) {
    //     console.error(`audio extraction failed too: ${err}`);
    //   }
    // }
    
    // if all attempts fail and we have a video file, try last resort mode - trim video to max duration
    if (metadata.hasVideo && metadata.duration && metadata.duration > this.MAX_VIDEO_DURATION_MS) {
      console.log("all video attempts failed - trying to trim video to max duration as last resort");
      try {
        await this.trimVideoToMaxDuration(inputPath, outputPath, volAdjustment, metadata);
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size <= this.MAX_FILE_SIZE_BYTES) {
          console.log(`successful video trimming, size: ${Math.round(fs.statSync(outputPath).size/1024/1024)}MB`);
          return;
        }
      } catch (err) {
        console.error(`video trimming failed too: ${err}`);
      }
    }
    
    throw new Error(`failed to compress file under ${Math.round(this.MAX_FILE_SIZE_BYTES/1024/1024)}MB limit after ${maxAttempts} attempts`);
  }

  private async runFfmpeg(
    inputPath: string,
    outputPath: string,
    volAdjustment: number,
    metadata: MediaMetadata,
    crf: number, 
    audioBitrate: string,
    width: number,
    height: number,
    opusQuality: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const processTimeout = setTimeout(() => {
        reject(new Error(`processing timed out for: ${inputPath}`))
      }, 300000) // 5 minutes timeout
      
      let command = ffmpeg(inputPath)
        .audioFilters(`volume=${volAdjustment}dB`)
      
      if (metadata.hasVideo) {
        // try hardware encoding if enabled
        let useHwAccel = this.USE_HARDWARE_ACCEL
        
        // scale video to max resolution while maintaining aspect ratio
        const scaleFilter = `scale=w='min(${width},iw)':h='min(${height},ih)':force_original_aspect_ratio=decrease`
        
        // check if source file is large and needs more compression from the start
        const isLarge = this.isLargeFile(metadata.size)
        
        // limit crf values to valid ranges
        const nvencCrf = Math.min(this.MAX_NVENC_CRF, crf)
        const x264Crf = Math.min(this.MAX_X264_CRF, crf)
        
        if (useHwAccel) {
          try {
            console.log(`using nvidia hardware acceleration ${isLarge ? '(extra compression for large file)' : '(high quality mode)'}`)
            
            command = command
              .outputOptions('-c:v h264_nvenc')      // nvidia h264 encoder
              .outputOptions('-preset p1')           // p1 is slowest but highest quality preset
              .outputOptions('-rc vbr')              // variable bitrate for better quality
              .outputOptions('-b:v 0')               // let qp control quality
              .outputOptions(`-cq ${nvencCrf}`)      // quality level (higher = more compression)
              .outputOptions(`-maxrate:v ${Math.min(8000, metadata.bitrate ? metadata.bitrate/1000 : 4000)}k`)  // higher max bitrate
              .outputOptions(`-bufsize ${Math.min(16000, metadata.bitrate ? metadata.bitrate/500 : 8000)}k`)    // larger buffer for smoother bitrate
              .outputOptions('-spatial-aq 1')        // spatial adaptive quantization for better detail
              .outputOptions('-temporal-aq 1')       // temporal adaptive quantization
              .outputOptions('-aq-strength 15')      // strength of adaptive quantization (higher = stronger)
              .outputOptions('-c:a libopus')         // opus audio codec (better quality than aac)
              .outputOptions(`-compression_level ${opusQuality}`) // opus compression level (1-10, lower = better)
              .outputOptions('-vbr on')              // variable bitrate mode
              .outputOptions('-application audio')    // favor quality over speech
              .outputOptions(`-vf ${scaleFilter}`)   // scale video if needed
          } catch (err) {
            console.error(`nvidia encoding setup failed: ${err}, falling back to software`)
            useHwAccel = false
          }
        }
        
        // fallback to software encoding if hardware encoding is disabled or failed
        if (!useHwAccel) {
          command = command
            .outputOptions('-c:v libx264')         // software h264 encoder
            .outputOptions(`-crf ${x264Crf}`)      // quality (higher = more compression), limited to max
            .outputOptions('-preset medium')       // encoding speed vs compression
            .outputOptions('-pix_fmt yuv420p')     // pixel format for compatibility
            .outputOptions('-c:a libopus')         // opus audio codec (better quality than aac)
            .outputOptions(`-compression_level ${opusQuality}`) // opus compression level (1-10, lower = better)
            .outputOptions('-vbr on')              // variable bitrate mode
            .outputOptions('-application audio')    // favor quality over speech
            .outputOptions(`-vf ${scaleFilter}`)   // scale video if needed
        }
      } else {
        // audio-only output (mp3) with VBR quality settings - moved to runFfmpegAudio method
        console.error("runFfmpeg called for audio file, should use runFfmpegAudio instead")
        reject(new Error("wrong processor method called"))
        return
      }

      command
        .output(outputPath)
        .on('error', (err) => {
          clearTimeout(processTimeout)
          
          // special handling for hardware encoding failure - retry with software
          if (this.USE_HARDWARE_ACCEL && metadata.hasVideo && (
              err.message.includes('nvenc') || 
              err.message.includes('incorrect parameters') ||
              err.message.includes('Error while opening encoder')
            )) {
            console.error(`nvidia encoder failed: ${err.message}`)
            console.log(`retrying with software encoder`)
            
            // disable hardware acceleration for this run and retry
            const origHwAccel = this.USE_HARDWARE_ACCEL
            this.USE_HARDWARE_ACCEL = false
            
            this.runFfmpeg(inputPath, outputPath, volAdjustment, metadata, crf, audioBitrate, width, height, opusQuality)
              .then(() => {
                // restore original setting and resolve
                this.USE_HARDWARE_ACCEL = origHwAccel
                resolve()
              })
              .catch((swErr) => {
                // restore original setting and reject
                this.USE_HARDWARE_ACCEL = origHwAccel
                reject(new Error(`software encoding also failed: ${swErr.message}`))
              })
            
            return
          }
          
          // regular error handling
          reject(new Error(`processing failed: ${err.message}`))
        })
        .on('end', () => {
          clearTimeout(processTimeout)
          resolve()
        })
        .run()
    })
  }

  private async runFfmpegAudio(
    inputPath: string, 
    outputPath: string, 
    volAdjustment: number,
    mp3Quality: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const processTimeout = setTimeout(() => {
        reject(new Error(`audio processing timed out for: ${inputPath}`))
      }, 180000) // 3 minutes timeout
      
      console.log(`mp3 encoding with VBR quality ${mp3Quality} (${mp3Quality <= 3 ? 'high' : mp3Quality <= 6 ? 'medium' : 'low'} quality)`)
      
      ffmpeg(inputPath)
        .audioFilters(`volume=${volAdjustment}dB`)
        .outputOptions('-c:a libmp3lame')    // mp3 codec
        .outputOptions(`-q:a ${mp3Quality}`) // VBR quality (0-9, lower is better)
        .output(outputPath)
        .on('error', (err) => {
          clearTimeout(processTimeout)
          reject(new Error(`audio processing failed: ${err.message}`))
        })
        .on('end', () => {
          clearTimeout(processTimeout)
          resolve()
        })
        .run()
    })
  }
  
  private async extractAudioOnly(
    inputPath: string,
    outputPath: string,
    volAdjustment: number
  ): Promise<void> {
    // change output extension to mp3
    const mp3Path = outputPath.replace(/\.[^.]+$/, '.mp3')
    
    return new Promise((resolve, reject) => {
      const processTimeout = setTimeout(() => {
        reject(new Error(`audio extraction timed out for: ${inputPath}`))
      }, 180000) // 3 minutes timeout
      
      console.log(`extracting audio only with high compression (last resort)`)
      
      ffmpeg(inputPath)
        .audioFilters(`volume=${volAdjustment}dB`)
        .noVideo() // skip video stream
        .outputOptions('-c:a libmp3lame')
        .outputOptions('-q:a 7') // low quality but small size
        .output(mp3Path)
        .on('error', (err) => {
          clearTimeout(processTimeout)
          reject(new Error(`audio extraction failed: ${err.message}`))
        })
        .on('end', () => {
          clearTimeout(processTimeout)
          resolve()
        })
        .run()
    })
  }

  private async trimVideoToMaxDuration(
    inputPath: string,
    outputPath: string,
    volAdjustment: number,
    metadata: MediaMetadata
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const processTimeout = setTimeout(() => {
        reject(new Error(`trimming timed out for: ${inputPath}`))
      }, 180000) // 3 minutes timeout
      
      console.log(`trimming video to max ${this.MAX_VIDEO_DURATION_MS/1000}s and compressing heavily (last resort)`)
      
      // use software encoding for reliability
      ffmpeg(inputPath)
        .audioFilters(`volume=${volAdjustment}dB`)
        .outputOptions('-ss 0') // start from beginning
        .outputOptions(`-t ${this.MAX_VIDEO_DURATION_MS/1000}`) // set max duration
        .outputOptions('-c:v libx264') // use reliable software encoder
        .outputOptions('-crf 48') // very high compression
        .outputOptions('-preset faster') // faster encoding
        .outputOptions('-pix_fmt yuv420p')
        .outputOptions('-vf scale=480:270') // force to low res
        .outputOptions('-c:a libmp3lame') // mp3 audio instead of opus
        .outputOptions('-q:a 8') // low audio quality
        .output(outputPath)
        .on('error', (err) => {
          clearTimeout(processTimeout)
          reject(new Error(`trimming failed: ${err.message}`))
        })
        .on('end', () => {
          clearTimeout(processTimeout)
          resolve()
        })
        .run()
    })
  }

  private calculateCompressionSettings(metadata: MediaMetadata): {
    crf: number;
    audioBitrate: string;
  } {
    // for audio-only files
    if (!metadata.hasVideo) {
      // calculate based on source size and target limit
      const targetBitrate = Math.min(
        // don't exceed 192kbps regardless of file size
        192,
        // aim for 75% of max file size to be safe
        Math.floor((this.MAX_FILE_SIZE_BYTES * 0.75 * 8) / metadata.duration)
      );
      
      // keep bitrate in reasonable range
      const audioBitrate = Math.max(128, Math.min(192, targetBitrate));
      return { crf: 23, audioBitrate: `${audioBitrate}k` };
    }
    
    // video: calculate target total bitrate based on duration and max file size
    const targetTotalBitrateBps = (this.MAX_FILE_SIZE_BYTES * 8 * 0.9) / (metadata.duration / 1000);
    
    // allocate bitrate between audio and video
    // we prioritize audio quality - guarantee at least 128k, aim for 192k when possible
    let audioBitrateKbps = 192;  // start with ideal quality
    
    // check if we can afford 192k audio
    const minAudioBitrateKbps = 128;  // minimum acceptable audio quality
    const remainingForVideo = (targetTotalBitrateBps / 1000) - audioBitrateKbps;
    
    // if video gets less than 100kbps, reduce audio quality but never below 128k
    if (remainingForVideo < 100) {
      // reduce audio quality to give video at least 100kbps, but keep minimum audio quality
      audioBitrateKbps = Math.max(minAudioBitrateKbps, 
                                 (targetTotalBitrateBps / 1000) - 100);
    }
    
    // the rest goes to video
    const targetVideoBitrateKbps = Math.max(100, (targetTotalBitrateBps / 1000) - audioBitrateKbps);
    
    // map video bitrate to appropriate crf/qp value (roughly)
    let crf = 22;  // default
    
    // adjust crf based on target video bitrate
    if (targetVideoBitrateKbps < 400) {
      crf = 42;  // very low bitrate
    } else if (targetVideoBitrateKbps < 800) {
      crf = 36;  // low bitrate
    } else if (targetVideoBitrateKbps < 1200) {
      crf = 32;  // medium low bitrate
    } else if (targetVideoBitrateKbps < 2400) {
      crf = 28;  // medium bitrate
    } else if (targetVideoBitrateKbps < 4000) {
      crf = 24;  // medium high bitrate
    } else {
      crf = 22;  // high bitrate
    }
    
    console.log(`calculated target bitrate: ${Math.round(targetTotalBitrateBps/1000)}kbps (${Math.round(targetVideoBitrateKbps)}k video + ${audioBitrateKbps}k audio), crf: ${crf}`);
    
    return { crf, audioBitrate: `${audioBitrateKbps}k` };
  }

  private isLargeFile(fileSize?: number): boolean {
    if (!fileSize) return false
    const sizeInMB = fileSize / (1024 * 1024)
    return sizeInMB > 9
  }

  public async batchProcessMedia(mediaItems: MediaItemToProcess[], outputDir: string): Promise<{
    processed: number
    skipped: number  
    errors: { id: number, error: string }[]
  }> {
    let processed = 0
    let skipped = 0
    let errors: { id: number, error: string }[] = []

    const total = mediaItems.length
    const progressInterval = 5 // report every 5 files
    
    for (let i = 0; i < mediaItems.length; i++) {
      const media = mediaItems[i]
      
      try {
        // show progress
        if (i % progressInterval === 0 || i === mediaItems.length - 1) {
          console.log(`processing ${i+1}/${total}: media #${media.id} (${Math.floor((i+1)/total*100)}%)`)
        }
        
        // skip if file doesn't exist
        if (!fs.existsSync(media.file_path)) {
          console.log(`  file not found: ${media.file_path}`)
          errors.push({ id: media.id, error: `file not found: ${media.file_path}` })
          continue
        }

        // process the media file
        const result = await this.normalizeAndConvert(media.file_path, outputDir, media.id)
        processed++
        
        // return full path for db update
        media.processed_path = result.outputPath
        media.duration = result.duration
        
        // show completion for this file
        console.log(`  ✓ processed #${media.id} - duration: ${Math.floor(result.duration/1000)}s`)
      } catch (err: any) {
        console.log(`  ✗ failed #${media.id}: ${err.message}`)
        errors.push({ id: media.id, error: err.message || 'unknown error' })
      }
    }

    return { processed, skipped, errors }
  }
}