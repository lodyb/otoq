import { 
  SlashCommandBuilder, 
  VoiceChannel,
  TextChannel,
  ThreadChannel,
  EmbedBuilder,
  Message,
  GuildMember,
  ChatInputCommandInteraction,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder
} from 'discord.js';
import { GameManager } from '../../utils/gameManager';
import { AudioPlayerManager } from '../../utils/audioPlayerManager';
import { MediaItem } from '../../utils/gameSession';

export const data = new SlashCommandBuilder()
  .setName('otoq')
  .setDescription('start an audio quiz game')
  .addIntegerOption(option => 
    option.setName('rounds')
      .setDescription('number of rounds (default: 20)')
      .setRequired(false)
      .setMinValue(1)
      .setMaxValue(50)
  )
  .addStringOption(option => 
    option.setName('tags')
      .setDescription('filter by tags (comma separated)')
      .setRequired(false)
  )
  .addIntegerOption(option => 
    option.setName('year-start')
      .setDescription('start year for filtering')
      .setRequired(false)
  )
  .addIntegerOption(option => 
    option.setName('year-end')
      .setDescription('end year for filtering')
      .setRequired(false)
  )
  .addBooleanOption(option =>
    option.setName('clip')
      .setDescription('play random 10s clips instead of full tracks')
      .setRequired(false)
  );

// hint generation
const HINT_PERCENTAGES = [0.25, 0.40, 0.55, 0.70, 0.85];

function getRandomEmoji(): string {
  const emojis = ['🔥', '🌟', '✨', '💫', '🎵', '🎶', '🎸', '🎹', '🎧', '🎤', '🎬', '📺', '💿', '🎮', '👾'];
  return emojis[Math.floor(Math.random() * emojis.length)];
}

function generateHint(title: string, percentToShow: number): string {
  const words = title.split(/\s+/);
  
  return words.map(word => {
    const emoji = getRandomEmoji();
    const charsToShow = Math.max(1, Math.ceil(word.length * percentToShow));
    const positions = new Set<number>([0]);
    
    while (positions.size < charsToShow && positions.size < word.length) {
      positions.add(Math.floor(Math.random() * word.length));
    }
    
    return word.split('').map((char, i) => 
      positions.has(i) ? char : emoji
    ).join('');
  }).join(' ');
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  
  const gameManager = GameManager.getInstance();
  const audioPlayer = AudioPlayerManager.getInstance();
  
  // track which media has already shown a screencap and which guild is in control of the session
  const mediaWithScreencapShown = new Set<number>();
  let isSessionActive = true;
  
  // check if user in voice channel
  const member = interaction.member as GuildMember;
  if (!member.voice.channel) {
    await interaction.editReply('you need to join a voice channel first baka');
    return;
  }
  
  const voiceChannel = member.voice.channel as VoiceChannel;
  const textChannel = interaction.channel as TextChannel | ThreadChannel;
  
  // check for existing game
  const session = gameManager.getSession(interaction.guildId!, textChannel.id, textChannel);
  if (session) {
    await interaction.editReply('theres already a game running in this channel (●´ω｀●)');
    return;
  }
  
  // get options
  const rounds = interaction.options.getInteger('rounds') || 20;
  const tagsOption = interaction.options.getString('tags');
  const tags = tagsOption ? tagsOption.toLowerCase().split(',').map(t => t.trim()) : undefined;
  const yearStart = interaction.options.getInteger('year-start');
  const yearEnd = interaction.options.getInteger('year-end');
  const clipMode = interaction.options.getBoolean('clip') || false;
  
  // create session
  const newSession = await gameManager.createSession(
    interaction.guildId!,
    textChannel.id,
    rounds,
    tags,
    yearStart || undefined,
    yearEnd || undefined,
    textChannel,
    clipMode
  );
  
  if (!newSession) {
    if (tags || yearStart || yearEnd) {
      await interaction.editReply('couldnt find enough media with those filters ¯\\_(ツ)_/¯');
    } else {
      await interaction.editReply('failed to create game (╯°□°）╯︵ ┻━┻ try again later');
    }
    return;
  }
  
  // join voice channel
  const joined = await audioPlayer.joinChannel(voiceChannel);
  if (!joined) {
    await interaction.editReply('failed to join voice channel (´；ω；`)');
    await gameManager.endSession(interaction.guildId!, textChannel.id, textChannel);
    return;
  }
  
  // setup hint handler
  audioPlayer.setOnHint(interaction.guildId!, async (mediaItem: MediaItem, hintLevel: number) => {
    try {
      // if session isn't active anymore, don't send hints
      if (!isSessionActive) return;

      // check if session still exists
      const currentSession = gameManager.getSession(interaction.guildId!, textChannel.id, textChannel);
      if (!currentSession) {
        isSessionActive = false;
        return;
      }
      
      // check if audio player still has a connection to this guild
      if (!audioPlayer.hasConnection(interaction.guildId!)) {
        isSessionActive = false;
        return;
      }
      
      // check if current media matches
      const currentMedia = currentSession.getCurrentMedia();
      if (!currentMedia || currentMedia.id !== mediaItem.id) return;
      
      // check if already guessed
      if (currentSession.isAnswerAlreadyGuessed(mediaItem.id)) return;
      
      // generate hint with appropriate percentage
      const percentage = HINT_PERCENTAGES[Math.min(hintLevel, HINT_PERCENTAGES.length - 1)];
      const hint = generateHint(mediaItem.title, percentage);
      
      // prepare hint message
      const hintNumber = hintLevel + 1;
      const messageText = hintLevel === 0 
        ? `heres hint #${hintNumber}: **${hint}**` 
        : `heres another hint (#${hintNumber}): **${hint}**`;
      
      // try to get screencap for video files, but only once per media item
      if (!mediaWithScreencapShown.has(mediaItem.id)) {
        mediaWithScreencapShown.add(mediaItem.id);
        
        const screencapPath = await audioPlayer.getRandomScreencap(mediaItem.id, mediaItem.file_path);
        
        if (screencapPath) {
          // send hint with image
          await textChannel.send({
            content: messageText,
            files: [screencapPath]
          });
        } else {
          // send text-only hint
          await textChannel.send(messageText);
        }
      } else {
        // send text-only hint
        await textChannel.send(messageText);
      }
    } catch (error) {
      console.error(`hint error: ${error}`);
    }
  });
  
  // setup end handler
  audioPlayer.setOnAudioEnd(interaction.guildId!, async () => {
    const currentSession = gameManager.getSession(interaction.guildId!, textChannel.id, textChannel);
    if (!currentSession) {
      isSessionActive = false;
      return;
    }
    
    const currentMedia = currentSession.getCurrentMedia();
    if (!currentMedia) {
      isSessionActive = false;
      return;
    }
    
    // create edit button
    const editButton = new ButtonBuilder()
      .setCustomId(`edit_answers_${currentMedia.id}`)
      .setLabel('edit answers')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('✏️');
    
    const row = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(editButton);
    
    // send timeout message
    await textChannel.send({
      content: `times up! the answer was: **${currentMedia.title}** (ID: #${currentMedia.id})`,
      components: [row]
    });
    
    // advance to next round
    const success = await gameManager.advanceRound(interaction.guildId!, textChannel.id, textChannel);
    
    if (!success) {
      collector.stop('game-end');
    }
  });
  
  // start first round
  const media = newSession.nextRound();
  if (!media) {
    await interaction.editReply('failed to start game (；￣Д￣)');
    await gameManager.endSession(interaction.guildId!, textChannel.id, textChannel);
    audioPlayer.leaveChannel(interaction.guildId!);
    isSessionActive = false;
    return;
  }
  
  const success = await audioPlayer.playMedia(interaction.guildId!, media, clipMode);
  if (!success) {
    await interaction.editReply('couldnt play audio (ノಠ益ಠ)ノ彡┻━┻');
    await gameManager.endSession(interaction.guildId!, textChannel.id, textChannel);
    audioPlayer.leaveChannel(interaction.guildId!);
    isSessionActive = false;
    return;
  }
  
  // create embed
  const embed = new EmbedBuilder()
    .setColor(0x0099FF)
    .setTitle('audio quiz started!')
    .setDescription(`round 1/${rounds} started! listen and type the name of the media in chat`)
    .setFooter({ text: 'type /otoqskip to vote to skip (need 2+ votes)' });
  
  if (tags) {
    embed.addFields({ name: 'filters', value: `tags: ${tags.join(', ')}` });
  }
  
  if (yearStart || yearEnd) {
    embed.addFields({ name: 'years', value: `${yearStart || 'any'} - ${yearEnd || 'any'}` });
  }
  
  if (clipMode) {
    embed.addFields({ name: 'mode', value: 'playing random 10s clips' });
  }
  
  // send public game message
  await textChannel.send({ embeds: [embed] });
  
  // reply to interaction
  await interaction.editReply('game started (≧▽≦)');
  
  // setup message collector for guesses
  const collector = textChannel.createMessageCollector({
    filter: (m: Message) => !m.author.bot
  });
  
  collector.on('collect', async (message: Message) => {
    const session = gameManager.getSession(interaction.guildId!, textChannel.id, textChannel);
    if (!session) {
      collector.stop();
      return;
    }
    
    const result = await gameManager.processGuess(
      interaction.guildId!,
      textChannel.id,
      message.author.id,
      message.author.username,
      message.content,
      textChannel
    );
    
    if (result.correct) {
      await message.react('✅');
      
      const currentMedia = session.getCurrentMedia()!;
      console.log(`🎮 CORRECT: ${message.author.username} guessed "${message.content}" for #${currentMedia.id}`);
      
      // create edit button
      const editButton = new ButtonBuilder()
        .setCustomId(`edit_answers_${currentMedia.id}`)
        .setLabel('edit answers')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('✏️');
      
      const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(editButton);
      
      await textChannel.send({
        content: `${message.author} got it right! the answer was: **${currentMedia.title}** (ID: #${currentMedia.id})`,
        components: [row]
      });
      
      if (session.isLastRound()) {
        collector.stop('game-end');
        return;
      }
      
      // advance to next round
      const success = await gameManager.advanceRound(
        interaction.guildId!,
        textChannel.id,
        textChannel,
        message.author.id,
        message.author.username
      );
      
      if (!success) {
        collector.stop('game-end');
      }
    } else if (result.close) {
      await message.react('🤏');
      
      // add text feedback for close guesses
      const randomResponses = [
        'youre super close!',
        'almost there!',
        'so close it hurts (＃￣ω￣)',
        'nngh thats really close',
        'just a bit off!',
        'youre practically there ノಠ益ಠ)ノ'
      ];
      const response = randomResponses[Math.floor(Math.random() * randomResponses.length)];
      await message.reply({ content: response, allowedMentions: { repliedUser: false }});
    }
  });
  
  collector.on('end', async (collected, reason) => {
    try {
      console.log(`game ended: ${reason}`);
      isSessionActive = false;
      
      const session = gameManager.getSession(interaction.guildId!, textChannel.id, textChannel);
      if (session) {
        const leaderboard = session.getLeaderboard();
        
        const embed = new EmbedBuilder()
          .setColor(0x0099FF)
          .setTitle('game ended')
          .setDescription(
            leaderboard.length > 0 && leaderboard[0].score > 0
              ? 'final leaderboard:'
              : 'no one scored any points (￣へ￣)'
          );
        
        if (leaderboard.length > 0 && leaderboard[0].score > 0) {
          leaderboard.slice(0, 10).forEach((player, index) => {
            embed.addFields({ name: `#${index + 1}: ${player.username}`, value: `score: ${player.score}` });
          });
        }
        
        await textChannel.send({ embeds: [embed] });
        await gameManager.endSession(interaction.guildId!, textChannel.id, textChannel);
      }
      
      // cleanup
      audioPlayer.leaveChannel(interaction.guildId!);
    } catch (error) {
      console.error(`error ending game: ${error}`);
      await textChannel.send('error ending game (╯°□°）╯︵ ┻━┻');
      audioPlayer.leaveChannel(interaction.guildId!);
    }
  });
}