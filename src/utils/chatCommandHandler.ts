import { 
  Message, 
  AttachmentBuilder
} from 'discord.js';
import { DatabaseManager } from '../database/databaseManager';
import { GameManager } from './gameManager';
import path from 'path';
import fs from 'fs';

export class ChatCommandHandler {
  private static instance: ChatCommandHandler;
  private PREFIX = '..o';
  private PREFIX_PREV = '..op';

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
      const session = gameManager.getSession(guildId, channelId, message.channel);
      
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
      
      // check if file exists
      if (!fs.existsSync(prevMedia.file_path)) {
        await message.reply(`media file doesn't exist on disk (╯°□°）╯︵ ┻━┻ id: ${prevMedia.id}`);
        return;
      }
      
      // post the file
      try {
        const attachment = new AttachmentBuilder(prevMedia.file_path, { name: path.basename(prevMedia.file_path) });
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
      
      // if no search term, just ignore
      if (!searchTerm) return;
      
      // typing indicator removed - was causing typescript errors
      
      // search for media with matching title
      const db = DatabaseManager.getInstance();
      const mediaItems = await db.getMediaByTitle(searchTerm);
      
      if (mediaItems.length === 0) {
        await message.reply(`no media found matching "${searchTerm}" (￣︿￣)`);
        return;
      }
      
      // use the first (best) match
      const media = mediaItems[0];
      
      // check if file exists
      if (!fs.existsSync(media.file_path)) {
        await message.reply(`media file doesn't exist on disk (╯°□°）╯︵ ┻━┻ id: ${media.id}`);
        return;
      }
      
      // post the file
      try {
        const attachment = new AttachmentBuilder(media.file_path, { name: path.basename(media.file_path) });
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
}