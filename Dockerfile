FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN mkdir -p files && chown -R node:node /app

USER node

EXPOSE 13000

CMD ["npm", "start"]
