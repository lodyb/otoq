import { 
  Message, 
  AttachmentBuilder,
  ChannelType
} from 'discord.js';
import { DatabaseManager } from '../database/databaseManager';
import { GameManager } from './gameManager';
import path from 'path';
import fs from 'fs';

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
        await message.reply(`media file doesn't exist on disk (╯°□°）╯︵ ┻━┻ id: ${prevMedia.id}`);
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
    // ignore bot messages and messages that don't start with prefix
    if (message.author.bot || !message.content.startsWith(this.PREFIX)) return;

    try {
      // extract search term (everything after the prefix and a space)
      const searchTerm = message.content.slice(this.PREFIX.length).trim();
      
      const db = DatabaseManager.getInstance();
      let mediaItems = [];
      
      // if no search term, get random media
      if (!searchTerm) {
        mediaItems = await db.getRandomMedia(undefined, undefined, undefined, 1);
      } else {
        // search for media with matching title
        mediaItems = await db.getMediaByTitle(searchTerm);
      }
      
      if (mediaItems.length === 0) {
        await message.reply(`no media found ${searchTerm ? `matching "${searchTerm}"` : ""} (￣︿￣)`);
        return;
      }
      
      // use the first (best) match
      const media = mediaItems[0];
      
      // prefer normalized path if available
      const filePath = media.normalized_path || media.file_path;
      
      // check if file exists
      if (!fs.existsSync(filePath)) {
        await message.reply(`media file doesn't exist on disk (╯°□°）╯︵ ┻━┻ id: ${media.id}`);
        return;
      }
      
      // post the file
      try {
        const attachment = new AttachmentBuilder(filePath, { name: path.basename(filePath) });
        await message.reply({ files: [attachment] });
      } catch (error) {
        console.error('error posting media:', error);
        await message.reply(`failed to post media file (╬ಠ益ಠ) check if file is too large`);
      }
    } catch (error) {
      console.error('error handling chat command:', error);
      await message.reply('something broke (╯°□°）╯︵ ┻━┻');
    }
  }

  private async handleRandomClipCommand(message: Message): Promise<void> {
    // ignore bot messages and messages that don't start with prefix
    if (message.author.bot || !message.content.startsWith(this.PREFIX_CLIP)) return;

    try {
      // extract search term (everything after the prefix and a space)
      const searchTerm = message.content.slice(this.PREFIX_CLIP.length).trim();
      
      const db = DatabaseManager.getInstance();
      let mediaItems = [];
      
      // if no search term, get random media
      if (!searchTerm) {
        mediaItems = await db.getRandomMedia(undefined, undefined, undefined, 1);
      } else {
        // search for media with matching title
        mediaItems = await db.getMediaByTitle(searchTerm);
      }
      
      if (mediaItems.length === 0) {
        await message.reply(`no media found ${searchTerm ? `matching "${searchTerm}"` : ""} (￣︿￣)`);
        return;
      }
      
      // use the first (best) match
      const media = mediaItems[0];
      
      // prefer normalized path if available
      const filePath = media.normalized_path || media.file_path;
      
      // check if file exists
      if (!fs.existsSync(filePath)) {
        await message.reply(`media file doesn't exist on disk (╯°□°）╯︵ ┻━┻ id: ${media.id}`);
        return;
      }
      
      // get audio player to create random clip
      const audioPlayer = (await import('./audioPlayerManager')).AudioPlayerManager.getInstance();
      
      // show typing indicator where it exists
      try {
        // use "as any" to bypass the type checking
        const channel = message.channel as any;
        if (channel.sendTyping) {
          await channel.sendTyping();
        }
      } catch (e) {
        // ignore error
      }
      
      try {
        // create 10s clip
        const clipPath = await audioPlayer.createRandomClip(filePath);
        if (!clipPath) {
          await message.reply(`failed to create clip (╬ಠ益ಠ)`);
          return;
        }
        
        // post the clip
        const attachment = new AttachmentBuilder(clipPath, { name: `clip_${path.basename(filePath)}` });
        await message.reply({ 
          content: `random 10s clip from "${media.title}" (id: ${media.id}) (￣▽￣)`,
          files: [attachment] 
        });
        
        // cleanup temp file after a delay to ensure discord has time to process it
        setTimeout(() => {
          if (fs.existsSync(clipPath) && clipPath !== filePath) {
            try {
              fs.unlinkSync(clipPath);
            } catch (err) {
              console.error(`failed to clean up clip: ${err}`);
            }
          }
        }, 60000);
      } catch (error) {
        console.error('error creating/posting clip:', error);
        await message.reply(`failed to create clip (╬ಠ益ಠ)`);
      }
    } catch (error) {
      console.error('error handling clip command:', error);
      await message.reply('something broke (╯°□°）╯︵ ┻━┻');
    }
  }

  private async handleRandomFrameCommand(message: Message): Promise<void> {
    // ignore bot messages and messages that don't start with prefix
    if (message.author.bot || !message.content.startsWith(this.PREFIX_FRAME)) return;

    try {
      // extract search term (everything after the prefix and a space)
      const searchTerm = message.content.slice(this.PREFIX_FRAME.length).trim();
      
      const db = DatabaseManager.getInstance();
      let mediaItems = [];
      
      // if no search term, get random media that ends with .mp4
      if (!searchTerm) {
        // get multiple items to filter for mp4 files
        const allMedia = await db.getRandomMedia(undefined, undefined, undefined, 20);
        mediaItems = allMedia.filter(m => m.file_path.toLowerCase().endsWith('.mp4'));
        
        // if no mp4 files found in random selection, try again with more items
        if (mediaItems.length === 0) {
          const moreMedia = await db.getRandomMedia(undefined, undefined, undefined, 50);
          mediaItems = moreMedia.filter(m => m.file_path.toLowerCase().endsWith('.mp4'));
        }
        
        // shuffle the filtered items
        if (mediaItems.length > 1) {
          // fisher-yates shuffle
          for (let i = mediaItems.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [mediaItems[i], mediaItems[j]] = [mediaItems[j], mediaItems[i]];
          }
        }
        
        // take just one random mp4 file
        mediaItems = mediaItems.slice(0, 1);
      } else {
        // search for media with matching title
        const searchResults = await db.getMediaByTitle(searchTerm);
        // filter for mp4 files
        mediaItems = searchResults.filter(m => m.file_path.toLowerCase().endsWith('.mp4'));
      }
      
      if (mediaItems.length === 0) {
        await message.reply(`no mp4 video files found ${searchTerm ? `matching "${searchTerm}"` : ""} (￣︿￣)`);
        return;
      }
      
      // use the first (best) match
      const media = mediaItems[0];
      
      // prefer normalized path if available
      const filePath = media.normalized_path || media.file_path;
      
      // check if file exists
      if (!fs.existsSync(filePath)) {
        await message.reply(`media file doesn't exist on disk (╯°□°）╯︵ ┻━┻ id: ${media.id}`);
        return;
      }
      
      // get audio player to extract random frame
      const audioPlayer = (await import('./audioPlayerManager')).AudioPlayerManager.getInstance();
      
      // show typing indicator where it exists
      try {
        // use "as any" to bypass the type checking
        const channel = message.channel as any;
        if (channel.sendTyping) {
          await channel.sendTyping();
        }
      } catch (e) {
        // ignore error
      }
      
      try {
        // extract random frame using direct method (never returns null due to chance)
        const framePath = await audioPlayer.getRandomScreencapDirect(media.id, filePath);
        if (!framePath) {
          await message.reply(`failed to extract frame (╬ಠ益ಠ)`);
          return;
        }
        
        // post the frame
        const attachment = new AttachmentBuilder(framePath, { name: `frame_${media.id}.jpg` });
        await message.reply({ 
          content: `random frame from "${media.title}" (id: ${media.id}) (￣▽￣)`,
          files: [attachment] 
        });
        
        // cleanup temp file after a delay to ensure discord has time to process it
        setTimeout(() => {
          if (fs.existsSync(framePath)) {
            try {
              fs.unlinkSync(framePath);
            } catch (err) {
              console.error(`failed to clean up frame: ${err}`);
            }
          }
        }, 60000);
      } catch (error) {
        console.error('error extracting/posting frame:', error);
        await message.reply(`failed to extract frame (╬ಠ益ಠ)`);
      }
    } catch (error) {
      console.error('error handling frame command:', error);
      await message.reply('something broke (╯°□°）╯︵ ┻━┻');
    }
  }
}