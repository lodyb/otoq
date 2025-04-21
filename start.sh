#!/bin/bash

# check if .env exists
if [ ! -f .env ]; then
  echo "no .env file found! copying example..."
  cp .env.example .env
  echo "please edit .env with your discord token and client id"
  exit 1
fi

# make media dir if it doesn't exist
mkdir -p src/media

# check if source files are newer than built files
REBUILD=0
if [ ! -d dist ]; then
  REBUILD=1
else
  for SRC_FILE in $(find src -name "*.ts" -type f); do
    DIST_FILE=${SRC_FILE/src/dist}
    DIST_FILE=${DIST_FILE/.ts/.js}
    if [ ! -f "$DIST_FILE" ] || [ "$SRC_FILE" -nt "$DIST_FILE" ]; then
      REBUILD=1
      break
    fi
  done
fi

# rebuild if needed
if [ $REBUILD -eq 1 ]; then
  echo "rebuilding project..."
  npm run build
fi

# start the bot
echo "starting otoq bot..."
node dist/index.js