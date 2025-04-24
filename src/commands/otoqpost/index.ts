import { 
  SlashCommandBuilder, 
  AttachmentBuilder,
  ChatInputCommandInteraction
} from 'discord.js';
import { DatabaseManager } from '../../database/databaseManager';
import { MediaItem } from '../../utils/gameSession';
import path from 'path';
import fs from 'fs';

export const data = new SlashCommandBuilder()
  .setName('otoqpost')
  .setDescription('post media file directly in text channel by id or title')
  .addIntegerOption(option => 
    option.setName('id')
      .setDescription('media id to post')
      .setRequired(false)
  )
  .addStringOption(option => 
    option.setName('title')
      .setDescription('title to search for')
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: false });
  
  const db = DatabaseManager.getInstance();
  
  const id = interaction.options.getInteger('id');
  const title = interaction.options.getString('title');
  
  let media: MediaItem | null = null;
  
  if (id) {
    const mediaById = await db.getMediaById(id);
      
    if (!mediaById || mediaById.length === 0) {
      await interaction.editReply({ content: 'Media not found (￣ヘ￣)' });
      return;
    }
      
    media = mediaById[0]; // Extract first item from the array
  } else if (title) {
    const mediaItems = await db.getMediaByTitle(title);
    if (mediaItems.length > 0) {
      media = mediaItems[0];
    }
  } else {
    // get random media if no id or title provided
    const randomMedia = await db.getRandomMedia(1);
    if (randomMedia.length > 0) {
      media = randomMedia[0];
    }
  }
  
  if (!media) {
    await interaction.editReply(`no media found... try another id or title`);
    return;
  }
  
  // prefer normalized path if available
  const filePath = media.normalized_path || media.file_path;
  
  if (!fs.existsSync(filePath)) {
    await interaction.editReply(`media file doesn't exist on disk (╯°□°）╯︵ ┻━┻ id: ${media.id}`);
    return;
  }
  
  try {
    const attachment = new AttachmentBuilder(filePath, { name: path.basename(filePath) });
    await interaction.editReply({ files: [attachment] });
  } catch (error) {
    console.error('error posting media:', error);
    await interaction.editReply(`failed to post media file (╬ಠ益ಠ) check if file is too large`);
  }
}