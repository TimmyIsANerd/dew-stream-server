# Build a lightweight Node runtime for dew-streaming-service
FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY src ./src
COPY .env.example ./.env.example

ENV NODE_ENV=production

EXPOSE 8787
CMD ["node", "src/index.js"]