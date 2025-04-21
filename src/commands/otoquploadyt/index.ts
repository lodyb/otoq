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
import { exec } from 'child_process';
import { promisify } from 'util';

const execPromise = promisify(exec);

dotenv.config();

const MEDIA_DIR = process.env.MEDIA_DIR || path.join(process.cwd(), 'src/media');

export const data = new SlashCommandBuilder()
  .setName('otoquyt')
  .setDescription('Add a YouTube video to the quiz')
  .addStringOption(option => 
    option.setName('url')
      .setDescription('YouTube URL to download')
      .setRequired(true)
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const youtubeUrl = interaction.options.getString('url');
  
  // Validate URL
  if (!youtubeUrl) {
    await interaction.reply({ content: 'you didn\'t provide a YouTube URL', ephemeral: true });
    return;
  }
  
  // Simple URL validation
  if (!youtubeUrl.match(/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)/)) {
    await interaction.reply({ content: 'that doesn\'t look like a valid YouTube URL baka!', ephemeral: true });
    return;
  }
  
  await interaction.deferReply({ ephemeral: true });
  
  try {
    // Check if yt-dlp is installed
    try {
      await execPromise('yt-dlp --version');
    } catch (error) {
      await interaction.editReply('yt-dlp is not installed. Please install it first with `npm install -g yt-dlp` or `pip install yt-dlp` (╯°□°）╯︵ ┻━┻');
      return;
    }
    
    // Create media directory if it doesn't exist
    if (!fs.existsSync(MEDIA_DIR)) {
      fs.mkdirSync(MEDIA_DIR, { recursive: true });
    }
    
    // Get video info to pre-populate the answer field
    await interaction.editReply('fetching video info... (￣ー￣)ゞ');
    
    let videoInfo;
    try {
      videoInfo = await getYoutubeVideoInfo(youtubeUrl);
    } catch (error) {
      await interaction.editReply(`failed to get YouTube info: ${error.message} (╯°□°）╯︵ ┻━┻`);
      return;
    }
    
    const videoTitle = videoInfo.title || 'Unknown Title';
    
    const modal = new ModalBuilder()
      .setCustomId('youtube-modal')
      .setTitle('youtube info');
    
    const answersInput = new TextInputBuilder()
      .setCustomId('answers')
      .setLabel('answers (1 per line)')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setValue(videoTitle)
      .setPlaceholder('primary answer (first line)\nalt answer 1\nalt answer 2\netc');
    
    modal.addComponents(
      new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(answersInput)
    );
    
    await interaction.editReply('video found! please fill in the answers ヾ(＠⌒ー⌒＠)ノ');
    
    // Store YouTube URL for use in modal submit
    interaction.client.once('interactionCreate', async (modalInteraction: any) => {
      if (!modalInteraction.isModalSubmit() || modalInteraction.customId !== 'youtube-modal') return;
      
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
        await modalInteraction.editReply('downloading from YouTube... this might take a bit (￣ー￣)ゞ');
        
        // Download YouTube video (not just audio)
        const fileName = `yt_${Date.now()}.mp4`;
        const filePath = path.join(MEDIA_DIR, fileName);
        
        await downloadYoutubeVideo(youtubeUrl, filePath);
        
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
          const normalizedFileName = `norm_yt_${Date.now()}.mp4`;
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
                  
                  // now normalize with the calculated adjustment while preserving video
                  ffmpeg(filePath)
                    .audioFilters(`volume=${adjustment}dB`)
                    .videoCodec('copy')  // Copy video stream without re-encoding
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
            .setTitle('youtube download successful')
            .setDescription(`added **${title}** (ID: ${mediaId}) to the quiz database`)
            .addFields(
              { name: 'source', value: youtubeUrl },
              { name: 'alternative answers', value: altAnswers.length > 0 ? altAnswers.join(', ') : 'none' }
            );
          
          await modalInteraction.editReply({ embeds: [embed] });
        } catch (error) {
          console.error('Normalization error:', error);
          await modalInteraction.editReply(`failed during normalization: ${error} (╯°□°）╯︵ ┻━┻`);
        }
      } catch (error) {
        console.error('YouTube download error:', error);
        await modalInteraction.editReply('failed to download from YouTube, check logs for details (╯°□°）╯︵ ┻━┻');
      }
    });
    
    await interaction.deleteReply();
    await interaction.showModal(modal);
    
  } catch (error) {
    console.error('YouTube info error:', error);
    await interaction.editReply(`failed to process YouTube request: ${error.message} (╯°□°）╯︵ ┻━┻`);
  }
}

async function getYoutubeVideoInfo(url: string): Promise<{ title: string }> {
  try {
    const { stdout } = await execPromise(
      `yt-dlp --skip-download --print-json "${url}"`
    );
    const info = JSON.parse(stdout);
    return { title: info.title };
  } catch (error) {
    console.error('Error getting YouTube info:', error);
    // Check if the error is due to missing yt-dlp
    if ((error as any).message?.includes('command not found')) {
      throw new Error('yt-dlp is not installed. Please install it first.');
    }
    throw new Error(`Failed to get video info: ${error.message}`);
  }
}

async function downloadYoutubeVideo(url: string, outputPath: string): Promise<void> {
  try {
    // Download video with audio, limit duration to 10 minutes and file size to 20MB
    await execPromise(
      `yt-dlp -f "bestvideo[height<=720]+bestaudio/best[height<=720]" ` +
      `--max-filesize 20m --match-filter "duration < 600" ` +
      `-o "${outputPath}" "${url}"`
    );
  } catch (error) {
    console.error('Error downloading YouTube video:', error);
    // Check if the error is related to video duration or file size
    if ((error as any).message?.includes('exceeds --max-filesize')) {
      throw new Error('Video exceeds maximum file size limit (20MB)');
    } else if ((error as any).message?.includes('does not pass filter')) {
      throw new Error('Video exceeds maximum duration limit (10 minutes)');
    }
    throw new Error(`Failed to download: ${error.message}`);
  }
}
