# Production Dockerfile for Coast Battle — multi-stage (build the client, then a lean runtime).

# ---- build stage: install ALL deps and produce dist/ ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json tsconfig*.json ./
# full install incl. devDependencies (vite/typescript/@vitejs/plugin-react needed for the build)
RUN npm ci
COPY shared/ ./shared/
COPY client/ ./client/
RUN npm run build   # -> /app/dist

# ---- runtime stage: prod deps only (tsx is a runtime dep -> survives --omit=dev) ----
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json tsconfig*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY shared/ ./shared/
COPY server/ ./server/
COPY --from=build /app/dist ./dist
# Render injects PORT; default to 8787 locally. The server reads process.env.PORT.
ENV PORT=8787
EXPOSE 8787
# server runs uncompiled via tsx; serves dist/ + WebSockets on /ws on a single port
CMD ["npm", "start"]
