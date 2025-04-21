import { 
  SlashCommandBuilder, 
  CommandInteraction,
  VoiceChannel,
  EmbedBuilder,
  GuildMember,
  ChatInputCommandInteraction
} from 'discord.js';
import { AudioPlayerManager } from '../../utils/audioPlayerManager';
import { DatabaseManager } from '../../database/databaseManager';
import { MediaItem } from '../../utils/gameSession';

export const data = new SlashCommandBuilder()
  .setName('otoqplay')
  .setDescription('play specific media by title')
  .addStringOption(option => 
    option.setName('title')
      .setDescription('title to search for')
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  
  const db = DatabaseManager.getInstance();
  const audioPlayer = AudioPlayerManager.getInstance();
  
  const title = interaction.options.getString('title');
  
  const member = interaction.member as GuildMember;
  if (!member.voice.channel) {
    await interaction.editReply('join a voice channel first ヽ(｀⌒´)ﾉ');
    return;
  }
  
  const voiceChannel = member.voice.channel as VoiceChannel;
  
  let media: MediaItem;
  
  if (title) {
    const mediaItems = await db.getMediaByTitle(title);
    if (mediaItems.length > 0) {
      media = mediaItems[0];
    } else {
      await interaction.editReply(`no media found with title "${title}"`);
      return;
    }
  } else {
    // get random media if no title provided
    const randomMedia = await db.getRandomMedia(undefined, undefined, undefined, 1);
    if (randomMedia.length > 0) {
      media = randomMedia[0];
    } else {
      await interaction.editReply('no media found in database... upload some first baka');
      return;
    }
  }
  
  const joined = await audioPlayer.joinChannel(voiceChannel);
  if (!joined) {
    await interaction.editReply('failed to join voice channel (╯°□°）╯︵ ┻━┻');
    return;
  }
  
  const played = await audioPlayer.playMedia(interaction.guildId!, media);
  if (!played) {
    await interaction.editReply('failed to play media (╬ಠ益ಠ)');
    audioPlayer.leaveChannel(interaction.guildId!);
    return;
  }
  
  const embed = new EmbedBuilder()
    .setColor(0x0099FF)
    .setTitle('playing media')
    .setDescription(`now playing: **${media.title}**`);
  
  await interaction.editReply({ embeds: [embed] });
  
  setTimeout(() => {
    audioPlayer.leaveChannel(interaction.guildId!);
  }, 60000);
}