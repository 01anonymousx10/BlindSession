# Use official lightweight Node.js LTS Alpine image
FROM node:20-alpine

# Set working directory inside container
WORKDIR /app

# Install build dependencies for native packages if needed
RUN apk add --no-cache python3 make g++

# Copy package descriptors
COPY package*.json ./

# Install production dependencies
RUN npm ci --only=production

# Copy application source code
COPY src/ ./src/
COPY config/ ./config/
COPY public/ ./public/

# Expose server port
EXPOSE 3000

# Set environment
ENV NODE_ENV=production
ENV PORT=3000

# Start server
CMD ["node", "src/server.js"]
