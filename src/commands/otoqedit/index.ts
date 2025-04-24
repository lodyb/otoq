import { 
  SlashCommandBuilder, 
  ChatInputCommandInteraction,
  EmbedBuilder,
  ButtonBuilder, 
  ButtonStyle,
  ActionRowBuilder 
} from 'discord.js';
import { DatabaseManager } from '../../database/databaseManager';
import path from 'path';

export const data = new SlashCommandBuilder()
  .setName('otoqedit')
  .setDescription('edit media answers')
  .addSubcommand(subcommand =>
    subcommand
      .setName('list')
      .setDescription('list answers for a media')
      .addIntegerOption(option => option.setName('id').setDescription('media id').setRequired(true))
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('add')
      .setDescription('add new answer to a media')
      .addIntegerOption(option => option.setName('id').setDescription('media id').setRequired(true))
      .addStringOption(option => option.setName('answer').setDescription('new answer to add').setRequired(true))
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('remove')
      .setDescription('remove an answer from a media')
      .addIntegerOption(option => option.setName('media_id').setDescription('media id').setRequired(true))
      .addIntegerOption(option => option.setName('answer_id').setDescription('answer id to remove').setRequired(true))
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  
  const db = DatabaseManager.getInstance();
  const subcommand = interaction.options.getSubcommand();
  
  if (subcommand === 'list') {
    const mediaId = interaction.options.getInteger('id');
    
    try {
      const mediaData = await db.getMediaById(mediaId || 0);
      
      if (!mediaData || mediaData.length === 0) {
        await interaction.editReply({ content: 'Media not found (￣ヘ￣)' });
        return;
      }
      
      const media = mediaData[0]; // Extract first item from the array
      
      const answers = await db.getMediaAnswers(mediaId!);
      
      const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle(`answers for media #${mediaId}`)
        .setDescription(`${media.title} (${path.basename(media.file_path)})`)
        .addFields(
          { name: 'metadata', value: media.metadata || 'none' }
        );
      
      if (answers.length > 0) {
        answers.forEach(answer => {
          embed.addFields({ 
            name: `${answer.id}: ${answer.is_primary ? '(primary)' : '(alternative)'}`,
            value: answer.answer
          });
        });
      } else {
        embed.addFields({ name: 'no answers found', value: 'use /otoqedit add to add answers' });
      }
      
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error('Error listing answers:', error);
      await interaction.editReply('error listing answers (╯°□°）╯︵ ┻━┻');
    }
  } 
  else if (subcommand === 'add') {
    const mediaId = interaction.options.getInteger('id');
    const answer = interaction.options.getString('answer');
    
    try {
      const mediaData = await db.getMediaById(mediaId || 0);
      
      if (!mediaData || mediaData.length === 0) {
        await interaction.editReply({ content: 'Media not found (￣ヘ￣)' });
        return;
      }
      
      const media = mediaData[0]; // Extract first item from the array
      
      const answerId = await db.addAlternativeAnswer(mediaId!, answer!);
      
      await interaction.editReply(`added answer "${answer}" to media #${mediaId} ヽ(・∀・)ﾉ`);
    } catch (error) {
      console.error('Error adding answer:', error);
      await interaction.editReply('error adding answer (╯°□°）╯︵ ┻━┻');
    }
  }
  else if (subcommand === 'remove') {
    const mediaId = interaction.options.getInteger('media_id');
    const answerId = interaction.options.getInteger('answer_id');
    
    try {
      const mediaData = await db.getMediaById(mediaId || 0);
      
      if (!mediaData || mediaData.length === 0) {
        await interaction.editReply({ content: 'Media not found (￣ヘ￣)' });
        return;
      }
      
      const media = mediaData[0]; // Extract first item from the array
      
      const success = await db.deleteMediaAnswer(answerId!);
      
      if (success) {
        await interaction.editReply(`deleted answer #${answerId} from media #${mediaId} (￣ー￣)ゞ`);
      } else {
        await interaction.editReply(`couldn't find answer #${answerId} for media #${mediaId} ¯\\_(ツ)_/¯`);
      }
    } catch (error) {
      console.error('Error removing answer:', error);
      await interaction.editReply('error removing answer (╯°□°）╯︵ ┻━┻');
    }
  }
}