FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts || true
COPY . .
RUN npx tsc --noEmit || true

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production SHOWIT_RELAY_PORT=8888 SHOWIT_RELAY_HOST=0.0.0.0
COPY package.json ./
COPY src ./src
COPY public ./public
RUN npm install tsx ws@^8.18.3 --omit=dev --ignore-scripts && npm cache clean --force
EXPOSE 8888
USER node
CMD ["npx", "tsx", "src/main.ts"]
