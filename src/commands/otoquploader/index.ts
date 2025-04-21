import { 
  SlashCommandBuilder, 
  ChatInputCommandInteraction,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder
} from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('otoquploader')
  .setDescription('get link to web uploader for batch uploading');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const port = process.env.WEB_PORT || 3000;
  const serverHost = process.env.WEB_HOST || '0.0.0.0'; // use public ip by default
  const url = `http://${serverHost}:${port}`;
  
  const embed = new EmbedBuilder()
    .setColor(0x0099FF)
    .setTitle('otoq web uploader')
    .setDescription('use the web uploader to batch upload multiple files (⌐■_■)')
    .addFields(
      { name: 'functionality', value: 'drag and drop multiple files, add answers for each, upload individually' }
    );
  
  const button = new ButtonBuilder()
    .setLabel('open web uploader')
    .setURL(url)
    .setStyle(ButtonStyle.Link);
  
  const row = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(button);
  
  await interaction.reply({ 
    embeds: [embed], 
    components: [row],
    ephemeral: true 
  });
}