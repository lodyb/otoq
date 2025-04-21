import { 
  SlashCommandBuilder, 
  ChatInputCommandInteraction,
  TextChannel,
  ThreadChannel,
  GuildMember
} from 'discord.js';
import { GameManager } from '../../utils/gameManager';
import { AudioPlayerManager } from '../../utils/audioPlayerManager';

export const data = new SlashCommandBuilder()
  .setName('otoqskip')
  .setDescription('vote to skip the current quiz round');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  
  const gameManager = GameManager.getInstance();
  const audioPlayer = AudioPlayerManager.getInstance();
  
  // check if user is in voice channel
  const member = interaction.member as GuildMember;
  if (!member.voice.channel) {
    await interaction.editReply('join the voice channel first baka');
    return;
  }
  
  const textChannel = interaction.channel as TextChannel | ThreadChannel;
  
  // check for active game
  const session = gameManager.getSession(interaction.guildId!, textChannel.id, textChannel);
  if (!session) {
    await interaction.editReply('no game running in this channel (￢_￢)');
    return;
  }
  
  // check if already guessed
  const currentMedia = session.getCurrentMedia();
  if (currentMedia && session.isAnswerAlreadyGuessed(currentMedia.id)) {
    await interaction.editReply('this round is already completed (￣ヘ￣)');
    return;
  }
  
  // process skip vote
  const result = await gameManager.processSkip(
    interaction.guildId!, 
    textChannel.id, 
    interaction.user.id, 
    textChannel
  );
  
  if (result.skipped) {
    await interaction.editReply(`round skipped`);
    
    // send public message
    await textChannel.send(`round skipped! answer was: **${currentMedia?.title}**`);
    
    // stop playback
    audioPlayer.stopPlaying(interaction.guildId!);
    
    // advance round 
    const success = await gameManager.advanceRound(
      interaction.guildId!, 
      textChannel.id, 
      textChannel
    );
    
    if (!success) {
      // handled by collector in otoq command
    }
  } else {
    await interaction.editReply(`skip vote registered! ${result.votes}/${result.required} votes needed`);
  }
}