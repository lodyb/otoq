# otoq - discord audio quiz bot

audio quiz bot for discord servers! listen to clips and guess what they are.

## features

- start game with `/otoq` (options for rounds, tags, years)
- vote to skip with `/otoqskip`
- upload new media with `/otoqupload`
- scores and leaderboards
- filtering by tags and years

## setup

1. install dependencies
```
npm install
```

2. copy `.env.example` to `.env` and update with your token and client id:
```
cp .env.example .env
```

3. edit `.env` with your discord bot token and client id

4. build the project
```
npm run build
```

5. start the bot
```
npm start
```

optional for dev:
```
npm run dev
```

## usage

1. invite bot to server with needed permissions
   - required permissions: bot, applications.commands, connect, speak, message history
   - generate url in discord developer portal with those permissions

2. start a game with `/otoq`
   - must be in a voice channel
   - bot will join and play audio
   - type answers in chat

3. upload media with `/otoqupload`
   - attach audio file
   - fill in metadata form

## deployment

for persistent deployment:

1. install pm2
```
npm install -g pm2
```

2. start with pm2
```
pm2 start dist/index.js --name otoq
```

3. make it start on boot
```
pm2 startup
pm2 save
```