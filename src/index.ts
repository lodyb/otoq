import {
  Client,
  GatewayIntentBits,
  Collection,
  Events,
  REST,
  Routes,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ModalSubmitInteraction
} from 'discord.js';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { DatabaseManager } from './database/databaseManager';
import { startServer } from './web/server';

dotenv.config();

// check if guild id is provided for dev mode
const DEV_MODE = !!process.env.DISCORD_GUILD_ID;
if (DEV_MODE) console.log('running in dev mode with guild id', process.env.DISCORD_GUILD_ID, '(￣▽￣)V');

interface Command {
  data: any;
  execute: (interaction: any) => Promise<void>;
}

interface ClientWithCommands extends Client {
  commands?: Collection<string, Command>;
}

async function main() {
  if (!process.env.DISCORD_TOKEN || !process.env.DISCORD_CLIENT_ID) {
    console.error('missing DISCORD_TOKEN or DISCORD_CLIENT_ID in .env file (≖_≖ )');
    process.exit(1);
  }

  // init db
  const db = DatabaseManager.getInstance();
  await db.init();
  console.log('db initialized');
  
  // start web server
  try {
    await startServer();
  } catch (error) {
    console.error('failed to start web server:', error);
    // continue anyway, discord bot can still work
  }

  // create client
  const client: ClientWithCommands = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  // load commands
  client.commands = new Collection();
  const commandsPath = path.join(__dirname, 'commands');
  const commandFolders = fs.readdirSync(commandsPath);

  for (const folder of commandFolders) {
    const folderPath = path.join(commandsPath, folder);
    if (fs.statSync(folderPath).isDirectory()) {
      const commandPath = path.join(folderPath, 'index.js');
      if (fs.existsSync(commandPath)) {
        const command = require(commandPath);
        if ('data' in command && 'execute' in command) {
          client.commands.set(command.data.name, command);
        }
      }
    }
  }

  // deploy commands
  const commands = Array.from(client.commands.values()).map(command => command.data.toJSON());
  const rest = new REST().setToken(process.env.DISCORD_TOKEN);

  try {
    console.log('deleting old commands first...');
    
    // delete ALL commands to prevent duplicates regardless of mode
    // delete global commands
    await rest.put(
      Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
      { body: [] }
    );
    console.log('deleted all global commands!');
    
    // also delete guild commands if a guild id exists
    if (process.env.DISCORD_GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
        { body: [] }
      );
      console.log('deleted all guild commands too! (╯°□°）╯︵ ┻━┻');
    }

    console.log('registering slash commands...');
    
    // use guild commands in dev mode for instant updates
    if (DEV_MODE && process.env.DISCORD_GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
        { body: commands }
      );
      console.log('commands registered to guild for dev mode! (ﾉ◕ヮ◕)ﾉ*:･ﾟ✧');
    } else {
      // global commands for production (takes up to an hour to update)
      await rest.put(
        Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
        { body: commands }
      );
      console.log('commands registered globally!');
    }
  } catch (error) {
    console.error('error registering commands:', error);
  }

  // handle command interactions
  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand()) {
      const command = client.commands?.get(interaction.commandName);
      if (!command) return;

      try {
        await command.execute(interaction);
      } catch (error) {
        console.error(`error executing command ${interaction.commandName}:`, error);
        const content = 'error running command... something broke (╯°□°）╯︵ ┻━┻';
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content, ephemeral: true });
        } else {
          await interaction.reply({ content, ephemeral: true });
        }
      }
    } else if (interaction.isButton()) {
      try {
        // handle edit answers button
        if (interaction.customId.startsWith('edit_answers_')) {
          const mediaId = parseInt(interaction.customId.split('_').pop() || '0');
          if (!mediaId) {
            await interaction.reply({ content: 'invalid button id ಠ_ಠ', ephemeral: true });
            return;
          }
          
          const db = DatabaseManager.getInstance();
          
          try {
            // get media and answers
            const media = await db.getMediaById(mediaId);
            if (!media) {
              await interaction.reply({ content: `media #${mediaId} not found, wtf? (╯°□°）╯︵ ┻━┻`, ephemeral: true });
              return;
            }
            
            const answers = await db.getMediaAnswers(mediaId);
            
            // build modal with answers in a textarea
            const modal = new ModalBuilder()
              .setCustomId(`edit_answers_modal_${mediaId}`)
              .setTitle(`Edit Answers for ${media.title}`);
            
            // combine answers into a single string
            let answersText = '';
            
            // primary answer first
            const primaryAnswer = answers.find(a => a.is_primary);
            if (primaryAnswer) {
              answersText += primaryAnswer.answer;
            } else {
              // use title as primary if no primary answer exists
              answersText += media.title;
            }
            
            // then alternatives
            const altAnswers = answers.filter(a => !a.is_primary);
            if (altAnswers.length > 0) {
              answersText += '\n' + altAnswers.map(a => a.answer).join('\n');
            }
            
            // create textarea input - one line per answer
            const answersInput = new TextInputBuilder()
              .setCustomId('answers')
              .setLabel('Answers (one per line, first line is primary)')
              .setStyle(TextInputStyle.Paragraph)
              .setValue(answersText)
              .setRequired(true);
              
            const answersRow = new ActionRowBuilder<TextInputBuilder>().addComponents(answersInput);
            modal.addComponents(answersRow);
            
            // show modal
            await interaction.showModal(modal);
          } catch (error) {
            console.error('error preparing answers modal:', error);
            await interaction.reply({ 
              content: 'error loading answers for editing (╯°□°）╯︵ ┻━┻', 
              ephemeral: true 
            });
          }
        }
      } catch (error) {
        console.error('error handling button interaction:', error);
        await interaction.reply({ 
          content: 'error processing button (╯°□°）╯︵ ┻━┻', 
          ephemeral: true 
        });
      }
    } else if (interaction.isModalSubmit()) {
      try {
        // handle edit answers modal submit
        if (interaction.customId.startsWith('edit_answers_modal_')) {
          const mediaId = parseInt(interaction.customId.split('_').pop() || '0');
          if (!mediaId) {
            await interaction.reply({ content: 'invalid modal id ಠ_ಠ', ephemeral: true });
            return;
          }
          
          await interaction.deferReply({ ephemeral: true });
          const db = DatabaseManager.getInstance();
          
          try {
            // get current answers to compare
            const currentAnswers = await db.getMediaAnswers(mediaId);
            
            // get answers from the textarea - split by newlines
            const answersText = interaction.fields.getTextInputValue('answers');
            const answers = answersText.split('\n')
              .map(line => line.trim())
              .filter(line => line.length > 0); // filter empty lines
              
            if (answers.length === 0) {
              await interaction.editReply({
                content: 'no answers provided! need at least one ヽ(｀⌒´)ﾉ',
              });
              return;
            }
            
            // first line is primary, rest are alternatives
            const primaryAnswer = answers[0];
            const altAnswers = answers.slice(1);
            
            // handle primary answer
            const currentPrimary = currentAnswers.find(a => a.is_primary);
            if (!currentPrimary) {
              // no primary exists, add new one
              await db.addPrimaryAnswer(mediaId, primaryAnswer);
            } else if (currentPrimary.answer.toLowerCase() !== primaryAnswer.toLowerCase()) {
              // primary changed - delete old and add new
              await db.deleteMediaAnswer(currentPrimary.id);
              await db.addPrimaryAnswer(mediaId, primaryAnswer);
            }
            
            // handle alternative answers
            const currentAlts = currentAnswers.filter(a => !a.is_primary);
            
            // delete answers that aren't in the new list
            for (const currentAlt of currentAlts) {
              if (!altAnswers.some(a => a.toLowerCase() === currentAlt.answer.toLowerCase())) {
                await db.deleteMediaAnswer(currentAlt.id);
              }
            }
            
            // add new answers
            for (const altAnswer of altAnswers) {
              if (!currentAlts.some(a => a.answer.toLowerCase() === altAnswer.toLowerCase())) {
                await db.addAlternativeAnswer(mediaId, altAnswer);
              }
            }
            
            await interaction.editReply({ 
              content: `updated answers for media #${mediaId} (￣ー￣)ｂ`, 
            });
          } catch (error) {
            console.error('error processing answers update:', error);
            await interaction.editReply({ 
              content: 'error updating answers (╯°□°）╯︵ ┻━┻', 
            });
          }
        }
      } catch (error) {
        console.error('error handling modal submit:', error);
        if (!interaction.replied) {
          await interaction.reply({ 
            content: 'error processing your input (╯°□°）╯︵ ┻━┻', 
            ephemeral: true 
          });
        }
      }
    }
  });

  // login
  await client.login(process.env.DISCORD_TOKEN);
  console.log('bot is online! (￣ー￣)ｂ');
}

main().catch(error => {
  console.error('unhandled error:', error);
  process.exit(1);
});