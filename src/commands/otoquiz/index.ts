import { 
  SlashCommandBuilder, 
  ChatInputCommandInteraction
} from 'discord.js';
import { execute as otoqExecute } from '../otoq/index';

export const data = new SlashCommandBuilder()
  .setName('otoquiz')
  .setDescription('Start an audio quiz game (alias for /otoq)')
  .addIntegerOption(option => 
    option.setName('rounds')
      .setDescription('Number of rounds (default: 20)')
      .setRequired(false)
      .setMinValue(1)
      .setMaxValue(50)
  )
  .addStringOption(option => 
    option.setName('tags')
      .setDescription('Filter by tags (comma separated)')
      .setRequired(false)
  )
  .addIntegerOption(option => 
    option.setName('year-start')
      .setDescription('Start year for filtering')
      .setRequired(false)
  )
  .addIntegerOption(option => 
    option.setName('year-end')
      .setDescription('End year for filtering')
      .setRequired(false)
  );

// this is just an alias that calls the original command
export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  return otoqExecute(interaction);
}