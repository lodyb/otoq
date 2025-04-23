import { 
  Message, 
  AttachmentBuilder
} from 'discord.js';
import { DatabaseManager } from '../database/databaseManager';
import path from 'path';
import fs from 'fs';

export class ChatCommandHandler {
  private static instance: ChatCommandHandler;
  private PREFIX = '..o';

  private constructor() {}

  public static getInstance(): ChatCommandHandler {
    if (!ChatCommandHandler.instance) {
      ChatCommandHandler.instance = new ChatCommandHandler();
    }
    return ChatCommandHandler.instance;
  }

  public async handleMessage(message: Message): Promise<void> {
    // ignore bot messages and messages that don't start with prefix
    if (message.author.bot || !message.content.startsWith(this.PREFIX)) return;

    try {
      // extract search term (everything after the prefix and a space)
      const searchTerm = message.content.slice(this.PREFIX.length).trim();
      
      // if no search term, just ignore
      if (!searchTerm) return;
      
      // show typing indicator while processing
      await message.channel.sendTyping();
      
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