import { REST, Routes } from 'discord.js'
import dotenv from 'dotenv'

dotenv.config()

// annoying legacy command deleter script
async function nuke() {
  if (!process.env.DISCORD_TOKEN || !process.env.DISCORD_CLIENT_ID) {
    console.error('no token or client id baka (≖_≖ )')
    process.exit(1)
  }

  const rest = new REST().setToken(process.env.DISCORD_TOKEN)
  // hardcode the guild id we know we need to nuke
  const guildId = '173778707331153920'
  
  try {
    console.log('nuking guild commands...')
    
    await rest.put(
      Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, guildId),
      { body: [] }
    )
    
    console.log('all guild commands deleted for guild ' + guildId + ' (╯°□°）╯︵ ┻━┻')
    console.log('dont worry your global commands are still there')
  } catch (error) {
    console.error('something broke:', error)
  }
}

nuke()