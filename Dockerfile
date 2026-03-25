FROM node:20-bookworm-slim

WORKDIR /app/Project

COPY Project/package.json Project/package-lock.json ./

# The checked-in lockfile is not guaranteed to be in sync with package.json.
# Use npm install so ACR build can resolve the current dependency set.
RUN npm install

COPY Project/ ./

ENV HOST=0.0.0.0
ENV port=8080
ENV NODE_ENV=development

EXPOSE 8080

CMD ["npm", "start"]
