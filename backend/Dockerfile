# syntax=docker/dockerfile:1
FROM node:22-alpine

WORKDIR /app

COPY package.json yarn.lock* ./
RUN yarn install --production --frozen-lockfile || yarn install --production

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["yarn", "start"]
