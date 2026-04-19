# Use a latest Node.js image
FROM node:18-slim

# Set working directory
WORKDIR /app

# Install system dependencies if needed (e.g., for sqlite or native builds)
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm install

# Copy the rest of the application
COPY . .

# Build the frontend (Vite)
RUN npm run build

# Expose the application ports
# 3000: Web UI
# 8081: Proxy Interceptor
EXPOSE 3000
EXPOSE 8081

# Set production environment
ENV NODE_ENV=production

# Start the server
CMD ["npm", "run", "start"]
