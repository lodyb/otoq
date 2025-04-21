import { 
  SlashCommandBuilder, 
  ChatInputCommandInteraction,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ModalActionRowComponentBuilder
} from 'discord.js';
import { DatabaseManager } from '../../database/databaseManager';
import { AudioPlayerManager } from '../../utils/audioPlayerManager';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const MEDIA_DIR = process.env.MEDIA_DIR || path.join(process.cwd(), 'src/media');

export const data = new SlashCommandBuilder()
  .setName('otoqupload')
  .setDescription('Upload a media clip for the quiz')
  .addAttachmentOption(option => 
    option.setName('media')
      .setDescription('Media file to upload (.mp3/.mp4/.wav/.flac/.mov/.wmv/.ogg/.m4a)')
      .setRequired(true)
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const attachment = interaction.options.getAttachment('media');
  
  // Validate attachment
  if (!attachment) {
    await interaction.reply({ content: 'you didn\'t provide a media file', ephemeral: true });
    return;
  }
  
  // Accept audio and video files
  const validTypes = [
    'audio/', 'video/',
    'application/ogg', 'application/octet-stream'
  ];
  
  const isValidType = validTypes.some(type => 
    attachment.contentType?.startsWith(type) || 
    isValidMediaExtension(attachment.name)
  );
  
  if (!isValidType) {
    await interaction.reply({ content: 'that\'s not a valid media file baka! i need audio/video files like mp3, mp4, wav, m4a, flac, etc', ephemeral: true });
    return;
  }
  
  // Create media directory if it doesn't exist
  if (!fs.existsSync(MEDIA_DIR)) {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
  }
  
  // Get filename without extension to pre-populate the answer field
  const fileNameWithoutExt = path.parse(attachment.name).name
    .replace(/_/g, ' ')
    .replace(/-/g, ' ');
  
  const modal = new ModalBuilder()
    .setCustomId('upload-modal')
    .setTitle('media info');
  
  const answersInput = new TextInputBuilder()
    .setCustomId('answers')
    .setLabel('answers (1 per line)')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setValue(fileNameWithoutExt)
    .setPlaceholder('primary answer (first line)\nalt answer 1\nalt answer 2\netc');
  
  modal.addComponents(
    new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(answersInput)
  );
  
  // Store attachment URL for use in modal submit
  interaction.client.once('interactionCreate', async (modalInteraction: any) => {
    if (!modalInteraction.isModalSubmit() || modalInteraction.customId !== 'upload-modal') return;
    
    await modalInteraction.deferReply({ ephemeral: true });
    
    const answersStr = modalInteraction.fields.getTextInputValue('answers');
    const answers = answersStr.split(/[\n,]/)
                              .map((ans: string) => ans.trim())
                              .filter((ans: string) => ans.length > 0);
    
    if (answers.length === 0) {
      await modalInteraction.editReply('you need to provide at least one answer (￣ヘ￣)');
      return;
    }
    
    const title = answers[0];
    const altAnswers = answers.slice(1);
    
    try {
      // Download file
      const response = await fetch(attachment.url);
      if (!response.ok) {
        throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
      }
      
      const buffer = await response.arrayBuffer();
      const fileName = `${Date.now()}_${attachment.name}`;
      const filePath = path.join(MEDIA_DIR, fileName);
      
      fs.writeFileSync(filePath, Buffer.from(buffer));
      
      await modalInteraction.editReply('downloaded file, normalizing volume... this might take a sec (￣ー￣)ゞ');
      
      // Normalize audio on upload
      try {
        const audioPlayer = AudioPlayerManager.getInstance();
        const normalizedDir = path.join(MEDIA_DIR, 'normalized');
        
        // ensure normalized directory exists
        if (!fs.existsSync(normalizedDir)) {
          fs.mkdirSync(normalizedDir, { recursive: true });
        }
        
        // analyze volume and create normalized file
        const normalizedFileName = `norm_${Date.now()}_${attachment.name}`;
        const normalizedPath = path.join(normalizedDir, normalizedFileName);
        
        // normalize with ffmpeg
        await new Promise<void>((resolve, reject) => {
          const ffmpeg = require('fluent-ffmpeg');
          
          // first analyze the volume
          ffmpeg.ffprobe(filePath, (err: any, metadata: any) => {
            if (err) {
              reject(new Error(`Failed to analyze media: ${err.message}`));
              return;
            }
            
            // get duration in ms
            const durationMs = Math.floor((metadata?.format?.duration || 0) * 1000);
            
            // analyze volume
            ffmpeg(filePath)
              .audioFilters('volumedetect')
              .format('null')
              .output('/dev/null')
              .on('error', (err: any) => reject(new Error(`Volume analysis failed: ${err.message}`)))
              .on('end', (stdout: any, stderr: any) => {
                const match = stderr.match(/max_volume: ([-\d.]+) dB/);
                if (!match || !match[1]) {
                  reject(new Error('Could not detect volume level'));
                  return;
                }
                
                const maxVolume = parseFloat(match[1]);
                const targetVolume = -3; // target peak volume in dB
                const adjustment = targetVolume - maxVolume;
                
                // now normalize with the calculated adjustment
                ffmpeg(filePath)
                  .audioFilters(`volume=${adjustment}dB`)
                  .output(normalizedPath)
                  .on('error', (err: any) => reject(new Error(`Normalization failed: ${err.message}`)))
                  .on('end', () => {
                    // store the duration for future use
                    audioPlayer.storeMediaDuration(1, durationMs); // temp ID, will update after DB insert
                    resolve();
                  })
                  .run();
              })
              .run();
          });
        });
      
        // Add to database
        const db = DatabaseManager.getInstance();
        const mediaId = await db.addMedia(title, filePath);
        
        // Update the normalized path in database
        await db.updateNormalizedPath(mediaId, normalizedPath);
        
        // Store the duration with correct ID
        const duration = await new Promise<number>((resolve) => {
          const ffmpeg = require('fluent-ffmpeg');
          ffmpeg.ffprobe(filePath, (err: any, metadata: any) => {
            resolve(Math.floor((metadata?.format?.duration || 0) * 1000));
          });
        });
        audioPlayer.storeMediaDuration(mediaId, duration);
        
        // Add primary answer
        await db.addPrimaryAnswer(mediaId, title);
        
        // Add alternative answers
        for (const alt of altAnswers) {
          await db.addAlternativeAnswer(mediaId, alt);
        }
        
        const embed = new EmbedBuilder()
          .setColor(0x00FF00)
          .setTitle('upload successful')
          .setDescription(`added **${title}** (ID: ${mediaId}) to the quiz database`)
          .addFields(
            { name: 'alternative answers', value: altAnswers.length > 0 ? altAnswers.join(', ') : 'none' }
          );
        
        await modalInteraction.editReply({ embeds: [embed] });
      } catch (error) {
        console.error('Normalization error:', error);
        await modalInteraction.editReply(`failed during normalization: ${error} (╯°□°）╯︵ ┻━┻`);
      }
    } catch (error) {
      console.error('Upload error:', error);
      await modalInteraction.editReply('failed to upload media, check logs for details (╯°□°）╯︵ ┻━┻');
    }
  });
  
  await interaction.showModal(modal);
}

function isValidMediaExtension(fileName: string): boolean {
  const validExtensions = ['.mp3', '.mp4', '.m4a', '.wav', '.flac', '.mov', '.wmv', '.ogg'];
  const extension = path.extname(fileName).toLowerCase();
  return validExtensions.includes(extension);
}
