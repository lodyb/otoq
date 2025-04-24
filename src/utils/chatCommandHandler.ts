import { 
  Message, 
  AttachmentBuilder,
  ChannelType
} from 'discord.js';
import { DatabaseManager } from '../database/databaseManager';
import { GameManager } from './gameManager';
import path from 'path';
import fs from 'fs';
import { EffectsManager, CommandParams } from './effectsManager';

export class ChatCommandHandler {
  private static instance: ChatCommandHandler;
  private PREFIX = '..o';
  private PREFIX_PREV = '..op';
  private PREFIX_CLIP = '..oc';
  private PREFIX_FRAME = '..of';

  private constructor() {}

  public static getInstance(): ChatCommandHandler {
    if (!ChatCommandHandler.instance) {
      ChatCommandHandler.instance = new ChatCommandHandler();
    }
    return ChatCommandHandler.instance;
  }

  public async handleMessage(message: Message): Promise<void> {
    // ignore bot messages
    if (message.author.bot) return;
    
    // check for FFmpeg errors that need to be sent to the user
    await this.checkForFFmpegErrors(message);

    // check for ..op command (previous media)
    if (message.content.startsWith(this.PREFIX_PREV)) {
      await this.handlePreviousMediaCommand(message);
      return;
    }
    
    // check for ..of command (random frame)
    if (message.content.startsWith(this.PREFIX_FRAME)) {
      await this.handleRandomFrameCommand(message);
      return;
    }
    
    // check for ..oc command (random clip)
    if (message.content.startsWith(this.PREFIX_CLIP)) {
      await this.handleRandomClipCommand(message);
      return;
    }

    // check for ..o command (search media)
    if (message.content.startsWith(this.PREFIX)) {
      await this.handleSearchMediaCommand(message);
      return;
    }
  }
  
  /**
   * check if user has pending FFmpeg errors and send them via DM
   */
  private async checkForFFmpegErrors(message: Message): Promise<void> {
    try {
      const effectsManager = EffectsManager.getInstance();
      const userId = message.author.id;
      
      if (effectsManager.hasFFmpegError(userId)) {
        const error = effectsManager.getAndClearFFmpegError(userId);
        if (error) {
          try {
            await message.author.send(`FFmpeg error from your last command:\n\`\`\`\n${error}\n\`\`\`\n(੭ ˃̣̣̥ ㅂ˂̣̣̥)੭ u can fix and try again`);
          } catch (err) {
            // user might have DMs disabled, try to reply in channel
            console.log(`failed to DM user ${userId} with ffmpeg error: ${err}`);
            await message.reply(`couldn't send ffmpeg error via DM, check your privacy settings (￣へ￣)`);
          }
        }
      }
    } catch (error) {
      console.error('error checking/sending ffmpeg errors:', error);
    }
  }

  private async handlePreviousMediaCommand(message: Message): Promise<void> {
    try {
      const guildId = message.guild?.id;
      const channelId = message.channel.id;
      
      if (!guildId) return;
      
      // get game manager and find active session
      const gameManager = GameManager.getInstance();
      
      // typescript is mad because message.channel can be many types
      // but getSession only accepts TextChannel or ThreadChannel
      // so only pass the channel if it's the right type
      const isValidChannel = 
        message.channel.type === ChannelType.GuildText || 
        message.channel.type === ChannelType.PublicThread ||
        message.channel.type === ChannelType.PrivateThread;
      
      const session = gameManager.getSession(
        guildId, 
        channelId, 
        isValidChannel ? message.channel : undefined
      );
      
      if (!session) {
        await message.reply(`no active game session in this channel (｡•́︿•̀｡)`);
        return;
      }
      
      // get previous media id from session
      const prevMediaId = session.getPreviousMediaId();
      
      if (!prevMediaId) {
        await message.reply(`no previous media yet (¬_¬)`);
        return;
      }
      
      // get the media from database
      const db = DatabaseManager.getInstance();
      const prevMedia = await db.getMediaById(prevMediaId);
      
      if (!prevMedia) {
        await message.reply(`couldn't find previous media (｡•́︿•̀｡)`);
        return;
      }
      
      // prefer normalized path if available
      const filePath = prevMedia.normalized_path || prevMedia.file_path;
      
      // check if file exists
      if (!fs.existsSync(filePath)) {
        console.error(`media file not found: ${filePath} (id: ${prevMedia.id})`);
        await message.reply(`media file doesn't exist on disk (╯°□°）╯︵ ┻━┻ id: ${prevMedia.id}, path: ${filePath}`);
        return;
      }
      
      // post the file
      try {
        const attachment = new AttachmentBuilder(filePath, { name: path.basename(filePath) });
        await message.reply({ content: `previous song from round ${session.getCurrentRound()-1} (￣▽￣)`, files: [attachment] });
      } catch (error) {
        console.error('error posting media:', error);
        await message.reply(`failed to post media file (╬ಠ益ಠ) check if file is too large`);
      }
    } catch (error) {
      console.error('error handling previous media command:', error);
      await message.reply('something broke (╯°□°）╯︵ ┻━┻');
    }
  }

  private async handleSearchMediaCommand(message: Message): Promise<void> {
    if (message.author.bot || !message.content.startsWith(this.PREFIX)) return

    try {
      // parse command for effects and params
      const effectsManager = EffectsManager.getInstance()
      
      // add user id to params for error tracking
      const params = effectsManager.parseCommandString(message.content)
      params.userId = message.author.id
      
      const db = DatabaseManager.getInstance()
      let mediaItems = []
      
      // if no search term, get random media
      if (!params.searchTerm) {
        mediaItems = await db.getRandomMedia(undefined, undefined, undefined, 1)
      } else {
        // search for media with matching title
        mediaItems = await db.getMediaByTitle(params.searchTerm)
      }
      
      if (mediaItems.length === 0) {
        await message.reply(`no media found ${params.searchTerm ? `matching "${params.searchTerm}"` : ""} (￣︿￣)`)
        return
      }
      
      // use the first (best) match
      const media = mediaItems[0]
      
      // always use original file path for effects
      const filePath = media.file_path
      
      if (!fs.existsSync(filePath)) {
        console.error(`media file not found: ${filePath} (id: ${media.id})`)
        await message.reply(`media file doesn't exist on disk (╯°□°）╯︵ ┻━┻ id: ${media.id}`)
        return
      }
      
      // show typing if we're applying effects
      if (params.effects.length > 0 || params.rawFilters) {
        try {
          const channel = message.channel as any
          if (channel.sendTyping) {
            await channel.sendTyping()
          }
        } catch (e) {
          // whatever
        }
      }
      
      // check if effects or raw filters requested
      if (params.effects.length > 0 || params.rawFilters) {
        const audioPlayer = (await import('./audioPlayerManager')).AudioPlayerManager.getInstance()
        
        try {
          // create clip with effects
          const outputPath = await audioPlayer.createClipWithEffects(filePath, params)
          
          // post the processed file
          const attachment = new AttachmentBuilder(outputPath, { 
            name: `${media.id}_${params.effects.join('_')}.mp4` 
          })
          
          let effectsText = ''
          if (params.effects.length > 0) {
            effectsText = `with effects: ${params.effects.join(', ')}`
          } else if (params.rawFilters) {
            effectsText = `with raw filters`
          }
          
          await message.reply({ 
            content: `"${media.title}" ${effectsText} (id: ${media.id}) (❁´◡\`❁)`,
            files: [attachment] 
          })
          
          // clean up temp file after delay
          setTimeout(() => {
            if (fs.existsSync(outputPath) && outputPath !== filePath) {
              try {
                fs.unlinkSync(outputPath)
              } catch (err) {
                console.error(`failed to clean up processed file: ${err}`)
              }
            }
          }, 60000)
        } catch (error) {
          console.error('error processing media with effects:', error)
          await message.reply(`failed to process media with effects (╬ಠ益ಠ) check your DMs for error details`)
        }
      } else {
        // no effects, just post the original file
        try {
          const attachment = new AttachmentBuilder(filePath, { name: path.basename(filePath) })
          await message.reply({ files: [attachment] })
        } catch (error) {
          console.error('error posting media:', error)
          await message.reply(`failed to post media file (╬ಠ益ಠ) check if file is too large`)
        }
      }
    } catch (error) {
      console.error('error handling media command:', error)
      await message.reply('something broke (╯°□°）╯︵ ┻━┻')
    }
  }

  private async handleRandomClipCommand(message: Message): Promise<void> {
    if (message.author.bot || !message.content.startsWith(this.PREFIX_CLIP)) return

    try {
      // parse command for effects and params
      const effectsManager = EffectsManager.getInstance()
      
      // add user id to params for error tracking
      const params = effectsManager.parseCommandString(message.content)
      params.userId = message.author.id
      
      const db = DatabaseManager.getInstance()
      let mediaItems = []
      
      // if no search term, get random media
      if (!params.searchTerm) {
        mediaItems = await db.getRandomMedia(undefined, undefined, undefined, 1)
      } else {
        // search for media with matching title
        mediaItems = await db.getMediaByTitle(params.searchTerm)
      }
      
      if (mediaItems.length === 0) {
        await message.reply(`no media found ${params.searchTerm ? `matching "${params.searchTerm}"` : ""} (￣︿￣)`)
        return
      }
      
      // use the first (best) match
      const media = mediaItems[0]
      
      // always use original file path for clips
      const filePath = media.file_path
      
      if (!fs.existsSync(filePath)) {
        console.error(`media file not found: ${filePath} (id: ${media.id})`)
        await message.reply(`media file doesn't exist on disk (╯°□°）╯︵ ┻━┻ id: ${media.id}`)
        return
      }
      
      // show typing indicator
      try {
        const channel = message.channel as any
        if (channel.sendTyping) {
          await channel.sendTyping()
        }
      } catch (e) {
        // whatever
      }
      
      const audioPlayer = (await import('./audioPlayerManager')).AudioPlayerManager.getInstance()
      
      try {
        // use special effects if requested otherwise create basic clip
        let clipPath
        if (params.effects.length > 0 || params.rawFilters) {
          clipPath = await audioPlayer.createClipWithEffects(filePath, params)
        } else {
          clipPath = await audioPlayer.createRandomClip(filePath, {
            clipLength: params.clipLength
          })
        }
        
        if (!clipPath) {
          await message.reply(`failed to create clip (╬ಠ益ಠ)`)
          return
        }
        
        // prepare message content
        let content = `random ${params.clipLength}s clip from "${media.title}" (id: ${media.id})`
        
        // add effects info if any
        if (params.effects.length > 0) {
          content += ` with effects: ${params.effects.join(', ')}`
        } else if (params.rawFilters) {
          content += ` with raw filters`
        }
        
        content += " (￣▽￣)"
        
        // choose appropriate filename
        const filename = (params.effects.length > 0 || params.rawFilters)
          ? `clip_${media.id}_${params.effects.join('_')}.mp4`
          : `clip_${path.basename(filePath)}`
          
        const attachment = new AttachmentBuilder(clipPath, { name: filename })
        await message.reply({ content, files: [attachment] })
        
        // cleanup temp file after delay
        setTimeout(() => {
          if (fs.existsSync(clipPath) && clipPath !== filePath) {
            try {
              fs.unlinkSync(clipPath)
            } catch (err) {
              console.error(`failed to clean up clip: ${err}`)
            }
          }
        }, 60000)
      } catch (error) {
        console.error('error creating/posting clip:', error)
        await message.reply(`failed to create clip (╬ಠ益ಠ) check your DMs for error details`)
      }
    } catch (error) {
      console.error('error handling clip command:', error)
      await message.reply('something broke (╯°□°）╯︵ ┻━┻')
    }
  }

  private async handleRandomFrameCommand(message: Message): Promise<void> {
    if (message.author.bot || !message.content.startsWith(this.PREFIX_FRAME)) return

    try {
      // parse command with effects manager
      const effectsManager = EffectsManager.getInstance()
      
      // add user id to params for error tracking
      const params = effectsManager.parseCommandString(message.content)
      params.userId = message.author.id
      
      const db = DatabaseManager.getInstance()
      let mediaItems = []
      
      if (!params.searchTerm) {
        // get random video files by filtering mp4 only
        const allMedia = await db.getRandomMedia(undefined, undefined, undefined, 20)
        mediaItems = allMedia.filter(m => m.file_path.toLowerCase().endsWith('.mp4'))
        
        // if no mp4s, try again with larger sample
        if (mediaItems.length === 0) {
          const moreMedia = await db.getRandomMedia(undefined, undefined, undefined, 50)
          mediaItems = moreMedia.filter(m => m.file_path.toLowerCase().endsWith('.mp4'))
        }
        
        // take just one random video
        if (mediaItems.length > 0) {
          const randomIndex = Math.floor(Math.random() * mediaItems.length)
          mediaItems = [mediaItems[randomIndex]]
        }
      } else {
        // search for videos with title match
        const searchResults = await db.getMediaByTitle(params.searchTerm)
        mediaItems = searchResults.filter(m => m.file_path.toLowerCase().endsWith('.mp4'))
      }
      
      if (mediaItems.length === 0) {
        await message.reply(`no mp4 video files found ${params.searchTerm ? `matching "${params.searchTerm}"` : ""} (￣︿￣)`)
        return
      }
      
      const media = mediaItems[0]
      
      // use original file path NOT normalized
      const filePath = media.file_path
      
      if (!fs.existsSync(filePath)) {
        console.error(`media file not found: ${filePath} (id: ${media.id})`)
        await message.reply(`media file doesn't exist on disk (╯°□°）╯︵ ┻━┻ id: ${media.id}`)
        return
      }
      
      const audioPlayer = (await import('./audioPlayerManager')).AudioPlayerManager.getInstance()
      
      try {
        const channel = message.channel as any
        if (channel.sendTyping) {
          await channel.sendTyping()
        }
      } catch (e) {
        // whatever
      }
      
      try {
        let framePath: string | null
        
        // check if we should extract frame at specific time
        if (params.startTime > 0) {
          const tempPath = `/tmp/otoq/frame_${Date.now()}.jpg`
          
          // ensure temp dir exists
          if (!fs.existsSync('/tmp/otoq')) {
            fs.mkdirSync('/tmp/otoq', { recursive: true })
          }
          
          // extract frame at specific time
          const ffmpegCommand = `ffmpeg -i "${filePath}" -ss ${params.startTime} -frames:v 1 "${tempPath}"`
          await audioPlayer.execCommand(ffmpegCommand, params.userId)
          
          framePath = tempPath
        } else {
          // extract random frame
          framePath = await audioPlayer.getRandomScreencapDirect(media.id, filePath)
        }
        
        if (!framePath) {
          await message.reply(`failed to extract frame (╬ಠ益ಠ)`)
          return
        }
        
        // apply effects to the image if requested
        if (params.effects.length > 0 || params.rawFilters) {
          try {
            const outputPath = `/tmp/otoq/frame_${Date.now()}_effects.jpg`
            
            // For standard effects
            if (params.effects.length > 0 && !params.rawFilters) {
              // build image filters
              const imageFilters: string[] = []
              params.effects.forEach(effect => {
                switch (effect) {
                  case 'pixelize':
                    imageFilters.push('boxblur=10:5')
                    break
                  case 'oscilloscope':
                    imageFilters.push('oscilloscope=x=1:y=1:s=1')
                    break
                  case 'vectorscope':
                    imageFilters.push('vectorscope=mode=color')
                    break
                  case 'amplify':
                    imageFilters.push('eq=contrast=1.5:brightness=0.1:saturation=1.5')
                    break
                  case 'drunk':
                    imageFilters.push('scroll=horizontal=0.1:vertical=0.1')
                    break
                  case '360':
                    imageFilters.push('v360=input=equirect:output=fisheye')
                    break
                  case 'interlace':
                    imageFilters.push('interlace')
                    break
                  case 'random':
                    imageFilters.push('noise=alls=20:allf=t')
                    break
                }
              })
              
              if (imageFilters.length > 0) {
                const filterString = imageFilters.join(',')
                const ffmpegCommand = `ffmpeg -i "${framePath}" -vf "${filterString}" "${outputPath}"`
                await audioPlayer.execCommand(ffmpegCommand, params.userId)
                
                // use the processed frame
                framePath = outputPath
              }
            }
            // For raw filters
            else if (params.rawFilters) {
              const ffmpegCommand = `ffmpeg -i "${framePath}" -vf "${params.rawFilters}" "${outputPath}"`
              await audioPlayer.execCommand(ffmpegCommand, params.userId)
              
              // use the processed frame if it exists
              if (fs.existsSync(outputPath)) {
                framePath = outputPath
              }
            }
          } catch (err) {
            console.error('failed to apply image effects:', err)
            // continue with original frame
          }
        }
        
        // build content message
        let content = `random frame from "${media.title}" (id: ${media.id})`
        
        // add timestamp info if specific time
        if (params.startTime > 0) {
          const minutes = Math.floor(params.startTime / 60)
          const seconds = Math.floor(params.startTime % 60)
          content += ` at ${minutes}:${seconds.toString().padStart(2, '0')}`
        }
        
        // add effects info if any
        if (params.effects.length > 0) {
          content += ` with effects: ${params.effects.join(', ')}`
        } else if (params.rawFilters) {
          content += ` with raw filters`
        }
        
        content += " (￣▽￣)"
        
        const attachment = new AttachmentBuilder(framePath, { name: `frame_${media.id}.jpg` })
        await message.reply({ content, files: [attachment] })
        
        setTimeout(() => {
          if (fs.existsSync(framePath)) {
            try {
              fs.unlinkSync(framePath)
            } catch (err) {
              console.error(`failed to clean up frame: ${err}`)
            }
          }
        }, 60000)
      } catch (error) {
        console.error('error extracting/posting frame:', error)
        await message.reply(`failed to extract frame (╬ಠ益ಠ) check your DMs for error details`)
      }
    } catch (error) {
      console.error('error handling frame command:', error)
      await message.reply('something broke (╯°□°）╯︵ ┻━┻')
    }
  }
}