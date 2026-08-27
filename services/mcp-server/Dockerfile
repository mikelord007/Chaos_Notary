FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM gaiaadm/pumba:0.10.5 AS pumba

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=pumba /pumba /usr/local/bin/pumba
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 3100
CMD ["node", "dist/server.js"]
